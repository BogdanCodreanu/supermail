import type { gmail_v1 } from 'googleapis';
import type { ActionResult, MessageDTO, ThreadDetailDTO, ThreadId, ThreadPage, ThreadSummaryDTO } from '@supermail/shared';
import { actionResult, needsReconnect, setOverride, setSnooze, snapshotThread, threadRow, type ThreadRow, type ThreadSnapshot, withGmail } from '../actions/actions.js';
import { recordUndo } from '../actions/undo.js';
import type { DB } from '../db/index.js';
import { HttpError } from '../errors.js';
import { bus } from '../events.js';
import { type GmailApi } from '../google/gmailApi.js';
import { type ParsedMessage, parseMessage } from '../google/parse.js';
import type { AppDeps } from '../http/app.js';
import { ensureSnoozedLabel, recordLabelWrite, snoozedLabelId, writeLabels } from '../labels/labelWriter.js';
import { extractBody } from '../mail/bodies.js';
import { ownEmailsOf, receivedAt, removeThread } from '../sync/indexer.js';
import { fetchAndIndex, isNotFound, mapLimit, updateAccountStatus } from '../sync/initialSync.js';
import { publishGroups, reclassifyThreads, type ReclassifyOptions } from '../threads/classifyThread.js';

// Spam is never stored on the server: the index drops it (indexer.ts), so these read it live from Gmail and write
// nothing to `threads`, `messages` or `body_cache`. There is no delete here: Gmail purges spam after 30 days.

/** How many threads the Spam screen asks each account for. */
export const SPAM_PER_ACCOUNT = 50;
const FETCH_CONCURRENCY = 5;
/** How long one account's list is reused: a read of it costs up to 510 quota units. */
const SPAM_CACHE_MS = 10_000;
const NOT_IN_SPAM = 'This thread is no longer in spam';
const RECONNECT = 'This Gmail account needs to be reconnected';

/** A thread out of the index, so its undo payload says where it is. `snapshot` is what undo puts back. */
export interface SpamUndoPayload { accountId: string; gmailThreadId: string; snapshot: ThreadSnapshot }

interface SpamRef { id: ThreadId; account_id: string; gmail_thread_id: string }

/** Spam has no index row, so its id is the only thing that says which account it is in. */
function spamRef(db: DB, id: ThreadId): SpamRef {
  const at = id.lastIndexOf(':');
  const accountId = id.slice(0, Math.max(at, 0));
  const gmailThreadId = id.slice(at + 1);
  if (!accountId || !gmailThreadId || !db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(accountId)) throw new HttpError(404, `thread ${id} not found`);
  return { id, account_id: accountId, gmail_thread_id: gmailThreadId };
}

interface SpamRead { at: number; threads: Promise<ThreadSummaryDTO[]> }
/** Per account, the latest read of its spam, finished or on its way. Memory only: spam is never stored. */
const spamReads = new WeakMap<DB, Map<string, SpamRead>>();

function forgetSpam(db: DB, accountId: string): void {
  spamReads.get(db)?.delete(accountId);
}

/** The labels change in Gmail only: the thread has no index row for `writeLabels` to work from. */
async function moveLabels(db: DB, gmail: GmailApi, t: SpamRef, add: string[], remove: string[], now: number): Promise<void> {
  await gmail.modifyThread(t.gmail_thread_id, add, remove);
  forgetSpam(db, t.account_id);
  recordLabelWrite(db, t.account_id, t.gmail_thread_id, add, remove, now);
}

export async function writeSpam(db: DB, gmail: GmailApi, t: ThreadRow, now: number): Promise<boolean> {
  const snoozed = snoozedLabelId(db, t.account_id);
  const written = await writeLabels(db, gmail, t.id, ['SPAM'], snoozed ? ['INBOX', snoozed] : ['INBOX'], now);
  forgetSpam(db, t.account_id);
  return written;
}

/** Report spam: Gmail learns from the label. No rule or mark, so SuperMail learns nothing from it. */
export async function reportSpam(d: AppDeps, threadId: ThreadId): Promise<ActionResult> {
  const { db } = d;
  const t = threadRow(db, threadId);
  const snapshot = snapshotThread(db, threadId);
  const now = d.now();
  // Gmail first, then the index: if Gmail fails nothing changes.
  await withGmail(d, t, (gmail) => writeSpam(db, gmail, t, now));
  removeThread(db, t.account_id, t.gmail_thread_id); // the cascade clears its snooze and override
  bus.publish({ type: 'thread.removed', id: threadId });
  publishGroups(db);
  const payload: SpamUndoPayload = { accountId: t.account_id, gmailThreadId: t.gmail_thread_id, snapshot };
  return { undoId: recordUndo(db, threadId, 'spam', payload, now), thread: null };
}

