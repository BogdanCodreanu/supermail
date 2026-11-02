import { randomUUID } from 'node:crypto';
import type { ActionResult, ThreadId } from '@supermail/shared';
import type { DB } from '../db/index.js';
import { HttpError } from '../errors.js';
import type { GmailApi } from '../google/gmailApi.js';
import type { AppDeps } from '../http/app.js';
import { ensureSnoozedLabel, snoozedLabelId, writeLabels } from '../labels/labelWriter.js';
import { reportSpam, restoreFromSpam, type SpamUndoPayload } from '../spam/spam.js';
import { reclassifyThreads } from '../threads/classifyThread.js';
import {
  actionResult, oppositeTable, overrideOf, setOverride, setSnooze, setTeachEntry, snapshotThread, teachEntry, type TeachEntry, type TeachUndoPayload, threadRow,
  threadsMatching, type ThreadRow, type ThreadSnapshot, withGmail,
} from './actions.js';
import { undoBulk, type BulkUndoPayload } from './bulk.js';

export const UNDO_TTL_MS = 5 * 60_000;
/** Expired undo rows are kept a while so a late undo gets 410 rather than 404, then pruned. */
const UNDO_KEEP_MS = 12 * UNDO_TTL_MS;

/** Which parts of the thread snapshot each action changed, and so which parts its undo puts back. */
const RESTORES: Record<string, (keyof ThreadSnapshot)[]> = {
  done: ['inInbox', 'doneAt', 'snooze'],
  restore: ['inInbox', 'doneAt', 'snooze'],
  snooze: ['inInbox', 'doneAt', 'snooze'],
  unsnooze: ['inInbox', 'doneAt', 'snooze'],
  read: ['unread'],
  move: ['override'],
};

/**
 * Records how to undo an action and returns the undo id. For thread actions the payload is the
 * `snapshotThread()` taken before the action; kind `restore` (Task 8) may also pass any payload, and then
 * undo just removes INBOX again.
 */
export function recordUndo(db: DB, threadId: ThreadId, kind: string, payload: unknown, now: number): string {
  const id = randomUUID();
  db.prepare('DELETE FROM undo WHERE created_at < ?').run(now - UNDO_KEEP_MS);
  db.prepare('INSERT INTO undo(id, thread_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)').run(id, threadId, kind, JSON.stringify(payload ?? null), now);
  return id;
}

function isSnapshot(p: unknown): p is ThreadSnapshot {
  return !!p && typeof p === 'object' && 'inInbox' in p;
}

/** True when putting a thread back takes it out of the inbox or marks it read, as the undo of an undo can. */
export function restoreHides(kind: string, snap: ThreadSnapshot): boolean {
  const fields = RESTORES[kind]!;
  return (fields.includes('inInbox') && !snap.inInbox) || (fields.includes('unread') && !snap.unread);
}

/** The Gmail half of putting a thread back. */
export async function restoreLabels(db: DB, gmail: GmailApi, t: ThreadRow, kind: string, snap: ThreadSnapshot, now: number): Promise<void> {
  const fields = RESTORES[kind]!;
  const add: string[] = [];
  const remove: string[] = [];
  if (fields.includes('inInbox')) (snap.inInbox ? add : remove).push('INBOX');
  if (fields.includes('unread')) (snap.unread ? add : remove).push('UNREAD');
  if (fields.includes('snooze')) {
    if (snap.snooze) add.push(await ensureSnoozedLabel(db, gmail, t.account_id));
    else {
      const label = snoozedLabelId(db, t.account_id);
      if (label) remove.push(label);
    }
  }
  await writeLabels(db, gmail, t.id, add, remove, now);
}

/** The index half of putting a thread back. */
export function restoreIndex(db: DB, threadId: ThreadId, kind: string, snap: ThreadSnapshot): void {
  const fields = RESTORES[kind]!;
  db.transaction(() => {
    if (fields.includes('inInbox')) db.prepare('UPDATE threads SET in_inbox = ? WHERE id = ?').run(snap.inInbox ? 1 : 0, threadId);
    if (fields.includes('unread')) db.prepare('UPDATE threads SET unread = ? WHERE id = ?').run(snap.unread ? 1 : 0, threadId);
    if (fields.includes('doneAt')) db.prepare('UPDATE threads SET done_at = ? WHERE id = ?').run(snap.doneAt, threadId);
    // A restore ranks the thread first in the inbox; undoing it must put its old rank back too.
    if (kind === 'restore') db.prepare('UPDATE threads SET surfaced_at = ? WHERE id = ?').run(snap.surfacedAt ?? null, threadId);
    if (fields.includes('snooze')) setSnooze(db, threadId, snap.snooze);
    if (fields.includes('override')) setOverride(db, threadId, snap.override);
  })();
}

