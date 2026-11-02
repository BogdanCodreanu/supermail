import type { ThreadId } from '@supermail/shared';
import type { GroupRef } from '../classify/resolve.js';
import type { DB } from '../db/index.js';
import { GmailAuthRevoked, GmailLabelExists, type GmailApi, GmailNoAnswer } from '../google/gmailApi.js';

export const SNOOZED_LABEL = 'SuperMail/Snoozed';
const LABEL_PREFIX = 'SuperMail/';
/** A label change we wrote within this window is ours, not the owner's (two-way sync). */
const OWN_WRITE_WINDOW_MS = 120_000;

/** A group with what label writing needs on top of the classifier's GroupRef. */
export interface GroupInfo extends GroupRef { existingLabelName: string | null; position: number }

interface GroupRow { id: string; name: string; position: number; kind: GroupRef['kind']; builtin_key: string | null; existing_label_name: string | null }
interface ThreadRow { account_id: string; gmail_thread_id: string; group_id: string | null; in_inbox: number; snoozed: number }

/** Every group in display order, with the Gmail label id it has in each account (from `group_labels`). */
export function loadGroups(db: DB): GroupInfo[] {
  const rows = db.prepare('SELECT id, name, position, kind, builtin_key, existing_label_name FROM groups ORDER BY position, name').all() as GroupRow[];
  const labels = db.prepare('SELECT group_id, account_id, gmail_label_id FROM group_labels').all() as { group_id: string; account_id: string; gmail_label_id: string }[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    position: r.position,
    kind: r.kind,
    builtinKey: r.builtin_key,
    existingLabelName: r.existing_label_name,
    labelIdsByAccount: new Map(labels.filter((l) => l.group_id === r.id).map((l) => [l.account_id, l.gmail_label_id])),
  }));
}

/** The Gmail label a group is shown as: `SuperMail/<name>`, the owner's existing label in place, or none for Unsorted. */
export function groupLabelName(g: GroupRef & { existingLabelName?: string | null }): string | null {
  if (g.builtinKey === 'unsorted') return null;
  if (g.kind === 'existing_label') return g.existingLabelName ?? g.name;
  return `${LABEL_PREFIX}${g.name}`;
}

/** True when a group's label is one SuperMail owns (and may add or remove), rather than the owner's own label. */
export function isSuperMailGroup(g: GroupRef): boolean {
  return g.kind !== 'existing_label' && g.builtinKey !== 'unsorted';
}

async function findLabel(gmail: GmailApi, name: string): Promise<string | undefined> {
  const lower = name.toLowerCase();
  return (await gmail.listLabels()).find((l) => l.name.toLowerCase() === lower)?.id;
}

async function createOrReuse(gmail: GmailApi, name: string): Promise<string> {
  try {
    return (await gmail.createLabel(name)).id;
  } catch (err) {
    if (!(err instanceof GmailLabelExists)) throw err;
    const id = await findLabel(gmail, name);
    if (!id) throw err;
    return id;
  }
}

// Concurrent writes for many threads of one group must not race to create the same label.
const pending = new WeakMap<DB, Map<string, Promise<string | null>>>();
function once(db: DB, key: string, fn: () => Promise<string | null>): Promise<string | null> {
  let map = pending.get(db);
  if (!map) pending.set(db, (map = new Map()));
  const inFlight = map.get(key);
  if (inFlight) return inFlight;
  const p = fn().finally(() => map.delete(key));
  map.set(key, p);
  return p;
}

/**
 * The group's Gmail label id in this account, cached in `group_labels`. Creates `SuperMail/<name>` when
 * missing (reusing it on GmailLabelExists). An existing-label group looks its label up by name first and
 * never renames it; it is only created in an account that lacks it when that account's mail is routed there.
 */
export async function ensureLabel(db: DB, gmail: GmailApi, accountId: string, groupId: string): Promise<string | null> {
  const cached = db.prepare('SELECT gmail_label_id FROM group_labels WHERE group_id = ? AND account_id = ?').pluck().get(groupId, accountId) as string | undefined;
  if (cached) return cached;
  const group = loadGroups(db).find((g) => g.id === groupId);
  const name = group && groupLabelName(group);
  if (!name) return null;
  return once(db, `group:${accountId}:${groupId}`, async () => {
    const id = (group.kind === 'existing_label' && (await findLabel(gmail, name))) || (await createOrReuse(gmail, name));
    db.prepare('INSERT INTO group_labels(group_id, account_id, gmail_label_id) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET gmail_label_id = excluded.gmail_label_id').run(groupId, accountId, id);
    return id;
  });
}

