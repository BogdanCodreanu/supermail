import type { ThreadId } from '@supermail/shared';
import type { ClassifyInput } from '../classify/heuristics.js';
import { type Mark, type Override, resolveGroup, type Rule } from '../classify/resolve.js';
import type { DB } from '../db/index.js';
import { bus } from '../events.js';
import type { GmailApi } from '../google/gmailApi.js';
import type { ThreadHook } from '../http/app.js';
import {
  applyThreadLabels, isLabelEligible, isSuperMailGroup, lastWriteOf, loadGroups, mapExistingLabel, recordLabelWrite, snoozedLabelId,
  threadLabelIds, wasWrittenByUs, writeLabels,
} from '../labels/labelWriter.js';
import { mapLimit } from '../sync/initialSync.js';
import { ownEmailsOf } from '../sync/indexer.js';
import { groupCounts, toSummary } from './queries.js';

export interface Log { error(obj: unknown, msg?: string): void; warn(obj: unknown, msg?: string): void }
export const consoleLog: Log = { error: (obj, msg) => console.error(msg ?? '', obj), warn: (obj, msg) => console.warn(msg ?? '', obj) };

export const LABEL_CONCURRENCY = 5;

interface MessageRow { from_email: string | null; list_id: string | null; label_ids_json: string; subject: string; snippet: string; has_list_unsubscribe: number }

/**
 * What the classifier sees for a thread: the latest message not sent by the owner (falling back to the latest),
 * plus any non-category label on the thread, so a label the owner put on the thread counts.
 */
export function classifyInput(db: DB, threadId: ThreadId): (ClassifyInput & { accountId: string }) | null {
  const t = db.prepare('SELECT account_id, subject FROM threads WHERE id = ?').get(threadId) as { account_id: string; subject: string } | undefined;
  if (!t) return null;
  const msgs = db.prepare('SELECT from_email, list_id, label_ids_json, subject, snippet, has_list_unsubscribe FROM messages WHERE thread_id = ? ORDER BY date DESC, rowid DESC').all(threadId) as MessageRow[];
  if (msgs.length === 0) return null;
  const own = ownEmailsOf(db);
  const labelsOf = (m: MessageRow) => JSON.parse(m.label_ids_json) as string[];
  const latest = msgs.find((m) => !own.has((m.from_email ?? '').toLowerCase()) && !labelsOf(m).includes('SENT')) ?? msgs[0]!;
  const threadLabels = msgs.flatMap(labelsOf).filter((l) => !l.startsWith('CATEGORY_'));
  return {
    accountId: t.account_id,
    fromEmail: latest.from_email,
    listId: latest.list_id,
    labelIds: [...new Set([...labelsOf(latest), ...threadLabels])],
    subject: latest.subject || t.subject,
    snippet: latest.snippet,
    hasListUnsubscribe: latest.has_list_unsubscribe === 1,
  };
}

function teaching(db: DB, threadId: ThreadId): { override?: Override; rules: Rule[]; marks: Mark[] } {
  const rules = (db.prepare('SELECT match_type, match_value, group_id, created_at FROM rules').all() as { match_type: Rule['matchType']; match_value: string; group_id: string; created_at: number }[])
    .map((r) => ({ matchType: r.match_type, matchValue: r.match_value, groupId: r.group_id, createdAt: r.created_at }));
  const marks = (db.prepare('SELECT match_type, match_value, mark, created_at FROM sender_marks').all() as { match_type: Mark['matchType']; match_value: string; mark: Mark['mark']; created_at: number }[])
    .map((m) => ({ matchType: m.match_type, matchValue: m.match_value, mark: m.mark, createdAt: m.created_at }));
  const o = db.prepare('SELECT group_id, source, created_at FROM overrides WHERE thread_id = ?').get(threadId) as { group_id: string; source: Override['source']; created_at: number } | undefined;
  return { override: o && { groupId: o.group_id, source: o.source, createdAt: o.created_at }, rules, marks };
}

export interface Classification { groupId: string; previousGroupId: string | null; changed: boolean; reasonChanged: boolean }

/** Recomputes the thread's group and reason and stores them. `changed` means the group itself changed. */
export function classifyThread(db: DB, threadId: ThreadId): Classification | null {
  const input = classifyInput(db, threadId);
  if (!input) return null;
  const prev = db.prepare('SELECT group_id, reason_text FROM threads WHERE id = ?').get(threadId) as { group_id: string | null; reason_text: string | null };
  const { groupId, reason } = resolveGroup(input, teaching(db, threadId), loadGroups(db));
  db.prepare('UPDATE threads SET group_id = ?, reason_source = ?, reason_text = ?, reason_at = ? WHERE id = ?').run(groupId, reason.source, reason.text, reason.at, threadId);
  return { groupId, previousGroupId: prev.group_id, changed: prev.group_id !== groupId, reasonChanged: prev.reason_text !== reason.text };
}

