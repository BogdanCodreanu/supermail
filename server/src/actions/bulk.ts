import { MAX_BULK_IDS, MAX_BULK_SENDERS, type ActionResult, type BulkAction, type BulkRequest, type BulkResult, type TeachBulkRequest, type ThreadId } from '@supermail/shared';
import type { gmail_v1 } from 'googleapis';
import { matchKeys } from '../classify/heuristics.js';
import type { DB } from '../db/index.js';
import { HttpError } from '../errors.js';
import { bus } from '../events.js';
import type { GmailApi } from '../google/gmailApi.js';
import type { AppDeps } from '../http/app.js';
import { applyThreadLabels } from '../labels/labelWriter.js';
import { restoreFromSpam, type SpamUndoPayload, writeSpam } from '../spam/spam.js';
import { mapLimit } from '../sync/initialSync.js';
import { indexThread, isIndexable, ownEmailsOf, removeThread } from '../sync/indexer.js';
import { classifyInput, classifyThread, consoleLog, LABEL_CONCURRENCY, type Log, publishGroups, publishThread, queueLabelWrite, trackLabelWrites } from '../threads/classifyThread.js';
import {
  assertGroup, assertSnoozeTime, indexDone, indexSnooze, overrideOf, setOverride, setSnooze, snapshotThread, TEACH_ACTIONS, teach, threadRow, type TeachUndoPayload, type ThreadRow, type ThreadSnapshot,
  withGmail, writeDone, writeRead, writeSnooze,
} from './actions.js';
import { groupExists, recordUndo, restoreHides, restoreIndex, restoreLabels, restoreTeach } from './undo.js';

// A bulk action moves hundreds of threads on screen at once, then takes its time in Gmail: at the quota's 200 units a
// second, with a read and a write for each thread that leaves the inbox, 300 threads take 30 seconds. So unlike a single
// action it changes the index first, and every thread carries a way back for when Gmail refuses, or the owner undoes it
// before Gmail ever heard of it. Until Gmail confirms, `pending_writes` holds what each thread is meant to become, written
// with the index change, so a stop in between loses nothing: the next start finishes the job.
//
// The owner decided on the mail they could see. So just before a write that hides mail, the thread is read from Gmail,
// and a thread with mail the index lacks stands down and stays where it was. If in doubt, the thread stays visible.

const BULK_ACTIONS: BulkAction[] = ['done', 'snooze', 'read', 'unread', 'move', 'spam'];
/** Threads changed per turn of the event loop, so a big selection never holds up other requests. */
const INDEX_BATCH = 50;

/**
 * What one thread's share of a bulk action is meant to do: all a restart needs to finish it. `seen` is the thread's
 * last_message_at at the time, `before` what a refused write puts back.
 */
type Intent =
  | { op: 'done' | 'read' | 'unread' | 'spam'; at: number; before: ThreadSnapshot; seen: number }
  | { op: 'snooze'; at: number; until: number; before: ThreadSnapshot; seen: number }
  | { op: 'move'; at: number; groupId: string; before: ThreadSnapshot }
  /** Puts a thread back from the undo row `kind`, whose snapshot is `snap`. */
  | { op: 'undo'; at: number; kind: string; snap: ThreadSnapshot; before: ThreadSnapshot; seen: number }
  | { op: 'unspam'; at: number; report: SpamUndoPayload };

/** One thread's share of a bulk action. */
interface Change {
  thread: ThreadRow;
  intent: Intent;
  /** The undo row that takes this change back: its kind and payload. */
  kind: string;
  payload: unknown;
  /** Takes mail out of the inbox, marks it read or sends it to spam in Gmail, so new mail stands the write down. */
  hides?: boolean;
  /** Changes the index. Runs before the request answers. */
  apply(): void;
  /** Tells the screen. The default publishes the thread as it now is. */
  publish?(): void;
  /** False when something newer decided about the thread while the write waited, such as a reply cancelling Done. */
  wanted?(): boolean;
  /** Takes this action's mark off a thread that stood down on mail already indexed. The indexer put the rest right. */
  release?(): void;
  /** Changes Gmail, in the background. */
  write(gmail: GmailApi): Promise<unknown>;
  /** Runs once Gmail has it. */
  landed?(): void;
  /** Puts the index back, because Gmail refused. */
  revert(): void;
}

