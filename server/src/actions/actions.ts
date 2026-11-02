import { randomUUID } from 'node:crypto';
import type { ActionResult, MatchType, TeachRequest, ThreadId } from '@supermail/shared';
import { matchKeys } from '../classify/heuristics.js';
import type { DB } from '../db/index.js';
import { HttpError } from '../errors.js';
import { bus } from '../events.js';
import { GmailAuthRevoked, type GmailApi } from '../google/gmailApi.js';
import type { AppDeps } from '../http/app.js';
import { ensureSnoozedLabel, snoozedLabelId, writeLabels } from '../labels/labelWriter.js';
import { isNotFound, updateAccountStatus } from '../sync/initialSync.js';
import { removeThread } from '../sync/indexer.js';
import { classifyInput, publishGroups, publishThread, reclassifyThreads } from '../threads/classifyThread.js';
import { toSummary } from '../threads/queries.js';
import { recordUndo } from './undo.js';

/** The minimum lead time for a snooze. */
export const MIN_SNOOZE_MS = 60_000;
export const TEACH_ACTIONS = ['important', 'not_important', 'always_group'];
const MATCH_TYPES: MatchType[] = ['sender', 'domain', 'list'];

export interface ThreadRow { id: string; account_id: string; gmail_thread_id: string }

export function threadRow(db: DB, threadId: ThreadId): ThreadRow {
  const t = db.prepare('SELECT id, account_id, gmail_thread_id FROM threads WHERE id = ?').get(threadId) as ThreadRow | undefined;
  if (!t) throw new HttpError(404, `thread ${threadId} not found`);
  return t;
}

/** A revoked or undecryptable token: the account needs the owner to reconnect it. */
export function needsReconnect(err: unknown): boolean {
  return err instanceof GmailAuthRevoked || (err instanceof Error && (err.name === 'GmailAuthRevoked' || err.name === 'TokenDecryptError'));
}

/**
 * Runs a Gmail call for a thread's account and turns its failures into HTTP errors: a revoked grant flips the
 * account to reconnect_needed (409), and a thread Gmail no longer has is dropped from the index (404).
 */
export async function withGmail<T>(d: AppDeps, t: ThreadRow, fn: (gmail: GmailApi) => Promise<T>): Promise<T> {
  try {
    return await fn(d.gmailFor(t.account_id));
  } catch (err) {
    if (needsReconnect(err)) {
      updateAccountStatus(d.db, t.account_id, 'reconnect_needed');
      throw new HttpError(409, 'This Gmail account needs to be reconnected');
    }
    if (isNotFound(err)) {
      removeThread(d.db, t.account_id, t.gmail_thread_id);
      bus.publish({ type: 'thread.removed', id: t.id });
      throw new HttpError(404, 'This thread no longer exists in Gmail');
    }
    throw err;
  }
}

export interface OverrideSnapshot { groupId: string; source: 'app' | 'gmail'; createdAt: number; suggestRule: boolean }
/** The thread state an action can change, recorded so undo can put it back. */
export interface ThreadSnapshot { inInbox: boolean; unread: boolean; doneAt: number | null; surfacedAt?: number | null; snooze: { until: number; createdAt: number } | null; override: OverrideSnapshot | null }

export function overrideOf(db: DB, threadId: ThreadId): OverrideSnapshot | null {
  const o = db.prepare('SELECT group_id, source, created_at, suggest_rule FROM overrides WHERE thread_id = ?').get(threadId) as
    { group_id: string; source: 'app' | 'gmail'; created_at: number; suggest_rule: number } | undefined;
  return o ? { groupId: o.group_id, source: o.source, createdAt: o.created_at, suggestRule: o.suggest_rule === 1 } : null;
}

export function setOverride(db: DB, threadId: ThreadId, o: OverrideSnapshot | null): void {
  if (!o) {
    db.prepare('DELETE FROM overrides WHERE thread_id = ?').run(threadId);
    return;
  }
  db.prepare(
    `INSERT INTO overrides(thread_id, group_id, source, created_at, suggest_rule) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET group_id = excluded.group_id, source = excluded.source, created_at = excluded.created_at, suggest_rule = excluded.suggest_rule`,
  ).run(threadId, o.groupId, o.source, o.createdAt, o.suggestRule ? 1 : 0);
}