export function publishThread(db: DB, threadId: ThreadId): void {
  try {
    bus.publish({ type: 'thread.updated', thread: toSummary(db, threadId) });
  } catch {
    // Gone from the index in the meantime.
  }
}

// Many threads change at once during sync or teaching; group counts are sent once per turn of the event loop.
const groupsScheduled = new WeakSet<DB>();
export function publishGroups(db: DB): void {
  if (groupsScheduled.has(db)) return;
  groupsScheduled.add(db);
  setImmediate(() => {
    groupsScheduled.delete(db);
    try {
      bus.publish({ type: 'groups.updated', groups: groupCounts(db) });
    } catch {
      // Database closed.
    }
  });
}

const accountOf = (db: DB, threadId: ThreadId) => db.prepare('SELECT account_id FROM threads WHERE id = ?').pluck().get(threadId) as string | undefined;

interface LabelQueue { threads: Map<ThreadId, Promise<void>>; batches: Set<Promise<void>> }
const labelQueues = new WeakMap<DB, LabelQueue>();
function labelQueue(db: DB): LabelQueue {
  let queue = labelQueues.get(db);
  if (!queue) labelQueues.set(db, (queue = { threads: new Map(), batches: new Set() }));
  return queue;
}

/**
 * Runs a thread's Gmail label write after the ones before it, so the latest teaching wins: applyThreadLabels reads
 * the group and the labels when it starts, and two overlapping writes would leave the first one's label in Gmail.
 */
export function queueLabelWrite(db: DB, threadId: ThreadId, log: Log, write: () => Promise<void>): Promise<void> {
  const { threads } = labelQueue(db);
  const next = (threads.get(threadId) ?? Promise.resolve())
    .then(write)
    .catch((err: unknown) => log.error({ threadId, err }, 'writing Gmail labels failed'))
    .finally(() => {
      if (threads.get(threadId) === next) threads.delete(threadId);
    });
  threads.set(threadId, next);
  return next;
}

/** Counts a batch of writes running behind a response, so `labelWritesIdle` and a stopping server wait for it. */
export function trackLabelWrites(db: DB, writes: Promise<void>): void {
  const { batches } = labelQueue(db);
  batches.add(writes);
  void writes.finally(() => batches.delete(writes));
}

/** Resolves once every queued Gmail label write has finished, those of a background batch still waiting their turn too. */
export async function labelWritesIdle(db: DB): Promise<void> {
  const { threads, batches } = labelQueue(db);
  while (threads.size || batches.size) await Promise.all([...threads.values(), ...batches]);
}

export interface ReclassifyOptions {
  log?: Log;
  /** Extra label ids to take off in this account, e.g. those of a deleted group. */
  alsoRemove?: (accountId: string) => string[];
  /**
   * 'background' returns before Gmail is written, for the owner's teaching: the index and the screen change at
   * once. Code already running in the label queue must use it too, or it would wait for itself.
   */
  labels?: 'await' | 'background';
}

/**
 * Reclassifies threads after teaching or a group change, and relabels in Gmail only those whose group changed
 * and that are in the inbox or snoozed. Archived threads are regrouped in the index but their labels are left
 * alone. Label writes are best effort: a failure is logged and the index keeps the new group. With labels
 * 'background', every thread is published now, changed or not, since the client moved them all optimistically.
 * Returns the number of threads whose group changed.
 */
export async function reclassifyThreads(db: DB, gmailFor: (accountId: string) => GmailApi, threadIds: Iterable<ThreadId>, now: number, opts: ReclassifyOptions = {}): Promise<number> {
  const { log = consoleLog, alsoRemove } = opts;
  const background = opts.labels === 'background';
  const relabel: { id: ThreadId; accountId: string }[] = [];
  let any = false;
  let moved = 0;
  for (const id of new Set(threadIds)) {
    const c = classifyThread(db, id);
    if (!c) continue;
    const visible = c.changed || c.reasonChanged;
    if (visible) any = true;
    const accountId = accountOf(db, id);
    const write = !!accountId && c.changed && isLabelEligible(db, id);
    if (write) {
      moved++; // Inbox and snoozed only, the same emails the scope prompt counted.
      relabel.push({ id, accountId });
    }
    if (background || (visible && !write)) publishThread(db, id);
  }
  const writes = mapLimit(relabel, LABEL_CONCURRENCY, async ({ id, accountId }) => {
    await queueLabelWrite(db, id, log, () => applyThreadLabels(db, gmailFor(accountId), id, { now, alsoRemove: alsoRemove?.(accountId) }));
    if (!background) publishThread(db, id);
  });
  if (background) trackLabelWrites(db, writes);
  else await writes;
  if (any) publishGroups(db);
  return moved;
}