/** `replayed`: left unfinished by the last stop, so what the index holds of the labels may be out of date. */
interface Job { change: Change; undoId: string; cancelled: boolean; replayed: boolean }
/** Threads whose write did not happen: put back because Gmail refused, or skipped because new mail reached them first. */
interface Outcome { failed: ThreadId[]; skipped: ThreadId[] }

/** The per-thread undo ids of a bulk action. */
export interface BulkUndoPayload { undoIds: string[] }

/** The writes still waiting or running, by per-thread undo id: an undo cancels those Gmail has not seen. */
const jobs = new Map<string, Job>();

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const threadExists = (db: DB, id: ThreadId) => !!db.prepare('SELECT 1 FROM threads WHERE id = ?').get(id);
const lastMessageAt = (db: DB, id: ThreadId) => db.prepare('SELECT last_message_at FROM threads WHERE id = ?').pluck().get(id) as number | undefined;

/** Takes a thread off every list without dropping its row: the row goes once Gmail has it, and is the way back. */
function indexSpam(db: DB, threadId: ThreadId): void {
  db.transaction(() => {
    setSnooze(db, threadId, null);
    db.prepare('UPDATE threads SET in_inbox = 0, done_at = NULL WHERE id = ?').run(threadId);
  })();
}

/** What a selected thread is meant to become. */
function intentFor(db: DB, r: BulkRequest, id: ThreadId, at: number): Intent {
  const before = snapshotThread(db, id);
  const seen = lastMessageAt(db, id)!;
  switch (r.action) {
    case 'snooze':
      return { op: 'snooze', at, until: r.until!, before, seen };
    case 'move':
      return { op: 'move', at, groupId: r.groupId!, before };
    default:
      return { op: r.action, at, before, seen };
  }
}

/** Turns an intent into its change: fresh for a new action, and again from the journal after a restart. */
function changeOf(d: AppDeps, t: ThreadRow, intent: Intent): Change {
  const { db } = d;
  const id = t.id;
  const quiet = (seen: number) => lastMessageAt(db, id) === seen;
  switch (intent.op) {
    case 'done': {
      const { at, before, seen } = intent;
      return {
        thread: t, intent, kind: 'done', payload: before, hides: true, apply: () => indexDone(db, id, at), write: (gmail) => writeDone(db, gmail, t, at), revert: () => restoreIndex(db, id, 'done', before),
        wanted: () => db.prepare('SELECT done_at FROM threads WHERE id = ?').pluck().get(id) === at && quiet(seen),
        release: () => void db.prepare('UPDATE threads SET done_at = NULL WHERE id = ? AND done_at = ?').run(id, at),
      };
    }
    case 'snooze': {
      const { at, until, before, seen } = intent;
      return {
        thread: t, intent, kind: 'snooze', payload: before, hides: true, apply: () => indexSnooze(db, id, until, at), write: (gmail) => writeSnooze(db, gmail, t, at), revert: () => restoreIndex(db, id, 'snooze', before),
        wanted: () => db.prepare('SELECT created_at FROM snoozes WHERE thread_id = ?').pluck().get(id) === at && quiet(seen),
        release: () => void db.prepare('DELETE FROM snoozes WHERE thread_id = ? AND created_at = ?').run(id, at),
      };
    }
    case 'read':
    case 'unread': {
      const { at, before, seen } = intent;
      const read = intent.op === 'read';
      return {
        thread: t, intent, kind: 'read', payload: before, hides: read, apply: () => void db.prepare('UPDATE threads SET unread = ? WHERE id = ?').run(read ? 0 : 1, id),
        wanted: () => quiet(seen), write: (gmail) => writeRead(db, gmail, id, read, at), revert: () => restoreIndex(db, id, 'read', before),
      };
    }
    case 'move': {
      const { at, groupId, before } = intent;
      return {
        thread: t,
        intent,
        kind: 'move',
        payload: before,
        apply: () => {
          setOverride(db, id, { groupId, source: 'app', createdAt: at, suggestRule: false });
          classifyThread(db, id);
        },
        wanted: () => overrideOf(db, id)?.createdAt === at,
        write: (gmail) => applyThreadLabels(db, gmail, id, { now: at, selected: true }),
        revert: () => {
          setOverride(db, id, before.override && groupExists(db, before.override.groupId) ? before.override : null);
          classifyThread(db, id);
        },
      };
    }
    case 'spam': {
      const { at, before, seen } = intent;
      return {
        thread: t,
        intent,
        kind: 'spam',
        payload: { accountId: t.account_id, gmailThreadId: t.gmail_thread_id, snapshot: before } satisfies SpamUndoPayload,
        hides: true,
        apply: () => indexSpam(db, id),
        publish: () => bus.publish({ type: 'thread.removed', id }),
        wanted: () => quiet(seen),
        write: (gmail) => writeSpam(db, gmail, t, at),
        landed: () => {
          removeThread(db, t.account_id, t.gmail_thread_id); // the cascade clears its snooze and override
          publishGroups(db);
        },
        revert: () => restoreIndex(db, id, 'done', before),
      };
    }
    case 'unspam': {
      const { report } = intent;
      const here = threadExists(db, id);
      return {
        thread: t,
        intent,
        kind: 'unspam',
        payload: null,
        // The row is here while the report is on its way to Gmail. A report still waiting is cancelled and leaves nothing
        // in Gmail to take back; one already sent has dropped the row by the time this write takes its turn.
        apply: () => {
          if (here) restoreIndex(db, id, 'done', report.snapshot);
        },
        publish: () => {
          if (here) publishThread(db, id);
        },
        write: async () => {
          if (!threadExists(db, id)) await restoreFromSpam(d, id, report, 'background');
          publishThread(db, id);
        },
        revert: () => {},
      };
    }
    case 'undo': {
      const { at, kind, snap, before, seen } = intent;
      const move = kind === 'move';
      const hides = restoreHides(kind, snap);
      return {
        thread: t,
        intent,
        kind,
        payload: before,
        hides,
        apply: () => {
          restoreIndex(db, id, kind, snap);
          if (move) classifyThread(db, id);
        },
        wanted: () => !hides || quiet(seen),
        write: (gmail) => (move ? applyThreadLabels(db, gmail, id, { now: at, selected: true }) : restoreLabels(db, gmail, t, kind, snap, at)),
        revert: () => {
          restoreIndex(db, id, kind, before);
          if (move) classifyThread(db, id);
        },
      };
    }
  }
}