export function snapshotThread(db: DB, threadId: ThreadId): ThreadSnapshot {
  const t = db.prepare('SELECT in_inbox, unread, done_at, surfaced_at FROM threads WHERE id = ?').get(threadId) as
    { in_inbox: number; unread: number; done_at: number | null; surfaced_at: number | null } | undefined;
  if (!t) throw new HttpError(404, `thread ${threadId} not found`);
  const s = db.prepare('SELECT until, created_at FROM snoozes WHERE thread_id = ?').get(threadId) as { until: number; created_at: number } | undefined;
  return { inInbox: t.in_inbox === 1, unread: t.unread === 1, doneAt: t.done_at, surfacedAt: t.surfaced_at, snooze: s ? { until: s.until, createdAt: s.created_at } : null, override: overrideOf(db, threadId) };
}

export function setSnooze(db: DB, threadId: ThreadId, s: { until: number; createdAt: number } | null): void {
  if (!s) {
    db.prepare('DELETE FROM snoozes WHERE thread_id = ?').run(threadId);
    return;
  }
  db.prepare('INSERT INTO snoozes(thread_id, until, created_at) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET until = excluded.until, created_at = excluded.created_at').run(threadId, s.until, s.createdAt);
}

/** Publishes the thread and group counts and builds the ActionResult. */
export function actionResult(db: DB, threadId: ThreadId, undoId: string, affected?: number): ActionResult {
  publishThread(db, threadId);
  publishGroups(db);
  return { undoId, thread: toSummary(db, threadId), ...(affected === undefined ? {} : { affected }) };
}

// Each action in two halves, the Gmail labels and the index. A single action writes Gmail first and then the
// index; a bulk action (bulk.ts) does it the other way round, with a way back if Gmail refuses.

export function writeDone(db: DB, gmail: GmailApi, t: ThreadRow, now: number): Promise<boolean> {
  const snoozed = snoozedLabelId(db, t.account_id);
  return writeLabels(db, gmail, t.id, [], snoozed ? ['INBOX', snoozed] : ['INBOX'], now);
}

export function indexDone(db: DB, threadId: ThreadId, now: number): void {
  db.transaction(() => {
    setSnooze(db, threadId, null);
    db.prepare('UPDATE threads SET done_at = ?, in_inbox = 0 WHERE id = ?').run(now, threadId);
  })();
}

export async function writeSnooze(db: DB, gmail: GmailApi, t: ThreadRow, now: number): Promise<void> {
  const label = await ensureSnoozedLabel(db, gmail, t.account_id);
  await writeLabels(db, gmail, t.id, [label], ['INBOX'], now);
}

export function indexSnooze(db: DB, threadId: ThreadId, until: number, now: number): void {
  db.transaction(() => {
    setSnooze(db, threadId, { until, createdAt: now });
    db.prepare('UPDATE threads SET done_at = NULL, in_inbox = 0 WHERE id = ?').run(threadId);
  })();
}

export function writeRead(db: DB, gmail: GmailApi, threadId: ThreadId, read: boolean, now: number): Promise<boolean> {
  return read ? writeLabels(db, gmail, threadId, [], ['UNREAD'], now) : writeLabels(db, gmail, threadId, ['UNREAD'], [], now);
}

/** Done: removes INBOX (and the snooze label), cancels any snooze. A reply brings it back (indexer). */
export async function done(d: AppDeps, threadId: ThreadId): Promise<ActionResult> {
  const { db } = d;
  const t = threadRow(db, threadId);
  const before = snapshotThread(db, threadId);
  const now = d.now();
  // Gmail first, then the index: if Gmail fails nothing changes, and the snooze row is never lost.
  await withGmail(d, t, (gmail) => writeDone(db, gmail, t, now));
  indexDone(db, threadId, now);
  return actionResult(db, threadId, recordUndo(db, threadId, 'done', before, now));
}