/**
 * Maps an existing-label group to the owner's label in each given account (never creating it) and moves the
 * threads that carry it into the group.
 */
export async function adoptExistingLabel(
  db: DB, gmailFor: (accountId: string) => GmailApi, groupId: string, accountIds: string[], now: number, log: Log = consoleLog, labels: ReclassifyOptions['labels'] = 'await',
): Promise<void> {
  const threads: ThreadId[] = [];
  for (const accountId of accountIds) {
    let labelId: string | null;
    try {
      labelId = await mapExistingLabel(db, gmailFor(accountId), accountId, groupId);
    } catch (err) {
      log.warn({ accountId, groupId, err }, 'could not read Gmail labels');
      continue;
    }
    if (!labelId) continue;
    threads.push(...(db.prepare(
      `SELECT DISTINCT m.thread_id FROM messages m, json_each(m.label_ids_json) l WHERE m.account_id = ? AND l.value = ?`,
    ).pluck().all(accountId, labelId) as string[]));
  }
  await reclassifyThreads(db, gmailFor, threads, now, { log, labels });
}

interface ThreadState { account_id: string; gmail_thread_id: string; group_id: string | null; in_inbox: number }
interface WritePlan { accountId: string; apply: boolean; isNew: boolean; removeSnoozed: boolean }

export type ThreadChangeHook = ThreadHook & { /** Resolves once every queued Gmail label write has finished. */ idle(): Promise<void> };

/**
 * The hook the poller calls for every new or changed thread. Synchronously: accepts the owner's Gmail-side
 * changes (a group label moved in the Gmail app becomes a one-off override; a snoozed thread put back in the
 * inbox or archived loses its snooze), then recomputes the group from the latest message not sent by the owner.
 * Then, queued per thread: writes the group label to Gmail, only for new mail and threads in the inbox or
 * snoozed, and never reverts a label the owner changed.
 */