/** Maps an existing-label group to the owner's label in this account when it exists there. Never creates it. */
export async function mapExistingLabel(db: DB, gmail: GmailApi, accountId: string, groupId: string): Promise<string | null> {
  const group = loadGroups(db).find((g) => g.id === groupId);
  if (!group || group.kind !== 'existing_label') return null;
  const cached = group.labelIdsByAccount.get(accountId);
  if (cached) return cached;
  const id = await findLabel(gmail, groupLabelName(group)!);
  if (!id) return null;
  db.prepare('INSERT INTO group_labels(group_id, account_id, gmail_label_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(groupId, accountId, id);
  return id;
}

const snoozedKey = (accountId: string) => `label:snoozed:${accountId}`;

/** The cached id of `SuperMail/Snoozed` in this account, if we have created or found it. */
export function snoozedLabelId(db: DB, accountId: string): string | null {
  return (db.prepare('SELECT value FROM kv WHERE key = ?').pluck().get(snoozedKey(accountId)) as string | undefined) ?? null;
}

export async function ensureSnoozedLabel(db: DB, gmail: GmailApi, accountId: string): Promise<string> {
  const cached = snoozedLabelId(db, accountId);
  if (cached) return cached;
  const id = await once(db, `snoozed:${accountId}`, async () => {
    const created = await createOrReuse(gmail, SNOOZED_LABEL);
    db.prepare('INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT DO UPDATE SET value = excluded.value').run(snoozedKey(accountId), created);
    return created;
  });
  return id!;
}

/** Union of the thread's label ids, from the index. */
export function threadLabelIds(db: DB, threadId: ThreadId): Set<string> {
  const rows = db.prepare('SELECT label_ids_json FROM messages WHERE thread_id = ?').pluck().all(threadId) as string[];
  return new Set(rows.flatMap((r) => JSON.parse(r) as string[]));
}

export function recordLabelWrite(db: DB, accountId: string, gmailThreadId: string, added: string[], removed: string[], at: number): void {
  db.prepare('INSERT INTO label_writes(account_id, gmail_thread_id, added_json, removed_json, at) VALUES (?, ?, ?, ?, ?)').run(
    accountId, gmailThreadId, JSON.stringify(added), JSON.stringify(removed), at,
  );
}

/** True when we added or removed this label on this thread within the last 120 s. */
export function wasWrittenByUs(db: DB, accountId: string, gmailThreadId: string, labelId: string, now: number): boolean {
  const rows = db.prepare('SELECT added_json, removed_json FROM label_writes WHERE account_id = ? AND gmail_thread_id = ? AND at >= ?').all(accountId, gmailThreadId, now - OWN_WRITE_WINDOW_MS) as
    { added_json: string; removed_json: string }[];
  return rows.some((r) => (JSON.parse(r.added_json) as string[]).includes(labelId) || (JSON.parse(r.removed_json) as string[]).includes(labelId));
}

/**
 * Our most recent write of this label on this thread at or after `since`: 'added', 'removed', or null when we
 * never touched it. Used to tell a label we put there from one the owner added in the Gmail app.
 */
export function lastWriteOf(db: DB, accountId: string, gmailThreadId: string, labelId: string, since = 0): 'added' | 'removed' | null {
  const rows = db.prepare('SELECT added_json, removed_json FROM label_writes WHERE account_id = ? AND gmail_thread_id = ? AND at >= ? ORDER BY id DESC').all(accountId, gmailThreadId, since) as
    { added_json: string; removed_json: string }[];
  for (const r of rows) {
    if ((JSON.parse(r.added_json) as string[]).includes(labelId)) return 'added';
    if ((JSON.parse(r.removed_json) as string[]).includes(labelId)) return 'removed';
  }
  return null;
}

/** Mirrors a label change into the index, so in_inbox/unread and later label diffs are right before the next poll. */
function applyLocally(db: DB, threadId: ThreadId, add: string[], remove: string[]): void {
  const rows = db.prepare('SELECT id, label_ids_json FROM messages WHERE thread_id = ?').all(threadId) as { id: string; label_ids_json: string }[];
  const update = db.prepare('UPDATE messages SET label_ids_json = ? WHERE id = ?');
  db.transaction(() => {
    for (const r of rows) {
      const labels = (JSON.parse(r.label_ids_json) as string[]).filter((l) => !remove.includes(l));
      for (const l of add) if (!labels.includes(l)) labels.push(l);
      update.run(JSON.stringify(labels), r.id);
    }
    const all = threadLabelIds(db, threadId);
    db.prepare('UPDATE threads SET in_inbox = ?, unread = ? WHERE id = ?').run(all.has('INBOX') ? 1 : 0, all.has('UNREAD') ? 1 : 0, threadId);
  })();
}

/**
 * After a failed write, drops cached ids of SuperMail's own labels that no longer exist in Gmail (the owner
 * deleted the label), so the next write finds or recreates it. Mappings to the owner's existing labels are kept.
 */
async function forgetDeletedLabels(db: DB, gmail: GmailApi, accountId: string, labelIds: string[]): Promise<void> {
  let existing: Set<string>;
  try {
    existing = new Set((await gmail.listLabels()).map((l) => l.id));
  } catch {
    return;
  }
  const ids = JSON.stringify(labelIds.filter((l) => !existing.has(l)));
  db.prepare(
    `DELETE FROM group_labels WHERE account_id = ? AND gmail_label_id IN (SELECT value FROM json_each(?))
       AND group_id IN (SELECT id FROM groups WHERE kind != 'existing_label')`,
  ).run(accountId, ids);
  db.prepare('DELETE FROM kv WHERE key = ? AND value IN (SELECT value FROM json_each(?))').run(snoozedKey(accountId), ids);
}

/**
 * A write Gmail never answered may have landed all the same, so one look at the thread settles it. New mail or a
 * failed look counts as not landed, and the thread stays visible: if in doubt, it was not done.
 */
async function landedAnyway(gmail: GmailApi, gmailThreadId: string, add: string[], remove: string[]): Promise<boolean> {
  try {
    const mail = ((await gmail.getThread(gmailThreadId, 'metadata')).messages ?? []).filter((m) => !m.labelIds?.includes('DRAFT'));
    return mail.length > 0 && mail.every((m) => add.every((l) => m.labelIds?.includes(l)) && !remove.some((l) => m.labelIds?.includes(l)));
  } catch {
    return false;
  }
}

/**
 * The one way SuperMail changes a thread's labels: calls Gmail, logs the write in `label_writes`, and mirrors
 * it into the index. Labels already in the wanted state are skipped; nothing to do means no API call.
 */
export async function writeLabels(db: DB, gmail: GmailApi, threadId: ThreadId, add: string[], remove: string[], now: number): Promise<boolean> {
  const t = db.prepare('SELECT account_id, gmail_thread_id FROM threads WHERE id = ?').get(threadId) as { account_id: string; gmail_thread_id: string } | undefined;
  if (!t) return false;
  const current = threadLabelIds(db, threadId);
  const toAdd = [...new Set(add)].filter((l) => !current.has(l));
  const toRemove = [...new Set(remove)].filter((l) => current.has(l) && !add.includes(l));
  if (toAdd.length === 0 && toRemove.length === 0) return false;
  try {
    await gmail.modifyThread(t.gmail_thread_id, toAdd, toRemove);
  } catch (err) {
    if (!(err instanceof GmailNoAnswer && (await landedAnyway(gmail, t.gmail_thread_id, toAdd, toRemove)))) {
      if (!(err instanceof GmailAuthRevoked)) await forgetDeletedLabels(db, gmail, t.account_id, [...toAdd, ...toRemove]);
      throw err;
    }
  }
  recordLabelWrite(db, t.account_id, t.gmail_thread_id, toAdd, toRemove, now);
  applyLocally(db, threadId, toAdd, toRemove);
  return true;
}

/** True when SuperMail writes labels for this thread: it is in the inbox, snoozed, or new mail. */
export function isLabelEligible(db: DB, threadId: ThreadId, isNew = false): boolean {
  const t = db.prepare('SELECT in_inbox, EXISTS(SELECT 1 FROM snoozes WHERE thread_id = threads.id) AS snoozed FROM threads WHERE id = ?').get(threadId) as
    Pick<ThreadRow, 'in_inbox' | 'snoozed'> | undefined;
  return !!t && (isNew || t.in_inbox === 1 || t.snoozed === 1);
}

export interface ApplyLabelOptions {
  /** true adds SNOOZED_LABEL, false removes it, undefined leaves it alone. true also makes the thread eligible. */
  snoozed?: boolean;
  /** The thread is new mail, so it gets labels even if a filter kept it out of the inbox. */
  isNew?: boolean;
  /** The owner picked this very thread in a bulk move, so it gets labels even if it is archived. */
  selected?: boolean;
  /** Extra label ids to remove, e.g. the old label of a renamed or deleted group. */
  alsoRemove?: string[];
  now?: number;
}

/**
 * Puts the thread's current group label on it in Gmail and removes every other SuperMail group label. Never
 * touches INBOX, and never the owner's own labels. Does nothing unless the thread is in the inbox, snoozed, new
 * or selected by the owner: archived history is never relabelled.
 */
export async function applyThreadLabels(db: DB, gmail: GmailApi, threadId: ThreadId, opts: ApplyLabelOptions = {}): Promise<void> {
  const t = db.prepare('SELECT account_id, gmail_thread_id, group_id FROM threads WHERE id = ?').get(threadId) as Pick<ThreadRow, 'account_id' | 'gmail_thread_id' | 'group_id'> | undefined;
  if (!t || !(opts.snoozed || opts.selected || isLabelEligible(db, threadId, opts.isNew))) return;
  const groupId = t.group_id ?? 'unsorted';
  const target = await ensureLabel(db, gmail, t.account_id, groupId);
  const others = loadGroups(db)
    .filter((g) => g.id !== groupId && isSuperMailGroup(g))
    .map((g) => g.labelIdsByAccount.get(t.account_id))
    .filter((l): l is string => !!l && l !== target);
  const add = target ? [target] : [];
  const remove = [...others, ...(opts.alsoRemove ?? [])];
  if (opts.snoozed === true) add.push(await ensureSnoozedLabel(db, gmail, t.account_id));
  if (opts.snoozed === false) {
    const snoozed = snoozedLabelId(db, t.account_id);
    if (snoozed) remove.push(snoozed);
  }
  await writeLabels(db, gmail, threadId, add, remove, opts.now ?? Date.now());
}