export function assertSnoozeTime(until: unknown, now: number): asserts until is number {
  if (typeof until !== 'number' || !Number.isFinite(until) || until <= now + MIN_SNOOZE_MS) {
    throw new HttpError(400, 'Snooze time must be at least a minute in the future');
  }
}

/** Snooze: removes INBOX and adds SuperMail/Snoozed until `until`; the scheduler brings it back. */
export async function snooze(d: AppDeps, threadId: ThreadId, until: number): Promise<ActionResult> {
  const { db } = d;
  const now = d.now();
  assertSnoozeTime(until, now);
  const t = threadRow(db, threadId);
  const before = snapshotThread(db, threadId);
  await withGmail(d, t, (gmail) => writeSnooze(db, gmail, t, now));
  // The row is written after Gmail has the label, so the hook never sees a snooze row on an unsnoozed thread.
  indexSnooze(db, threadId, until, now);
  return actionResult(db, threadId, recordUndo(db, threadId, 'snooze', before, now));
}

/** Unsnooze now: back to the inbox, snooze label off, row gone. */
export async function unsnooze(d: AppDeps, threadId: ThreadId): Promise<ActionResult> {
  const { db } = d;
  const t = threadRow(db, threadId);
  const before = snapshotThread(db, threadId);
  const now = d.now();
  const snoozed = snoozedLabelId(db, t.account_id);
  await withGmail(d, t, (gmail) => writeLabels(db, gmail, threadId, ['INBOX'], snoozed ? [snoozed] : [], now));
  db.transaction(() => {
    setSnooze(db, threadId, null);
    db.prepare('UPDATE threads SET done_at = NULL WHERE id = ?').run(threadId);
  })();
  return actionResult(db, threadId, recordUndo(db, threadId, 'unsnooze', before, now));
}

export function assertGroup(db: DB, groupId: unknown): string {
  if (typeof groupId !== 'string' || !db.prepare('SELECT 1 FROM groups WHERE id = ?').get(groupId)) throw new HttpError(400, 'Unknown group');
  return groupId;
}

/** Moves one thread to a group: a one-off override from the app, relabelled in Gmail when in the inbox or snoozed. */
export async function moveToGroup(d: AppDeps, threadId: ThreadId, groupId: string): Promise<ActionResult> {
  const { db } = d;
  threadRow(db, threadId);
  assertGroup(db, groupId);
  const before = snapshotThread(db, threadId);
  const now = d.now();
  setOverride(db, threadId, { groupId, source: 'app', createdAt: now, suggestRule: false });
  const affected = await reclassifyThreads(db, d.gmailFor, [threadId], now);
  return actionResult(db, threadId, recordUndo(db, threadId, 'move', before, now), affected);
}

export async function setRead(d: AppDeps, threadId: ThreadId, read: boolean): Promise<ActionResult> {
  const { db } = d;
  const t = threadRow(db, threadId);
  const before = snapshotThread(db, threadId);
  const now = d.now();
  await withGmail(d, t, (gmail) => writeRead(db, gmail, threadId, read, now));
  return actionResult(db, threadId, recordUndo(db, threadId, 'read', before, now));
}

/** Every indexed thread whose sender, sender domain or mailing list is `value`. */
export function threadsMatching(db: DB, scope: MatchType, value: string): ThreadId[] {
  const v = value.toLowerCase();
  if (scope === 'sender') return db.prepare('SELECT id FROM threads WHERE lower(from_email) = ?').pluck().all(v) as string[];
  if (scope === 'domain') {
    const escaped = v.replace(/[\\%_]/g, (c) => `\\${c}`);
    return db.prepare("SELECT id FROM threads WHERE lower(from_email) LIKE ? ESCAPE '\\'").pluck().all(`%@${escaped}`) as string[];
  }
  return db.prepare('SELECT DISTINCT thread_id FROM messages WHERE lower(list_id) = ?').pluck().all(v) as string[];
}