export function makeThreadHook(deps: { db: DB; gmailFor: (id: string) => GmailApi; now: () => number; log?: Log }): ThreadChangeHook {
  const { db, gmailFor, now } = deps;
  const log = deps.log ?? consoleLog;
  const adopted = new Set<string>();

  function decide(threadId: ThreadId, reason: 'new' | 'changed'): WritePlan | null {
    const t = db.prepare('SELECT account_id, gmail_thread_id, group_id, in_inbox FROM threads WHERE id = ?').get(threadId) as ThreadState | undefined;
    if (!t) return null;
    const at = now();
    const labels = threadLabelIds(db, threadId);
    const snoozedId = snoozedLabelId(db, t.account_id);
    let visibleChange = false;

    // Review Focus 4: the owner put a snoozed thread back in the inbox, or archived it (removed the snooze
    // label), in Gmail. Drop the snooze so the scheduler neither re-archives nor resurrects it. INBOX counts
    // only on a Gmail state newer than the snooze: SuperMail/Snoozed is on it, or mail arrived after the
    // snooze. A fetch that started before the snooze and landed after it shows neither, so it is ignored.
    const snooze = db.prepare('SELECT created_at FROM snoozes WHERE thread_id = ?').get(threadId) as { created_at: number } | undefined;
    const snoozed = !!snooze;
    let stillSnoozed = snoozed;
    const hasSnoozedLabel = snoozedId !== null && labels.has(snoozedId);
    const afterSnooze = () => hasSnoozedLabel || (db.prepare('SELECT max(date) FROM messages WHERE thread_id = ?').pluck().get(threadId) as number) > snooze!.created_at;
    const backInInbox = snoozed && labels.has('INBOX') && afterSnooze();
    const labelRemoved = snoozed && snoozedId !== null && !hasSnoozedLabel && !labels.has('INBOX');
    if (backInInbox || labelRemoved) {
      db.prepare('DELETE FROM snoozes WHERE thread_id = ?').run(threadId);
      stillSnoozed = false;
      visibleChange = true;
    }

    // A move from the app that Gmail has not got yet, queued behind a bulk action or cut off by a restart: the old
    // group's label is still ours, not the owner's choice. The label goes on again below, so the move always lands.
    const groups = loadGroups(db);
    const override = db.prepare('SELECT group_id, source, created_at FROM overrides WHERE thread_id = ?').get(threadId) as { group_id: string; source: Override['source']; created_at: number } | undefined;
    const targetLabel = groups.find((g) => g.id === override?.group_id)?.labelIdsByAccount.get(t.account_id);
    const moveOwed = override?.source === 'app' && (
      !!db.prepare("SELECT 1 FROM pending_writes WHERE thread_id = ? AND op = 'move'").get(threadId) ||
      (!!targetLabel && !labels.has(targetLabel) && lastWriteOf(db, t.account_id, t.gmail_thread_id, targetLabel, override.created_at) !== 'added'));

    // Two-way: a SuperMail group label we did not put there means the owner moved the thread in Gmail.
    if (reason === 'changed' && t.group_id !== null && (t.in_inbox === 1 || stillSnoozed)) {
      const moved = groups.find((g) => {
        const labelId = g.labelIdsByAccount.get(t.account_id);
        if (g.id === t.group_id || !isSuperMailGroup(g) || !labelId || !labels.has(labelId)) return false;
        const ours = wasWrittenByUs(db, t.account_id, t.gmail_thread_id, labelId, at) || lastWriteOf(db, t.account_id, t.gmail_thread_id, labelId, override?.created_at ?? 0) === 'added';
        return !ours;
      });
      if (moved && !moveOwed && override?.group_id !== moved.id) {
        db.prepare(
          `INSERT INTO overrides(thread_id, group_id, source, created_at, suggest_rule) VALUES (?, ?, 'gmail', ?, 1)
           ON CONFLICT(thread_id) DO UPDATE SET group_id = excluded.group_id, source = 'gmail', created_at = excluded.created_at, suggest_rule = 1`,
        ).run(threadId, moved.id, at);
        // The accepted label now counts as written, so if the owner later removes it, it stays removed.
        recordLabelWrite(db, t.account_id, t.gmail_thread_id, [moved.labelIdsByAccount.get(t.account_id)!], [], at);
        visibleChange = true;
      }
    }

    // Review Focus 3: recompute the group (the indexer already cancelled Done and the snooze on a reply).
    const c = classifyThread(db, threadId);
    if (!c) return null;
    if (c.changed || c.reasonChanged) visibleChange = true;

    const eligible = isLabelEligible(db, threadId, reason === 'new');
    const target = loadGroups(db).find((g) => g.id === c.groupId)?.labelIdsByAccount.get(t.account_id);
    // Write the group label for new mail, a new group, a first classification, or a label we never wrote
    // (e.g. a failed write). A label the owner removed after we wrote it stays removed.
    const neverWritten = !target || (!labels.has(target) && lastWriteOf(db, t.account_id, t.gmail_thread_id, target) === null);
    const apply = eligible && (reason === 'new' || c.changed || c.previousGroupId === null || neverWritten || moveOwed);
    // A thread back in the inbox that is no longer snoozed should not keep showing SuperMail/Snoozed in Gmail.
    const removeSnoozed = !stillSnoozed && snoozedId !== null && labels.has(snoozedId) && labels.has('INBOX');

    if (visibleChange) {
      if (t.in_inbox === 1 || snoozed) publishThread(db, threadId);
      publishGroups(db);
    }
    return apply || removeSnoozed ? { accountId: t.account_id, apply, isNew: reason === 'new', removeSnoozed } : { accountId: t.account_id, apply: false, isNew: false, removeSnoozed: false };
  }

  async function write(threadId: ThreadId, plan: WritePlan): Promise<void> {
    const gmail = gmailFor(plan.accountId);
    // Existing-label groups created before this account was connected: map the owner's label here once.
    for (const g of loadGroups(db)) {
      const key = `${plan.accountId}:${g.id}`;
      if (g.kind !== 'existing_label' || g.labelIdsByAccount.has(plan.accountId) || adopted.has(key)) continue;
      adopted.add(key);
      await adoptExistingLabel(db, gmailFor, g.id, [plan.accountId], now(), log, 'background');
    }
    if (plan.apply) {
      await applyThreadLabels(db, gmail, threadId, { isNew: plan.isNew, snoozed: plan.removeSnoozed ? false : undefined, now: now() });
    } else if (plan.removeSnoozed) {
      const snoozedId = snoozedLabelId(db, plan.accountId);
      if (snoozedId) await writeLabels(db, gmail, threadId, [], [snoozedId], now());
    }
  }

  const hook: ThreadChangeHook = Object.assign(
    (threadId: string, reason: 'new' | 'changed') => {
      let plan: WritePlan | null;
      try {
        plan = db.transaction(() => decide(threadId, reason))();
      } catch (err) {
        log.error({ threadId, err }, 'classifying thread failed');
        return;
      }
      if (!plan || !(plan.apply || plan.removeSnoozed)) return;
      const p = plan;
      void queueLabelWrite(db, threadId, log, () => write(threadId, p));
    },
    { idle: () => labelWritesIdle(db) },
  );
  return hook;
}
