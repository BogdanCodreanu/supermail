import type { ThreadId } from '@supermail/shared';
import type { gmail_v1 } from 'googleapis';
import type { DB } from '../db/index.js';
import { type ParsedMessage, parseMessage } from '../google/parse.js';
import type { ThreadHook } from '../http/app.js';

/**
 * How a thread reached the indexer. `live` means the history poller saw it change, so a thread that gained
 * mail newer than the index is reported to the hook as `'new'`. `sync` (initial sync, resync, backfill) only
 * ever reports `'changed'`, so archived history is never treated as new mail and never gets labels written.
 */
export type IndexMode = 'live' | 'sync';

interface ExistingMessage { gmail_message_id: string; label_ids_json: string }

/**
 * Drafts are not mail yet, and spam and trash are mail Gmail has set aside: none of them is in the index, so they
 * never show up in the inbox, Show done or Skipped.
 */
export const isIndexable = (m: gmail_v1.Schema$Message): boolean => !!m.id && !(m.labelIds ?? []).some((l) => l === 'DRAFT' || l === 'SPAM' || l === 'TRASH');

/** Lowercased email addresses of every connected account: mail from any of them counts as the owner's. */
export function ownEmailsOf(db: DB): Set<string> {
  return new Set((db.prepare('SELECT lower(email) FROM accounts').pluck().all() as string[]));
}

/** Arrival time: Gmail's receive time when it has one (a sender's Date header can lie), else the Date header. */
function arrivedAt(raw: gmail_v1.Schema$Message, p: ParsedMessage): number {
  return Math.max(Number(raw.internalDate ?? 0) || 0, p.date);
}

/** Gmail's receive time only, so a future-dated Date header cannot push the arrival mark ahead. */
export function receivedAt(raw: gmail_v1.Schema$Message, p: ParsedMessage): number {
  return Number(raw.internalDate ?? 0) || p.date;
}

/**
 * Per account: `max` is the newest receive time in the index. `base` is `max` as it was when the poller's
 * history position became `historyId`, so every thread of one history pass is compared with the same mark.
 */
interface ArrivalMark { historyId: string | null; base: number; max: number }
const arrivalKey = (accountId: string) => `arrival:${accountId}`;
/** Mail received this close before the mark still counts as new (sent mail indexed out of order, clock skew). */
const ARRIVAL_SLACK_MS = 5 * 60_000;

function readArrivalMark(db: DB, accountId: string): ArrivalMark {
  const stored = db.prepare('SELECT value FROM kv WHERE key = ?').pluck().get(arrivalKey(accountId)) as string | undefined;
  if (stored) return JSON.parse(stored) as ArrivalMark;
  const connected = (db.prepare('SELECT created_at FROM accounts WHERE id = ?').pluck().get(accountId) as number | undefined) ?? 0;
  return { historyId: null, base: connected, max: connected };
}

/**
 * Upserts a thread and its messages from a Gmail thread resource (metadata or full format). Leaves the
 * owner's decisions alone (group, reason, overrides) except that a newly arrived message from someone else
 * cancels Done and any snooze made before it arrived (Review Focus 3). Calls `onChange` only when the thread
 * is new to the index or its messages or labels changed.
 */