/**
 * Undoes a report: the thread leaves spam, goes back where it was and is indexed again straight away. The hook
 * stays out of the re-index, so the thread is classified and labelled only once its snooze and override are back.
 */
export async function restoreFromSpam(d: AppDeps, threadId: ThreadId, { accountId, gmailThreadId, snapshot: snap }: SpamUndoPayload, labels: ReclassifyOptions['labels'] = 'await'): Promise<void> {
  const { db } = d;
  const t: SpamRef = { id: threadId, account_id: accountId, gmail_thread_id: gmailThreadId };
  const now = d.now();
  await withGmail(d, t, async (gmail) => {
    const add = snap.inInbox ? ['INBOX'] : [];
    if (snap.snooze) add.push(await ensureSnoozedLabel(db, gmail, accountId));
    await moveLabels(db, gmail, t, add, ['SPAM'], now);
    if ((await fetchAndIndex(db, accountId, gmail, gmailThreadId, ownEmailsOf(db), undefined, 'sync')) === 'removed') throw new HttpError(404, 'This thread no longer exists in Gmail');
  });
  db.transaction(() => {
    db.prepare('UPDATE threads SET done_at = ?, surfaced_at = ? WHERE id = ?').run(snap.doneAt, snap.surfacedAt ?? null, threadId);
    setSnooze(db, threadId, snap.snooze);
    setOverride(db, threadId, snap.override);
  })();
  await reclassifyThreads(db, d.gmailFor, [threadId], now, { labels });
}

/** Not spam: back in the inbox, classified and labelled like new mail, and ranked first so it is not lost. */
export async function notSpam(d: AppDeps, threadId: ThreadId): Promise<ActionResult> {
  const { db } = d;
  const t = spamRef(db, threadId);
  const now = d.now();
  await withGmail(d, t, async (gmail) => {
    if (spamMessages(await gmail.getThread(t.gmail_thread_id, 'metadata')).length === 0) throw new HttpError(404, NOT_IN_SPAM);
    await moveLabels(db, gmail, t, ['INBOX'], ['SPAM'], now);
    if ((await fetchAndIndex(db, t.account_id, gmail, t.gmail_thread_id, ownEmailsOf(db), d.onThreadChange, 'live')) === 'removed') throw new HttpError(404, 'This thread no longer exists in Gmail');
  });
  db.prepare('UPDATE threads SET surfaced_at = ? WHERE id = ?').run(now, threadId);
  return actionResult(db, threadId, recordUndo(db, threadId, 'unspam', null, now));
}

/** The messages Gmail has set aside as spam. A thread can also hold normal mail, which stays out of this view. */
function spamMessages(t: gmail_v1.Schema$Thread): gmail_v1.Schema$Message[] {
  return (t.messages ?? []).filter((m) => {
    const labels = m.labelIds ?? [];
    return !!m.id && labels.includes('SPAM') && !labels.includes('DRAFT') && !labels.includes('TRASH');
  });
}

function spamSummary(id: ThreadId, accountId: string, raws: gmail_v1.Schema$Message[], own: Set<string>): ThreadSummaryDTO {
  const msgs = raws.map((raw) => ({ raw, p: parseMessage(raw) })).sort((a, b) => receivedAt(a.raw, a.p) - receivedAt(b.raw, b.p));
  const latest = msgs.at(-1)!.p;
  const isOwn = (p: ParsedMessage) => own.has(p.from.email.toLowerCase()) || p.labelIds.includes('SENT');
  const from = [...msgs].reverse().find((m) => !isOwn(m.p))?.p ?? latest;
  return {
    id,
    accountId,
    subject: msgs.find((m) => m.p.subject)?.p.subject ?? '',
    snippet: latest.snippet,
    fromName: from.from.name,
    fromEmail: from.from.email || null,
    // Gmail's receive time: spam forges its Date header, and a future one would stay on top of the list.
    lastMessageAt: Math.max(...msgs.map((m) => receivedAt(m.raw, m.p))),
    unread: msgs.some((m) => m.p.labelIds.includes('UNREAD')),
    inInbox: false,
    groupId: 'unsorted',
    groupName: 'Spam',
    reason: { source: 'default', text: 'In Gmail spam', at: null },
    snoozedUntil: null,
    hasAttachments: msgs.some((m) => m.p.hasAttachments),
    suggestRule: false,
    doneAt: null,
  };
}

