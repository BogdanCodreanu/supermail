import type { AddressDTO, SendRequest, ThreadId } from '@supermail/shared';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { HttpError } from '../errors.js';
import { parseAddress } from '../google/parse.js';
import type { AppDeps } from '../http/app.js';
import { indexThread, ownEmailsOf } from '../sync/indexer.js';
import { bodyAsText, getThreadDetail } from './bodies.js';

export interface ReplyContext { rfc822MessageId: string; references: string | null; subject: string; quotedText: string }

const RE = /^\s*re\s*:/i;
const FWD = /^\s*(fwd?|fw)\s*:/i;

function subjectFor(r: SendRequest, reply?: ReplyContext): string {
  const subject = (r.subject.trim() || reply?.subject.trim() || '').replace(/\s+/g, ' ');
  if (!reply) return subject;
  if (r.forward) return FWD.test(subject) ? subject : `Fwd: ${subject}`;
  return RE.test(subject) ? subject.replace(RE, 'Re:') : `Re: ${subject}`;
}

/** Builds the MIME message (plain text) and returns it base64url-encoded for `users.messages.send`. */
export async function buildRaw(r: SendRequest, from: AddressDTO, reply?: ReplyContext): Promise<string> {
  const parent = reply?.rfc822MessageId.trim() || undefined;
  const references = parent ? [...(reply?.references?.split(/\s+/).filter(Boolean) ?? []).filter((id) => id !== parent), parent] : undefined;
  const text = reply?.quotedText ? `${r.text.replace(/\s+$/, '')}\n\n${reply.quotedText}\n` : r.text;
  const node = new MailComposer({
    from: from.name ? { name: from.name, address: from.email } : from.email,
    to: r.to,
    cc: r.cc.length ? r.cc : undefined,
    bcc: r.bcc.length ? r.bcc : undefined,
    subject: subjectFor(r, reply),
    text,
    inReplyTo: parent,
    references,
  }).compile();
  // Gmail reads Bcc from the raw message and strips it before delivery, so it must stay in.
  node.keepBcc = true;
  return (await node.build()).toString('base64url');
}

const CRLF = /[\r\n]/;

function validate(r: SendRequest): void {
  const recipients = [...r.to, ...r.cc, ...r.bcc];
  if (recipients.length === 0) throw new HttpError(400, 'add at least one recipient');
  for (const raw of recipients) {
    if (CRLF.test(raw)) throw new HttpError(400, 'invalid recipient');
    const email = parseAddress(raw).email;
    if (!/^[^\s@<>,;"]+@[^\s@<>,;"]+$/.test(email)) throw new HttpError(400, `invalid recipient: ${raw}`);
  }
  if (CRLF.test(r.subject)) throw new HttpError(400, 'invalid subject');
}

function formatAddress(a: AddressDTO): string {
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

interface ParentRow { id: string; gmail_message_id: string; from_email: string | null; label_ids_json: string; rfc822_message_id: string | null; references_hdr: string | null; subject: string }

/** Reply or forward context: the parent message's ids and the quoted original as plain text. */
async function replyContext(d: AppDeps, threadId: ThreadId, replyToMessageId: string | undefined, forward: boolean): Promise<ReplyContext> {
  const detail = await getThreadDetail(d, threadId);
  const rows = d.db
    .prepare('SELECT id, gmail_message_id, from_email, label_ids_json, rfc822_message_id, references_hdr, subject FROM messages WHERE thread_id = ? ORDER BY date, id')
    .all(threadId) as ParentRow[];
  const own = ownEmailsOf(d.db);
  const isOwn = (r: ParentRow) => own.has((r.from_email ?? '').toLowerCase()) || (JSON.parse(r.label_ids_json) as string[]).includes('SENT');
  // replyToMessageId may be a MessageDTO id (`account:gmailId`) or a bare Gmail message id. By default reply to
  // the latest message from someone else, the one whose sender the client prefills.
  const parent = replyToMessageId
    ? rows.find((r) => r.id === replyToMessageId || r.gmail_message_id === replyToMessageId)
    : ([...rows].reverse().find((r) => !isOwn(r)) ?? rows.at(-1));
  if (!parent) throw new HttpError(404, `message ${replyToMessageId ?? ''} not found in thread`);
  const msg = detail.messages.find((m) => m.id === parent.id)!;
  const original = bodyAsText(msg);
  const quotedText = forward
    ? [
        '---------- Forwarded message ---------',
        `From: ${formatAddress(msg.from)}`,
        `Date: ${formatDate(msg.date)}`,
        `Subject: ${msg.subject}`,
        `To: ${msg.to.map(formatAddress).join(', ')}`,
        ...(msg.cc.length ? [`Cc: ${msg.cc.map(formatAddress).join(', ')}`] : []),
        '',
        original,
      ].join('\n')
    : `On ${formatDate(msg.date)}, ${formatAddress(msg.from)} wrote:\n${original.split(/\r?\n/).map((l) => (l ? `> ${l}` : '>')).join('\n')}`;
  return { rfc822MessageId: parent.rfc822_message_id ?? '', references: parent.references_hdr, subject: parent.subject || detail.thread.subject, quotedText };
}

/**
 * Sends a new message, reply or forward. Replies and forwards go out from the account that received the
 * thread, into the same Gmail thread. The thread is reindexed afterwards so the sent message shows at once.
 */
export async function send(d: AppDeps, r: SendRequest): Promise<{ threadId: ThreadId }> {
  validate(r);
  let accountId = r.accountId;
  let gmailThreadId: string | undefined;
  if (r.replyToThreadId) {
    const t = d.db.prepare('SELECT account_id, gmail_thread_id FROM threads WHERE id = ?').get(r.replyToThreadId) as { account_id: string; gmail_thread_id: string } | undefined;
    if (!t) throw new HttpError(404, `thread ${r.replyToThreadId} not found`);
    accountId = t.account_id;
    gmailThreadId = t.gmail_thread_id;
  }
  const email = d.db.prepare('SELECT email FROM accounts WHERE id = ?').pluck().get(accountId) as string | undefined;
  if (!email) throw new HttpError(404, `account ${accountId} not found`);

  const reply = r.replyToThreadId ? await replyContext(d, r.replyToThreadId, r.replyToMessageId, !!r.forward) : undefined;
  const raw = await buildRaw(r, { name: null, email }, reply);
  const gmail = d.gmailFor(accountId);
  const sent = await gmail.sendRaw(raw, gmailThreadId);
  const threadId: ThreadId = `${accountId}:${sent.threadId}`;

  // The owner's own message is a change to the thread, not new mail. If this fails the poller catches up.
  try {
    const thread = await gmail.getThread(sent.threadId, 'metadata');
    indexThread(d.db, accountId, { ...thread, id: thread.id ?? sent.threadId }, ownEmailsOf(d.db), d.onThreadChange, 'sync');
  } catch {
    /* the history poller will index it */
  }
  return { threadId };
}