async function restoreThread(d: AppDeps, threadId: ThreadId, kind: string, snap: ThreadSnapshot): Promise<void> {
  const { db } = d;
  const t = threadRow(db, threadId);
  const now = d.now();
  await withGmail(d, t, (gmail) => restoreLabels(db, gmail, t, kind, snap, now));
  restoreIndex(db, threadId, kind, snap);
  if (RESTORES[kind]!.includes('override')) await reclassifyThreads(db, d.gmailFor, [threadId], now);
}

export const groupExists = (db: DB, id: string) => !!db.prepare('SELECT 1 FROM groups WHERE id = ?').get(id);
const threadExists = (db: DB, id: ThreadId) => !!db.prepare('SELECT 1 FROM threads WHERE id = ?').get(id);

/** Puts a teaching back as it was, or as close as it can: a group or a thread deleted since stays gone. */
export async function restoreTeach(d: AppDeps, threadId: ThreadId, p: TeachUndoPayload): Promise<{ redo: TeachUndoPayload; affected: number }> {
  const { db } = d;
  const opposite = oppositeTable(p.table);
  const overrides = p.overrides.filter((o) => threadExists(db, o.threadId));
  const redo: TeachUndoPayload = {
    ...p, entry: teachEntry(db, p.table, p.matchType, p.matchValue), opposite: teachEntry(db, opposite, p.matchType, p.matchValue),
    overrides: overrides.map((o) => ({ threadId: o.threadId, override: overrideOf(db, o.threadId) })),
  };
  const usable = (table: typeof p.table, e: TeachEntry | null) => (e && table === 'rules' && !groupExists(db, e.value) ? null : e);
  db.transaction(() => {
    setTeachEntry(db, p.table, p.matchType, p.matchValue, usable(p.table, p.entry));
    setTeachEntry(db, opposite, p.matchType, p.matchValue, usable(opposite, p.opposite));
    for (const o of overrides) setOverride(db, o.threadId, o.override && groupExists(db, o.override.groupId) ? o.override : null);
  })();
  const matching = [threadId, ...overrides.map((o) => o.threadId), ...threadsMatching(db, p.matchType, p.matchValue)];
  const affected = await reclassifyThreads(db, d.gmailFor, matching, d.now(), { labels: 'background' });
  return { redo, affected };
}

/**
 * Undoes an action recorded with `recordUndo` (done, snooze, unsnooze, move, read, teach, restore, spam, unspam, bulk).
 * Each undo id works once; after UNDO_TTL_MS it is refused with 410. The result carries a fresh undo id that
 * redoes it. `spam` undoes a report, whose thread has no index row; `unspam` undoes getting a thread out of spam.
 */
export async function undo(d: AppDeps, undoId: string): Promise<ActionResult> {
  const { db } = d;
  const row = db.prepare('SELECT thread_id, kind, payload_json, created_at FROM undo WHERE id = ?').get(undoId) as
    { thread_id: string; kind: string; payload_json: string; created_at: number } | undefined;
  if (!row) throw new HttpError(404, 'Nothing to undo');
  const now = d.now();
  if (now - row.created_at > UNDO_TTL_MS) throw new HttpError(410, 'Too late to undo');
  const payload = JSON.parse(row.payload_json) as unknown;
  const threadId = row.thread_id;
  if (row.kind === 'bulk') {
    const result = await undoBulk(d, payload as BulkUndoPayload);
    db.prepare('DELETE FROM undo WHERE id = ?').run(undoId); // only now: an undo that fails halfway can be tried again
    return result;
  }
  db.prepare('DELETE FROM undo WHERE id = ?').run(undoId);

  if (row.kind === 'teach') {
    threadRow(db, threadId);
    const { redo, affected } = await restoreTeach(d, threadId, payload as TeachUndoPayload);
    return actionResult(db, threadId, recordUndo(db, threadId, 'teach', redo, now), affected);
  }
  if (row.kind === 'spam') {
    await restoreFromSpam(d, threadId, payload as SpamUndoPayload);
    return actionResult(db, threadId, recordUndo(db, threadId, 'unspam', null, now));
  }
  if (row.kind === 'unspam') return reportSpam(d, threadId);
  if (!(row.kind in RESTORES)) throw new HttpError(400, `Cannot undo ${row.kind}`);
  const redo = snapshotThread(db, threadId);
  if (isSnapshot(payload)) {
    await restoreThread(d, threadId, row.kind, payload);
  } else if (row.kind === 'restore') {
    const t = threadRow(db, threadId);
    await withGmail(d, t, (gmail) => writeLabels(db, gmail, threadId, [], ['INBOX'], now));
  } else {
    throw new HttpError(400, `Cannot undo ${row.kind}`);
  }
  return actionResult(db, threadId, recordUndo(db, threadId, row.kind, redo, now));
}
