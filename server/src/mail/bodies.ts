import type { AddressDTO, AttachmentDTO, MessageDTO, ThreadDetailDTO, ThreadId } from '@supermail/shared';
import type { gmail_v1 } from 'googleapis';
import type { DB } from '../db/index.js';
import { HttpError } from '../errors.js';
import type { GmailApi } from '../google/gmailApi.js';
import { decodeEntities } from '../google/parse.js';
import type { AppDeps } from '../http/app.js';
import { indexThread, ownEmailsOf, removeThread } from '../sync/indexer.js';
import { isNotFound } from '../sync/initialSync.js';
import { toSummary } from '../threads/queries.js';

/** Bodies larger than this are served but never cached (Review Focus 5). */
export const MAX_CACHED_BODY_BYTES = 2 * 1024 * 1024;

export interface Body { html: string | null; text: string | null; attachments: AttachmentDTO[] }

interface MessageRow {
  id: string;
  gmail_message_id: string;
  from_name: string | null;
  from_email: string | null;
  to_json: string;
  cc_json: string;
  date: number;
  subject: string;
}

interface CacheRow { message_id: string; html: string | null; text: string | null; attachments_json: string }

function threadRef(db: DB, threadId: ThreadId): { accountId: string; gmailThreadId: string } {
  const row = db.prepare('SELECT account_id, gmail_thread_id FROM threads WHERE id = ?').get(threadId) as { account_id: string; gmail_thread_id: string } | undefined;
  if (!row) throw new HttpError(404, `thread ${threadId} not found`);
  return { accountId: row.account_id, gmailThreadId: row.gmail_thread_id };
}

function partHeader(p: gmail_v1.Schema$MessagePart, name: string): string | undefined {
  const lower = name.toLowerCase();
  return p.headers?.find((h) => h.name?.toLowerCase() === lower)?.value ?? undefined;
}

function decodeData(data: string | Buffer, contentType: string | undefined): string {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'base64url') : data;
  const charset = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType ?? '')?.[1]?.toLowerCase() ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

function isAttachmentPart(p: gmail_v1.Schema$MessagePart): boolean {
  return !!p.filename || /^\s*attachment/i.test(partHeader(p, 'Content-Disposition') ?? '');
}

/**
 * Extracts the first text/html and text/plain bodies and the downloadable attachments from a full-format
 * message. Large body parts that Gmail only exposes by attachmentId are fetched.
 */
export async function extractBody(gmail: GmailApi, m: gmail_v1.Schema$Message): Promise<Body> {
  let html: string | null = null;
  let text: string | null = null;
  const attachments: AttachmentDTO[] = [];
  const pending: Promise<void>[] = [];

  const walk = (p: gmail_v1.Schema$MessagePart | undefined) => {
    if (!p) return;
    const mime = (p.mimeType ?? '').toLowerCase();
    if (isAttachmentPart(p)) {
      if (p.body?.attachmentId) {
        attachments.push({ attachmentId: p.body.attachmentId, filename: p.filename || 'attachment', mimeType: p.mimeType || 'application/octet-stream', size: p.body.size ?? 0 });
      }
    } else if (mime === 'text/html' || mime === 'text/plain') {
      const isHtml = mime === 'text/html';
      if (isHtml ? html === null : text === null) {
        const set = (s: string) => (isHtml ? (html = s) : (text = s));
        set('');
        const contentType = partHeader(p, 'Content-Type');
        if (p.body?.data) set(decodeData(p.body.data, contentType));
        else if (p.body?.attachmentId && m.id) {
          pending.push(gmail.getAttachment(m.id, p.body.attachmentId).then((buf) => void set(decodeData(buf, contentType))));
        }
      }
    }
    for (const child of p.parts ?? []) walk(child);
  };
  walk(m.payload);
  await Promise.all(pending);
  return { html, text, attachments };
}

function cacheBytes(b: Body, attachmentsJson: string): number {
  return Buffer.byteLength(b.html ?? '') + Buffer.byteLength(b.text ?? '') + Buffer.byteLength(attachmentsJson);
}

/**
 * Loads the bodies of every message in a thread: from the cache where possible, otherwise from one
 * `getThread(full)` call, which also reindexes the thread so the message list is current. Bodies up to
 * MAX_CACHED_BODY_BYTES are cached while storage allows it.
 */
