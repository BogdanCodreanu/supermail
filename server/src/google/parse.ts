import type { AddressDTO } from '@supermail/shared';
import type { gmail_v1 } from 'googleapis';

export interface ParsedMessage { gmailMessageId: string; gmailThreadId: string; from: AddressDTO; to: AddressDTO[]; cc: AddressDTO[]; subject: string; snippet: string; date: number; labelIds: string[]; listId: string | null; hasListUnsubscribe: boolean; rfc822MessageId: string | null; references: string | null; sizeEstimate: number; hasAttachments: boolean }

/** Case-insensitive header lookup on a message's top-level payload. */
export function header(m: gmail_v1.Schema$Message, name: string): string | undefined {
  const lower = name.toLowerCase();
  return m.payload?.headers?.find((h) => h.name?.toLowerCase() === lower)?.value ?? undefined;
}

/** Decodes RFC 2047 encoded words (`=?UTF-8?B?...?=` / `?Q?`). Gmail usually decodes these, but not always. */
export function decodeWords(s: string): string {
  return s.replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=(\s+(?==\?))?/g, (_all, charset: string, enc: string, text: string) => {
    const bytes = enc.toUpperCase() === 'B'
      ? Buffer.from(text, 'base64')
      : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1');
    try {
      return new TextDecoder(charset.toLowerCase()).decode(bytes);
    } catch {
      return bytes.toString('utf8');
    }
  });
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\(.)/g, '$1');
  return t;
}

/** Parses one RFC 5322 mailbox: `"Name" <a@b>`, `Name <a@b>`, `<a@b>` or `a@b`. Emails are lowercased. */
export function parseAddress(raw: string): AddressDTO {
  const s = decodeWords(raw.trim());
  const angle = /^(.*)<([^<>]*)>\s*$/.exec(s);
  if (angle) {
    const name = unquote(angle[1] ?? '').trim();
    return { name: name || null, email: (angle[2] ?? '').trim().toLowerCase() };
  }
  return { name: null, email: unquote(s).toLowerCase() };
}

/** Splits an address list on commas that are outside quotes and angle brackets. */
export function parseAddressList(raw: string | null | undefined): AddressDTO[] {
  if (!raw) return [];
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  let angle = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === '\\' && quoted) {
      cur += c + (raw[++i] ?? '');
      continue;
    }
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === '<') angle = true;
    else if (!quoted && c === '>') angle = false;
    if (c === ',' && !quoted && !angle) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  parts.push(cur);
  return parts.filter((p) => p.trim()).map(parseAddress).filter((a) => a.email);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Gmail snippets are HTML-escaped; turn them back into plain text. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

function parseDate(raw: string | undefined): number | null {
  if (!raw) return null;
  const t = Date.parse(raw.replace(/\s*\([^)]*\)\s*$/, '').trim());
  return Number.isFinite(t) ? t : null;
}

function anyFilename(p: gmail_v1.Schema$MessagePart | undefined): boolean {
  if (!p) return false;
  if (p.filename) return true;
  return (p.parts ?? []).some(anyFilename);
}

/** Pulls the id out of `Name <list.id>`, lowercased. */
function parseListId(raw: string | undefined): string | null {
  if (!raw) return null;
  const inner = /<([^<>]+)>/.exec(raw)?.[1] ?? raw;
  const id = inner.trim().toLowerCase();
  return id || null;
}

export function parseMessage(m: gmail_v1.Schema$Message): ParsedMessage {
  const internalDate = Number(m.internalDate ?? 0) || 0;
  const payload = m.payload;
  // Full format has parts with filenames. Metadata format has no parts, but multipart/mixed almost always means attachments.
  const hasAttachments = anyFilename(payload) || (!payload?.parts && payload?.mimeType?.toLowerCase() === 'multipart/mixed');
  const from = parseAddressList(header(m, 'From'))[0] ?? { name: null, email: '' };
  return {
    gmailMessageId: m.id ?? '',
    gmailThreadId: m.threadId ?? '',
    from,
    to: parseAddressList(header(m, 'To')),
    cc: parseAddressList(header(m, 'Cc')),
    subject: decodeWords(header(m, 'Subject') ?? ''),
    snippet: decodeEntities(m.snippet ?? ''),
    date: parseDate(header(m, 'Date')) ?? internalDate,
    labelIds: m.labelIds ?? [],
    listId: parseListId(header(m, 'List-Id')),
    hasListUnsubscribe: header(m, 'List-Unsubscribe') !== undefined,
    rfc822MessageId: header(m, 'Message-ID')?.trim() || null,
    references: header(m, 'References')?.trim() || header(m, 'In-Reply-To')?.trim() || null,
    sizeEstimate: m.sizeEstimate ?? 0,
    hasAttachments,
  };
}