/** True when Gmail holds mail the index has never seen. Drafts, spam and trash stay out of the index, so they do not count. */
function hasUnseenMail(db: DB, threadId: ThreadId, thread: gmail_v1.Schema$Thread): boolean {
  const known = new Set(db.prepare('SELECT gmail_message_id FROM messages WHERE thread_id = ?').pluck().all(threadId) as string[]);
  return (thread.messages ?? []).some((m) => isIndexable(m) && !known.has(m.id!));
}

/**
 * Reads the thread just before its write. With mail the index lacks, the index goes back and takes the new mail in,
 * as the poller would have, and the answer is true: the write stands down. A replayed write takes in Gmail's state
 * whatever it finds, since the last stop may have cut off a write that landed.
 */
async function readBeforeWrite(d: AppDeps, job: Job, gmail: GmailApi): Promise<boolean> {
  const { db } = d;
  const { change, replayed } = job;
  const t = change.thread;
  const thread = await gmail.getThread(t.gmail_thread_id, 'metadata');
  const unseen = !!change.hides && hasUnseenMail(db, t.id, thread);
  if (unseen) change.revert();
  if (unseen || replayed) indexThread(db, t.account_id, { ...thread, id: thread.id ?? t.gmail_thread_id }, ownEmailsOf(db), d.onThreadChange, 'live');
  return unseen;
}

/** New mail reached the thread first: it stays where it was, out of the undo, and the bulk toast says so. */
function skip(d: AppDeps, job: Job, out: Outcome): void {
  const { db } = d;
  const id = job.change.thread.id;
  out.skipped.push(id);
  db.prepare('DELETE FROM undo WHERE id = ?').run(job.undoId);
  publishThread(db, id);
  publishGroups(db);
}

/** True when the write is off: an undo cancelled it, or something newer decided about the thread while it waited. */
function isOff(d: AppDeps, job: Job, out: Outcome): boolean {
  const { db } = d;
  const { change } = job;
  if (job.cancelled) return true;
  if (change.wanted?.() !== false) return false;
  const seen = 'seen' in change.intent ? change.intent.seen : undefined;
  const latest = lastMessageAt(db, change.thread.id);
  if (seen !== undefined && latest !== undefined && latest !== seen) {
    change.release?.();
    skip(d, job, out);
  }
  return true;
}

/** Leaves nothing for the bulk undo to take back, and puts the index and the screen back. */
function putBack(d: AppDeps, job: Job, out: Outcome): void {
  const { db } = d;
  const { change } = job;
  out.failed.push(change.thread.id);
  db.prepare('DELETE FROM undo WHERE id = ?').run(job.undoId);
  if (threadExists(db, change.thread.id)) {
    change.revert();
    publishThread(db, change.thread.id);
    publishGroups(db);
  }
}