export type TeachTable = 'rules' | 'sender_marks';
/** A rule (`value` = group id) or mark (`value` = 'important' | 'not_important'). */
export interface TeachEntry { value: string; createdAt: number }

export function teachEntry(db: DB, table: TeachTable, matchType: MatchType, matchValue: string): TeachEntry | null {
  const col = table === 'rules' ? 'group_id' : 'mark';
  const row = db.prepare(`SELECT ${col} AS value, created_at FROM ${table} WHERE match_type = ? AND match_value = ?`).get(matchType, matchValue) as { value: string; created_at: number } | undefined;
  return row ? { value: row.value, createdAt: row.created_at } : null;
}

export function setTeachEntry(db: DB, table: TeachTable, matchType: MatchType, matchValue: string, e: TeachEntry | null): void {
  if (!e) {
    db.prepare(`DELETE FROM ${table} WHERE match_type = ? AND match_value = ?`).run(matchType, matchValue);
    return;
  }
  const col = table === 'rules' ? 'group_id' : 'mark';
  db.prepare(
    `INSERT INTO ${table}(id, match_type, match_value, ${col}, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(match_type, match_value) DO UPDATE SET ${col} = excluded.${col}, created_at = excluded.created_at`,
  ).run(randomUUID(), matchType, matchValue, e.value, e.createdAt);
}

export const oppositeTable = (table: TeachTable): TeachTable => (table === 'rules' ? 'sender_marks' : 'rules');

export interface ThreadOverride { threadId: ThreadId; override: OverrideSnapshot | null }

export interface TeachUndoPayload {
  table: TeachTable;
  matchType: MatchType;
  matchValue: string;
  entry: TeachEntry | null;
  /** The opposite kind on the same match (the mark a rule replaced, or the rule a mark replaced). */
  opposite: TeachEntry | null;
  /** The one-off overrides the teaching cleared. */
  overrides: ThreadOverride[];
}

/**
 * Teaching: `always_group` upserts a rule, `important` / `not_important` upsert a mark, on the thread's sender,
 * domain or list. The latest teaching wins: it replaces the opposite kind on the same match, and every matching
 * thread follows it, so their one-off overrides are dropped. The screen changes at once (every indexed thread
 * from it is regrouped and published); Gmail follows in the background, for those in the inbox or snoozed.
 */
export async function teach(d: AppDeps, r: TeachRequest): Promise<ActionResult> {
  const { db } = d;
  if (!TEACH_ACTIONS.includes(r.action)) throw new HttpError(400, 'Unknown teach action');
  if (!MATCH_TYPES.includes(r.scope)) throw new HttpError(400, 'Unknown teach scope');
  threadRow(db, r.threadId);
  const input = classifyInput(db, r.threadId);
  const matchValue = input ? matchKeys(input)[r.scope] : null;
  if (!matchValue) throw new HttpError(400, `This thread has no ${r.scope} to teach on`);
  const table: TeachTable = r.action === 'always_group' ? 'rules' : 'sender_marks';
  const value = r.action === 'always_group' ? assertGroup(db, r.groupId) : r.action;
  const now = d.now();

  const opposite = oppositeTable(table);
  const matching = [r.threadId, ...threadsMatching(db, r.scope, matchValue)];
  const undoPayload: TeachUndoPayload = {
    table, matchType: r.scope, matchValue, entry: teachEntry(db, table, r.scope, matchValue), opposite: teachEntry(db, opposite, r.scope, matchValue),
    overrides: matching.map((threadId) => ({ threadId, override: overrideOf(db, threadId) })).filter((o) => o.override),
  };
  db.transaction(() => {
    setTeachEntry(db, table, r.scope, matchValue, { value, createdAt: now });
    setTeachEntry(db, opposite, r.scope, matchValue, null);
    for (const o of undoPayload.overrides) setOverride(db, o.threadId, null);
  })();
  const affected = await reclassifyThreads(db, d.gmailFor, matching, now, { labels: 'background' });
  return actionResult(db, r.threadId, recordUndo(db, r.threadId, 'teach', undoPayload, now), affected);
}
