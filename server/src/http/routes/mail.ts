import type { SendRequest } from '@supermail/shared';
import { HttpError } from '../../errors.js';
import { findAttachment, getThreadDetail } from '../../mail/bodies.js';
import { send } from '../../mail/compose.js';
import { search } from '../../mail/search.js';
import { isNotFound } from '../../sync/initialSync.js';
import type { RoutePlugin } from '../app.js';

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const optString = (v: unknown) => v === undefined || typeof v === 'string';

function parseSend(body: unknown): SendRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  const cc = b.cc ?? [];
  const bcc = b.bcc ?? [];
  if (
    typeof b.accountId !== 'string' || !isStringArray(b.to) || !isStringArray(cc) || !isStringArray(bcc) ||
    typeof b.subject !== 'string' || typeof b.text !== 'string' ||
    !optString(b.replyToThreadId) || !optString(b.replyToMessageId) || !(b.forward === undefined || typeof b.forward === 'boolean')
  ) {
    throw new HttpError(400, 'invalid send request');
  }
  return {
    accountId: b.accountId,
    to: b.to,
    cc,
    bcc,
    subject: b.subject,
    text: b.text,
    ...(b.replyToThreadId ? { replyToThreadId: b.replyToThreadId as string } : {}),
    ...(b.replyToMessageId ? { replyToMessageId: b.replyToMessageId as string } : {}),
    ...(b.forward ? { forward: true } : {}),
  };
}

/** `filename*` (RFC 5987) for any name, plus an ASCII-only `filename` fallback. */
function contentDisposition(filename: string, inline: boolean): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Types a browser shows passively (no script can run in them), so they open in a tab. Everything else, and
 * in particular HTML and SVG, is always a download. No `sandbox` CSP: Chrome blocks downloads from a
 * sandboxed response and its PDF viewer refuses to run under one.
 */
const VIEWABLE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'text/plain']);

/**
 * `GET /api/threads/:id` (detail; the client marks it read separately) · `POST /api/send` ·
 * `GET /api/search?q` · `GET /api/attachments/:accountId/:gmailMessageId/:attachmentId`.
 */
export const mailRoutes: RoutePlugin = async (app, deps) => {
  app.get('/api/threads/:id', async (req) => {
    const { id } = req.params as { id: string };
    return getThreadDetail(deps, id);
  });

  app.post('/api/send', async (req) => send(deps, parseSend(req.body)));

  app.get('/api/search', async (req) => {
    const { q } = req.query as { q?: unknown };
    if (typeof q !== 'string' || !q.trim()) throw new HttpError(400, 'missing q');
    return search(deps, q);
  });

  // Attachments come straight from Gmail into the response; nothing is written to disk. PDFs, images and plain
  // text open in the browser (?download=1 forces a download); everything else is always a download.
  app.get('/api/attachments/:accountId/:gmailMessageId/:attachmentId', async (req, reply) => {
    const { accountId, gmailMessageId, attachmentId } = req.params as { accountId: string; gmailMessageId: string; attachmentId: string };
    const query = req.query as { download?: string; name?: string };
    const meta = await findAttachment(deps, accountId, gmailMessageId, attachmentId, typeof query.name === 'string' ? query.name : undefined);
    if (!meta) throw new HttpError(404, 'attachment not found');
    const mime = meta.mimeType.toLowerCase().split(';')[0]!.trim();
    const inline = VIEWABLE.has(mime) && query.download !== '1';
    let data: Buffer;
    try {
      data = await deps.gmailFor(accountId).getAttachment(gmailMessageId, meta.fetchId);
    } catch (err) {
      if (isNotFound(err)) throw new HttpError(404, 'attachment not found');
      throw err;
    }
    // Chrome's PDF viewer will not start under a restrictive CSP, so an inline PDF gets none; everything else
    // (images, text, downloads) is locked down.
    if (!(inline && mime === 'application/pdf')) reply.header('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    return reply
      .header('content-type', meta.mimeType)
      .header('content-disposition', contentDisposition(meta.filename, inline))
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .send(data);
  });
};