const needsReconnecting = (db: DB, accountId: string) => db.prepare('SELECT status FROM accounts WHERE id = ?').pluck().get(accountId) === 'reconnect_needed';

const addPending = (db: DB, undoId: string, { thread: t, intent }: Change) =>
  db.prepare('INSERT INTO pending_writes(undo_id, thread_id, account_id, gmail_thread_id, op, intent_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(undoId, t.id, t.account_id, t.gmail_thread_id, intent.op, JSON.stringify(intent), intent.at);
const clearPending = (db: DB, undoId: string) => db.prepare('DELETE FROM pending_writes WHERE undo_id = ?').run(undoId);

/** One thread's Gmail write. A failure puts the index back, and leaves nothing for the bulk undo to take back. */
async function writeJob(d: AppDeps, job: Job, out: Outcome): Promise<void> {
  const { db } = d;
  const { change } = job;
  try {
    if (isOff(d, job, out)) return;
    if (needsReconnecting(db, change.thread.account_id)) {
      putBack(d, job, out); // no token call for what only a reconnect can fix
      return;
    }
    const sent = await withGmail(d, change.thread, async (gmail) => {
      if ((change.hides || job.replayed) && (await readBeforeWrite(d, job, gmail))) {
        skip(d, job, out);
        return false;
      }
      if (isOff(d, job, out)) return false;
      await change.write(gmail);
      return true;
    });
    if (sent) change.landed?.();
  } catch (err) {
    putBack(d, job, out);
    throw err; // the label queue logs it
  } finally {
    jobs.delete(job.undoId);
    clearPending(db, job.undoId);
  }
}

/** Writes Gmail through the same queue, concurrency and quota as teaching. */
function runJobs(d: AppDeps, batch: Job[], out: Outcome): Promise<void> {
  const { db } = d;
  return mapLimit(batch, LABEL_CONCURRENCY, (job) => queueLabelWrite(db, job.change.thread.id, consoleLog, () => writeJob(d, job, out)));
}

/** Writes Gmail in the background, then says how it went. */
function writeInBackground(d: AppDeps, undoId: string, batch: Job[]): void {
  const out: Outcome = { failed: [], skipped: [] };
  const writes = runJobs(d, batch, out).then(() => {
    bus.publish({ type: 'bulk.settled', undoId, affected: batch.length - out.failed.length - out.skipped.length, ...out });
  });
  trackLabelWrites(d.db, writes);
}

/**
 * Applies changes to the index, a batch per turn of the event loop, with one undo over them all, then leaves the
 * rest to the background. `next` gives each thread its change, or null when it is gone. A row the database refuses
 * rolls back alone and is skipped like a gone one, so it never takes the others down with it.
 */
async function applyChanges<T>(d: AppDeps, items: T[], next: (item: T) => Change | null, more: string[] = []): Promise<{ undoId: string; affected: number; skipped: T[] }> {
  const { db } = d;
  const at = d.now();
  const batch: Job[] = [];
  const skipped: T[] = [];
  const applyRow = db.transaction((item: T): Job | null => {
    const change = next(item);
    if (!change) return null;
    change.apply();
    const undoId = recordUndo(db, change.thread.id, change.kind, change.payload, at);
    addPending(db, undoId, change);
    return { change, undoId, cancelled: false, replayed: false };
  });
  for (let i = 0; i < items.length; i += INDEX_BATCH) {
    if (i > 0) await nextTurn();
    const applied: Job[] = [];
    db.transaction(() => {
      for (const item of items.slice(i, i + INDEX_BATCH)) {
        try {
          const job = applyRow(item);
          if (job) applied.push(job);
          else skipped.push(item);
        } catch (err) {
          consoleLog.error({ item, err }, 'a row of a bulk action failed');
          skipped.push(item);
        }
      }
    })();
    for (const { change } of applied) (change.publish ?? (() => publishThread(db, change.thread.id)))();
    publishGroups(db);
    batch.push(...applied);
  }
  const undoId = recordUndo(db, batch[0]?.change.thread.id ?? '', 'bulk', { undoIds: [...batch.map((j) => j.undoId), ...more] } satisfies BulkUndoPayload, at);
  for (const job of batch) jobs.set(job.undoId, job);
  writeInBackground(d, undoId, batch);
  return { undoId, affected: batch.length, skipped };
}

function assertIds(ids: unknown): asserts ids is ThreadId[] {
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string')) throw new HttpError(400, 'ids must be a list of thread ids');
  if (ids.length > MAX_BULK_IDS) throw new HttpError(400, `At most ${MAX_BULK_IDS} threads at a time`);
}

const rowOf = (db: DB, id: ThreadId): ThreadRow | null => (threadExists(db, id) ? threadRow(db, id) : null);

/** Done, snooze, read, unread, move or spam on many threads. See the head of this file. */
export async function bulkAction(d: AppDeps, r: BulkRequest): Promise<BulkResult> {
  const { db } = d;
  assertIds(r.ids);
  if (!BULK_ACTIONS.includes(r.action)) throw new HttpError(400, 'Unknown bulk action');
  const at = d.now();
  if (r.action === 'snooze') assertSnoozeTime(r.until, at);
  if (r.action === 'move') assertGroup(db, r.groupId);
  const { undoId, affected, skipped } = await applyChanges(d, [...new Set(r.ids)], (id) => {
    const t = rowOf(db, id);
    return t && changeOf(d, t, intentFor(db, r, id, at));
  });
  return { undoId, affected, failed: skipped };
}

/**
 * Teaches each unique sender among `ids`, reusing `teach`, under one undo. Teaching writes its labels in the
 * background on its own, for threads in the inbox or snoozed: archived mail keeps its labels.
 */
export async function teachBulk(d: AppDeps, r: TeachBulkRequest): Promise<BulkResult> {
  const { db } = d;
  assertIds(r.ids);
  if (!TEACH_ACTIONS.includes(r.action)) throw new HttpError(400, 'Unknown teach action');
  if (r.action === 'always_group') assertGroup(db, r.groupId);
  const senders = new Map<string, ThreadId>();
  const failed: ThreadId[] = [];
  for (const id of new Set(r.ids)) {
    const input = classifyInput(db, id);
    const sender = input && matchKeys(input).sender;
    if (sender) senders.set(sender, senders.get(sender) ?? id);
    else failed.push(id);
  }
  if (senders.size > MAX_BULK_SENDERS) throw new HttpError(400, `At most ${MAX_BULK_SENDERS} senders at a time`);
  const undoIds: string[] = [];
  let affected = 0;
  for (const threadId of senders.values()) {
    try {
      const res = await teach(d, { threadId, action: r.action, scope: 'sender', ...(r.groupId ? { groupId: r.groupId } : {}) });
      undoIds.push(res.undoId);
      affected += res.affected ?? 0;
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      failed.push(threadId); // it left the index while the others were taught
    }
    await nextTurn(); // each sender rereads the rules and every thread of theirs, so 50 of them must not block the rest
  }
  const first = [...senders.values()][0] ?? r.ids[0]!;
  return { undoId: recordUndo(db, first, 'bulk', { undoIds } satisfies BulkUndoPayload, d.now()), affected, failed };
}

interface UndoRow { id: string; thread_id: string; kind: string; payload_json: string }

/** How to undo one thread's row of a bulk action, index first. Null when the thread or the group to go back to has gone. */
function undoChange(d: AppDeps, row: UndoRow): Change | null {
  const { db } = d;
  const id = row.thread_id;
  const at = d.now();
  const payload = JSON.parse(row.payload_json) as unknown;
  if (row.kind === 'spam') {
    const report = payload as SpamUndoPayload;
    return changeOf(d, { id, account_id: report.accountId, gmail_thread_id: report.gmailThreadId }, { op: 'unspam', at, report });
  }
  const t = rowOf(db, id);
  if (!t) return null;
  const before = snapshotThread(db, id);
  const seen = lastMessageAt(db, id)!;
  if (row.kind === 'unspam') return changeOf(d, t, { op: 'spam', at, before, seen });
  const snap = payload as ThreadSnapshot;
  if (row.kind === 'move' && snap.override && !groupExists(db, snap.override.groupId)) return null;
  return changeOf(d, t, { op: 'undo', at, kind: row.kind, snap, before, seen });
}

/**
 * One undo for a whole bulk action: the index and the screen go back at once, and Gmail follows, as it did for the
 * action itself. Writes Gmail has not seen yet are cancelled, so a quick `z` costs no quota. The result's undo id
 * redoes it all. It works row by row: a thread or a group that has gone is skipped and counted, and the rest finish. A
 * teaching goes back through `restoreTeach`, which is quick: it writes its labels in the background.
 */
export async function undoBulk(d: AppDeps, { undoIds }: BulkUndoPayload): Promise<ActionResult> {
  const { db } = d;
  const undoRow = (id: string) => db.prepare('SELECT id, thread_id, kind, payload_json FROM undo WHERE id = ?').get(id) as UndoRow | undefined;
  const rows = undoIds.map(undoRow).filter((r) => r !== undefined);
  const redo: string[] = [];
  let taught = 0;
  let untaught = 0;
  for (const row of rows.filter((r) => r.kind === 'teach')) {
    try {
      const { redo: payload, affected } = await restoreTeach(d, row.thread_id, JSON.parse(row.payload_json) as TeachUndoPayload);
      db.prepare('DELETE FROM undo WHERE id = ?').run(row.id);
      redo.push(recordUndo(db, row.thread_id, 'teach', payload, d.now()));
      taught += affected;
    } catch (err) {
      consoleLog.error({ undoId: row.id, err }, 'undoing a teaching failed');
      untaught++;
    }
    await nextTurn();
  }
  const { undoId, affected, skipped } = await applyChanges(
    d,
    rows.filter((r) => r.kind !== 'teach'),
    (row) => {
      if (!undoRow(row.id)) return null; // another undo got here first
      const change = undoChange(d, row);
      db.prepare('DELETE FROM undo WHERE id = ?').run(row.id);
      if (!change) return null;
      clearPending(db, row.id);
      return {
        ...change,
        apply: () => {
          change.apply();
          const job = jobs.get(row.id);
          if (job) job.cancelled = true;
        },
      };
    },
    redo,
  );
  return { undoId, thread: null, affected: affected + taught, skipped: skipped.length + untaught };
}

/**
 * Run at startup, once the hook is in place: finishes in the background, through the normal queue, whatever the last
 * stop left in `pending_writes`. Each write reads the thread first, so one Gmail already has costs a read, and mail
 * that arrived meanwhile stands it down as usual. Returns how many it picked up.
 */
export function replayPendingWrites(d: AppDeps, log: Log = consoleLog): number {
  const { db } = d;
  const rows = db.prepare('SELECT undo_id, thread_id, account_id, gmail_thread_id, intent_json FROM pending_writes ORDER BY seq').all() as
    { undo_id: string; thread_id: string; account_id: string; gmail_thread_id: string; intent_json: string }[];
  const batch = rows.map((r): Job => {
    const t: ThreadRow = { id: r.thread_id, account_id: r.account_id, gmail_thread_id: r.gmail_thread_id };
    return { change: changeOf(d, t, JSON.parse(r.intent_json) as Intent), undoId: r.undo_id, cancelled: false, replayed: true };
  });
  for (const job of batch) jobs.set(job.undoId, job);
  const out: Outcome = { failed: [], skipped: [] };
  const writes = runJobs(d, batch, out).then(() => {
    if (batch.length > 0) log.warn({ replayed: batch.length, failed: out.failed.length, skipped: out.skipped.length }, 'finished the Gmail writes the last stop left');
  });
  trackLabelWrites(db, writes);
  return batch.length;
}

/**
 * Run at startup, before the poller. A write that fails or stops halfway can leave a thread the index has out of the
 * inbox, or read, while its labels say otherwise. The labels are Gmail's last word, so in_inbox and unread follow them,
 * and nothing else does: done_at and snoozes are the owner's decisions, which the poller settles. Threads with a
 * pending write are the replay's. Returns how many were put right.
 */
export function reconcileIndex(db: DB): number {
  const off = db.prepare(
    `SELECT id, has_inbox, has_unread FROM (
       SELECT t.id, t.in_inbox, t.unread,
              EXISTS(SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.label_ids_json LIKE '%"INBOX"%') AS has_inbox,
              EXISTS(SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.label_ids_json LIKE '%"UNREAD"%') AS has_unread
       FROM threads t
       WHERE NOT EXISTS(SELECT 1 FROM pending_writes p WHERE p.thread_id = t.id)
     ) WHERE in_inbox != has_inbox OR unread != has_unread`,
  ).all() as { id: string; has_inbox: number; has_unread: number }[];
  db.transaction(() => {
    for (const t of off) db.prepare('UPDATE threads SET in_inbox = ?, unread = ? WHERE id = ?').run(t.has_inbox, t.has_unread, t.id);
  })();
  return off.length;
}