async function loadBodies(d: AppDeps, threadId: ThreadId): Promise<Map<string, Body>> {
  const { db } = d;
  const { accountId, gmailThreadId } = threadRef(db, threadId);
  const now = d.now();
  const messageIds = db.prepare('SELECT id FROM messages WHERE thread_id = ?').pluck().all(threadId) as string[];
  const cached = new Map(
    (db.prepare('SELECT b.message_id, b.html, b.text, b.attachments_json FROM body_cache b JOIN messages m ON m.id = b.message_id WHERE m.thread_id = ?').all(threadId) as CacheRow[])
      .map((r) => [r.message_id, { html: r.html, text: r.text, attachments: JSON.parse(r.attachments_json) as AttachmentDTO[] }]),
  );
  db.prepare('UPDATE body_cache SET last_accessed_at = ? WHERE message_id IN (SELECT id FROM messages WHERE thread_id = ?)').run(now, threadId);
  db.prepare('UPDATE threads SET last_accessed_at = ? WHERE id = ?').run(now, threadId);
  if (messageIds.length > 0 && messageIds.every((id) => cached.has(id))) return cached;

  const gmail = d.gmailFor(accountId);
  let full: gmail_v1.Schema$Thread;
  try {
    full = await gmail.getThread(gmailThreadId, 'full');
  } catch (err) {
    if (!isNotFound(err)) throw err;
    removeThread(db, accountId, gmailThreadId);
    throw new HttpError(404, `thread ${threadId} not found`);
  }
  indexThread(db, accountId, { ...full, id: full.id ?? gmailThreadId }, ownEmailsOf(db), d.onThreadChange, 'live');

  const known = new Set(db.prepare('SELECT id FROM messages WHERE thread_id = ?').pluck().all(threadId) as string[]);
  const canCache = d.storage.canCacheBodies();
  const insert = db.prepare(
    `INSERT INTO body_cache(message_id, html, text, attachments_json, bytes, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET html = excluded.html, text = excluded.text, attachments_json = excluded.attachments_json,
       bytes = excluded.bytes, last_accessed_at = excluded.last_accessed_at`,
  );
  const bodies = new Map<string, Body>();
  for (const m of full.messages ?? []) {
    const id = `${accountId}:${m.id ?? ''}`;
    if (!known.has(id)) continue; // drafts are not indexed
    const body = cached.get(id) ?? (await extractBody(gmail, m));
    bodies.set(id, body);
    if (cached.has(id) || !canCache) continue;
    const attachmentsJson = JSON.stringify(body.attachments);
    const bytes = cacheBytes(body, attachmentsJson);
    if (bytes <= MAX_CACHED_BODY_BYTES) insert.run(id, body.html, body.text, attachmentsJson, bytes, now);
  }
  return bodies;
}

const parseAddresses = (json: string): AddressDTO[] => JSON.parse(json) as AddressDTO[];

/** The thread summary plus every message (oldest first) with its body. Does not mark the thread read. */
export async function getThreadDetail(d: AppDeps, threadId: ThreadId): Promise<ThreadDetailDTO> {
  const bodies = await loadBodies(d, threadId);
  const rows = d.db
    .prepare('SELECT id, gmail_message_id, from_name, from_email, to_json, cc_json, date, subject FROM messages WHERE thread_id = ? ORDER BY date, id')
    .all(threadId) as MessageRow[];
  const messages: MessageDTO[] = rows.map((r) => {
    const body = bodies.get(r.id) ?? { html: null, text: null, attachments: [] };
    return {
      id: r.id,
      gmailMessageId: r.gmail_message_id,
      from: { name: r.from_name, email: r.from_email ?? '' },
      to: parseAddresses(r.to_json),
      cc: parseAddresses(r.cc_json),
      date: r.date,
      subject: r.subject,
      html: body.html,
      text: body.text,
      attachments: body.attachments,
    };
  });
  return { thread: toSummary(d.db, threadId), messages };
}

/** Plain text of a message for quoting: its text part, or its HTML flattened to text. */
export function bodyAsText(b: Pick<Body, 'html' | 'text'>): string {
  if (b.text !== null && b.text.trim()) return b.text;
  if (!b.html) return '';
  const flat = b.html
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(flat).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Finds an attachment's filename and type: from the body cache, else from a fresh full fetch of its thread.
 * `fetchId` is the attachmentId to download with: Gmail can hand out a different attachmentId on every fetch,
 * so after a fresh fetch it is the current one, matched by id, then by `name`, then by being the only one.
 * Returns undefined when the message is not in the index.
 */
export async function findAttachment(
  d: AppDeps,
  accountId: string,
  gmailMessageId: string,
  attachmentId: string,
  name?: string,
): Promise<{ filename: string; mimeType: string; fetchId: string } | undefined> {
  const row = d.db.prepare('SELECT m.id, t.gmail_thread_id FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.account_id = ? AND m.gmail_message_id = ?').get(accountId, gmailMessageId) as
    { id: string; gmail_thread_id: string } | undefined;
  if (!row) return undefined;
  const fallback = { filename: name || 'attachment', mimeType: 'application/octet-stream', fetchId: attachmentId };
  const cachedJson = d.db.prepare('SELECT attachments_json FROM body_cache WHERE message_id = ?').pluck().get(row.id) as string | undefined;
  const fromCache = cachedJson ? (JSON.parse(cachedJson) as AttachmentDTO[]).find((a) => a.attachmentId === attachmentId) : undefined;
  if (fromCache) return { filename: fromCache.filename, mimeType: fromCache.mimeType, fetchId: attachmentId };

  const gmail = d.gmailFor(accountId);
  const full = await gmail.getThread(row.gmail_thread_id, 'full');
  const message = full.messages?.find((m) => m.id === gmailMessageId);
  if (!message) return fallback;
  const parts: gmail_v1.Schema$MessagePart[] = [];
  const walk = (p: gmail_v1.Schema$MessagePart | undefined) => {
    if (!p) return;
    parts.push(p);
    for (const c of p.parts ?? []) walk(c);
  };
  walk(message.payload);
  const files = parts.filter((p) => p.filename && p.body?.attachmentId);
  const hit =
    parts.find((p) => p.body?.attachmentId === attachmentId) ??
    (name ? files.find((p) => p.filename === name) : undefined) ??
    (files.length === 1 ? files[0] : undefined);
  if (!hit) return fallback;
  return { filename: hit.filename || fallback.filename, mimeType: hit.mimeType || fallback.mimeType, fetchId: hit.body?.attachmentId ?? attachmentId };
}