export function indexThread(db: DB, accountId: string, t: gmail_v1.Schema$Thread, ownEmails: Set<string>, onChange?: ThreadHook, mode: IndexMode = 'live'): ThreadId {
  const gmailThreadId = t.id ?? '';
  const id: ThreadId = `${accountId}:${gmailThreadId}`;
  // A thread left with no other mail drops out; if the owner rescues it in Gmail, the next history event indexes it again.
  const raws = (t.messages ?? []).filter(isIndexable);
  if (raws.length === 0) {
    removeThread(db, accountId, gmailThreadId);
    return id;
  }
  const msgs = raws.map((raw) => ({ raw, p: parseMessage(raw) })).sort((a, b) => a.p.date - b.p.date);
  const isOwn = (p: ParsedMessage) => ownEmails.has(p.from.email.toLowerCase()) || p.labelIds.includes('SENT');

  const changed = db.transaction((): 'new' | 'changed' | null => {
    const prev = db.prepare('SELECT done_at FROM threads WHERE id = ?').get(id) as { done_at: number | null } | undefined;
    const existing = new Map(
      (db.prepare('SELECT gmail_message_id, label_ids_json FROM messages WHERE thread_id = ?').all(id) as ExistingMessage[]).map((r) => [r.gmail_message_id, r.label_ids_json]),
    );
    const added = msgs.filter((m) => !existing.has(m.p.gmailMessageId));
    const labelsChanged = msgs.some((m) => existing.has(m.p.gmailMessageId) && existing.get(m.p.gmailMessageId) !== JSON.stringify(m.p.labelIds));
    const removed = existing.size + added.length > msgs.length;

    const latest = msgs.at(-1)!.p;
    const fromMsg = [...msgs].reverse().find((m) => !isOwn(m.p))?.p ?? latest;
    const subject = msgs.find((m) => m.p.subject)?.p.subject ?? '';
    db.prepare(
      `INSERT INTO threads(id, account_id, gmail_thread_id, subject, snippet, from_name, from_email, last_message_at, unread, in_inbox, is_sent_only, has_attachments)
       VALUES (@id, @accountId, @gmailThreadId, @subject, @snippet, @fromName, @fromEmail, @lastMessageAt, @unread, @inInbox, @sentOnly, @hasAttachments)
       ON CONFLICT(id) DO UPDATE SET subject = excluded.subject, snippet = excluded.snippet, from_name = excluded.from_name,
         from_email = excluded.from_email, last_message_at = excluded.last_message_at, unread = excluded.unread,
         in_inbox = excluded.in_inbox, is_sent_only = excluded.is_sent_only, has_attachments = excluded.has_attachments`,
    ).run({
      id,
      accountId,
      gmailThreadId,
      subject,
      snippet: latest.snippet,
      fromName: fromMsg.from.name,
      fromEmail: fromMsg.from.email || null,
      lastMessageAt: Math.max(...msgs.map((m) => m.p.date)),
      unread: msgs.some((m) => m.p.labelIds.includes('UNREAD')) ? 1 : 0,
      inInbox: msgs.some((m) => m.p.labelIds.includes('INBOX')) ? 1 : 0,
      sentOnly: msgs.every((m) => m.p.labelIds.includes('SENT')) ? 1 : 0,
      hasAttachments: msgs.some((m) => m.p.hasAttachments) ? 1 : 0,
    });

    const upsert = db.prepare(
      `INSERT INTO messages(id, thread_id, account_id, gmail_message_id, from_name, from_email, to_json, cc_json, subject, snippet, date,
         label_ids_json, list_id, has_list_unsubscribe, rfc822_message_id, references_hdr, size_estimate)
       VALUES (@id, @threadId, @accountId, @gmailMessageId, @fromName, @fromEmail, @to, @cc, @subject, @snippet, @date,
         @labels, @listId, @listUnsub, @rfcId, @refs, @size)
       ON CONFLICT(account_id, gmail_message_id) DO UPDATE SET thread_id = excluded.thread_id, from_name = excluded.from_name,
         from_email = excluded.from_email, to_json = excluded.to_json, cc_json = excluded.cc_json, subject = excluded.subject,
         snippet = excluded.snippet, date = excluded.date, label_ids_json = excluded.label_ids_json, list_id = excluded.list_id,
         has_list_unsubscribe = excluded.has_list_unsubscribe, rfc822_message_id = excluded.rfc822_message_id,
         references_hdr = excluded.references_hdr, size_estimate = excluded.size_estimate`,
    );
    for (const { p } of msgs) {
      upsert.run({
        id: `${accountId}:${p.gmailMessageId}`,
        threadId: id,
        accountId,
        gmailMessageId: p.gmailMessageId,
        fromName: p.from.name,
        fromEmail: p.from.email || null,
        to: JSON.stringify(p.to),
        cc: JSON.stringify(p.cc),
        subject: p.subject,
        snippet: p.snippet,
        date: p.date,
        labels: JSON.stringify(p.labelIds),
        listId: p.listId,
        listUnsub: p.hasListUnsubscribe ? 1 : 0,
        rfcId: p.rfc822MessageId,
        refs: p.references,
        size: p.sizeEstimate,
      });
    }
    if (removed) {
      db.prepare('DELETE FROM messages WHERE thread_id = ? AND gmail_message_id NOT IN (SELECT value FROM json_each(?))').run(id, JSON.stringify(msgs.map((m) => m.p.gmailMessageId)));
    }

    // Review Focus 3: a reply from someone else cancels Done and any snooze that predates it. A Done thread
    // keeps Gmail's state (a filter may have archived the reply). A snoozed thread always comes back: in the
    // inbox the snooze is simply dropped; if a filter archived the reply, the snooze falls due now and the
    // scheduler puts it back in the inbox and takes SuperMail/Snoozed off.
    const replyAt = Math.max(0, ...added.filter((m) => !isOwn(m.p)).map((m) => arrivedAt(m.raw, m.p)));
    if (prev && replyAt > 0) {
      if (prev.done_at !== null && replyAt > prev.done_at) db.prepare('UPDATE threads SET done_at = NULL WHERE id = ?').run(id);
      if (msgs.some((m) => m.p.labelIds.includes('INBOX'))) db.prepare('DELETE FROM snoozes WHERE thread_id = ? AND created_at < ?').run(id, replyAt);
      else db.prepare('UPDATE snoozes SET until = min(until, ?) WHERE thread_id = ? AND created_at < ?').run(replyAt, id, replyAt);
    }

    // CONFIRMED #1: a thread the index lacks is new mail only if it holds mail received after the index's
    // newest. Otherwise it is archived history touched in Gmail (a label, a bulk mark-read) and only 'changed'.
    const mark = readArrivalMark(db, accountId);
    if (mode === 'live') {
      const historyId = db.prepare('SELECT history_id FROM accounts WHERE id = ?').pluck().get(accountId) as string | null | undefined;
      if (mark.historyId !== (historyId ?? null)) Object.assign(mark, { historyId: historyId ?? null, base: mark.max });
    }
    const newest = Math.max(...msgs.map((m) => receivedAt(m.raw, m.p)));
    const isNewMail = mode === 'live' && (prev ? added.length > 0 : newest > mark.base - ARRIVAL_SLACK_MS);
    mark.max = Math.max(mark.max, newest);
    db.prepare('INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT DO UPDATE SET value = excluded.value').run(arrivalKey(accountId), JSON.stringify(mark));

    if (!prev || added.length > 0) return isNewMail ? 'new' : 'changed';
    return labelsChanged || removed ? 'changed' : null;
  })();

  if (changed && onChange) onChange(id, changed);
  return id;
}

export function removeThread(db: DB, accountId: string, gmailThreadId: string): void {
  db.prepare('DELETE FROM threads WHERE account_id = ? AND gmail_thread_id = ?').run(accountId, gmailThreadId);
}