async function spamOf(d: AppDeps, accountId: string, own: Set<string>): Promise<ThreadSummaryDTO[]> {
  try {
    const gmail = d.gmailFor(accountId);
    const { ids } = await gmail.listThreads({ q: 'in:spam', maxResults: SPAM_PER_ACCOUNT });
    const found: ThreadSummaryDTO[] = [];
    await mapLimit(ids, FETCH_CONCURRENCY, async (gmailThreadId) => {
      let thread: gmail_v1.Schema$Thread;
      try {
        thread = await gmail.getThread(gmailThreadId, 'metadata');
      } catch (err) {
        if (isNotFound(err)) return; // gone since the list
        throw err;
      }
      const raws = spamMessages(thread);
      if (raws.length > 0) found.push(spamSummary(`${accountId}:${gmailThreadId}`, accountId, raws, own));
    });
    return found;
  } catch (err) {
    if (!needsReconnect(err)) throw err;
    updateAccountStatus(d.db, accountId, 'reconnect_needed');
    throw new HttpError(409, RECONNECT);
  }
}

/** An account's spam, read once for all callers within SPAM_CACHE_MS. A failed read is not kept. */
function cachedSpamOf(d: AppDeps, accountId: string, own: Set<string>): Promise<ThreadSummaryDTO[]> {
  let reads = spamReads.get(d.db);
  if (!reads) spamReads.set(d.db, (reads = new Map()));
  const hit = reads.get(accountId);
  if (hit && d.now() - hit.at < SPAM_CACHE_MS) return hit.threads;
  const read: SpamRead = { at: d.now(), threads: spamOf(d, accountId, own) };
  reads.set(accountId, read);
  read.threads.catch(() => {
    if (reads.get(accountId) === read) reads.delete(accountId);
  });
  return read.threads;
}

/**
 * Every account's Gmail spam, merged newest first. An account that fails is left out; if none can be read that
 * is an error, so the Spam screen never says "No spam" about mail it could not see.
 */
export async function listSpam(d: AppDeps): Promise<ThreadPage> {
  const all = d.db.prepare('SELECT id, status FROM accounts ORDER BY created_at, id').all() as { id: string; status: string }[];
  const accounts = all.filter((a) => a.status !== 'reconnect_needed');
  if (all.length > 0 && accounts.length === 0) throw new HttpError(409, RECONNECT);
  const own = ownEmailsOf(d.db);
  const results = await Promise.allSettled(accounts.map((a) => cachedSpamOf(d, a.id, own)));
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (accounts.length > 0 && failures.length === accounts.length) throw failures[0]!.reason;
  const threads = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  threads.sort((a, b) => b.lastMessageAt - a.lastMessageAt || (a.id < b.id ? 1 : -1));
  return { threads, nextCursor: null };
}

async function spamMessage(gmail: GmailApi, accountId: string, raw: gmail_v1.Schema$Message): Promise<MessageDTO> {
  const p = parseMessage(raw);
  const body = await extractBody(gmail, raw);
  return { id: `${accountId}:${p.gmailMessageId}`, gmailMessageId: p.gmailMessageId, from: p.from, to: p.to, cc: p.cc, date: receivedAt(raw, p), subject: p.subject, html: body.html, text: body.text, attachments: body.attachments };
}

/** One spam thread, live from Gmail in full. Nothing is cached or indexed, and nothing is marked read. */
export async function getSpamThread(d: AppDeps, id: ThreadId): Promise<ThreadDetailDTO> {
  const t = spamRef(d.db, id);
  return withGmail(d, t, async (gmail) => {
    const raws = spamMessages(await gmail.getThread(t.gmail_thread_id, 'full'));
    if (raws.length === 0) throw new HttpError(404, NOT_IN_SPAM);
    const messages = await Promise.all(raws.map((raw) => spamMessage(gmail, t.account_id, raw)));
    return { thread: spamSummary(id, t.account_id, raws, ownEmailsOf(d.db)), messages: messages.sort((a, b) => a.date - b.date) };
  });
}
