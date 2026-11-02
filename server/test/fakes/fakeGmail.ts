import type { gmail_v1 } from 'googleapis';
import { GmailAuthRevoked, GmailHistoryExpired, GmailLabelExists, type GmailApi, METADATA_HEADERS } from '../../src/google/gmailApi.js';

/**
 * In-memory Gmail used by every server test. It mimics the parts of the Gmail API SuperMail relies on:
 * a monotonically increasing historyId, a history log (messagesAdded / messagesDeleted / labelsAdded /
 * labelsRemoved), thread-level label changes, `q` search, labels, filters, sending and attachments.
 */

export interface FakeAttachment { filename: string; mimeType?: string; data: string | Buffer }

export interface FakeMessage {
  id?: string;
  /** RFC 5322 From header value, e.g. `"Bolt" <receipts@bolt.eu>`. */
  from: string;
  to?: string;
  cc?: string;
  subject: string;
  snippet?: string;
  /** Epoch ms; used for the Date header and internalDate. Defaults to the fake's clock. */
  date?: number;
  /** Label ids or names. Unknown non-system names become user labels. Defaults to `['INBOX', 'UNREAD']`. */
  labelIds?: string[];
  listId?: string;
  listUnsubscribe?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  text?: string;
  html?: string;
  attachments?: FakeAttachment[];
  /** Extra raw headers. */
  headers?: Record<string, string>;
}

export interface FakeThread { id: string; messages: FakeMessage[] }

export interface FakeGmailCalls {
  modifyThread: [string, string[], string[]][];
  sendRaw: string[];
  createLabel: string[];
  /** Every API method invoked, in order (including ones that threw). */
  all: string[];
}

export type FakeGmail = GmailApi & {
  readonly email: string;
  calls: FakeGmailCalls;
  addThread(t: FakeThread): void;
  deliver(threadId: string, msg: FakeMessage): string;
  /** An out-of-band label change, e.g. the owner in the Gmail app. With `viaApp: false` it is recorded as our own modifyThread call. */
  setLabels(threadId: string, add: string[], remove: string[], viaApp?: boolean): void;
  deleteMessage(messageId: string): void;
  deleteThread(threadId: string): void;
  expireHistory(): void;
  revoke(): void;
  /** Creates (or returns) a user label without recording a createLabel call. */
  addLabel(name: string): string;
  labelId(name: string): string | undefined;
  setFilters(filters: gmail_v1.Schema$Filter[]): void;
  currentHistoryId(): number;
  hasThread(threadId: string): boolean;
  threadLabels(threadId: string): string[];
};

export interface FakeGmailOptions { now?: () => number; startHistoryId?: number; pageSize?: number }

interface StoredAttachment { attachmentId: string; filename: string; mimeType: string; data: Buffer }

interface StoredMessage {
  id: string;
  threadId: string;
  labelIds: Set<string>;
  headers: { name: string; value: string }[];
  snippet: string;
  internalDate: number;
  historyId: number;
  text?: string;
  html?: string;
  attachments: StoredAttachment[];
}

const SYSTEM_LABELS = ['INBOX', 'UNREAD', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'STARRED', 'IMPORTANT', 'CHAT', 'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'];
const DAY_MS = 86_400_000;

function notFound(what: string): Error {
  return Object.assign(new Error(`${what} not found`), { code: 404, status: 404 });
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');

export function createFakeGmail(email: string, opts: FakeGmailOptions = {}): FakeGmail {
  const now = opts.now ?? (() => Date.now());
  const pageSize = opts.pageSize ?? 100;
  let historyId = opts.startHistoryId ?? 1000;
  let historyFloor = 0;
  let revoked = false;
  let seq = 0;
  let labelSeq = 0;
  const threads = new Map<string, StoredMessage[]>();
  const messages = new Map<string, StoredMessage>();
  const history: gmail_v1.Schema$History[] = [];
  const labels = new Map<string, { id: string; name: string; type: 'system' | 'user' }>(SYSTEM_LABELS.map((l) => [l, { id: l, name: l, type: 'system' as const }]));
  let filters: gmail_v1.Schema$Filter[] = [];
  const calls: FakeGmailCalls = { modifyThread: [], sendRaw: [], createLabel: [], all: [] };

  const nextId = (prefix: string) => `${prefix}${(++seq).toString(16).padStart(6, '0')}`;

  function enter(method: string): void {
    calls.all.push(method);
    if (revoked) throw new GmailAuthRevoked('invalid_grant');
  }

  function labelId(nameOrId: string): string | undefined {
    if (labels.has(nameOrId)) return nameOrId;
    const lower = nameOrId.toLowerCase();
    for (const l of labels.values()) if (l.name.toLowerCase() === lower) return l.id;
    return undefined;
  }

  function addLabel(name: string): string {
    const existing = labelId(name);
    if (existing) return existing;
    const id = `Label_${++labelSeq}`;
    labels.set(id, { id, name, type: 'user' });
    return id;
  }

  function resolveLabels(ids: string[]): string[] {
    return ids.map((l) => labelId(l) ?? addLabel(l));
  }

  function record(entry: Omit<gmail_v1.Schema$History, 'id'>, msgs: StoredMessage[]): void {
    historyId += 1;
    for (const m of msgs) m.historyId = historyId;
    history.push({ id: String(historyId), messages: msgs.map((m) => ({ id: m.id, threadId: m.threadId })), ...entry });
  }

  function store(threadId: string, msg: FakeMessage): StoredMessage {
    const id = msg.id ?? nextId('m');
    const date = msg.date ?? now();
    const headers: { name: string; value: string }[] = [
      { name: 'From', value: msg.from },
      { name: 'To', value: msg.to ?? email },
      ...(msg.cc ? [{ name: 'Cc', value: msg.cc }] : []),
      { name: 'Subject', value: msg.subject },
      { name: 'Date', value: new Date(date).toUTCString().replace('GMT', '+0000') },
      { name: 'Message-ID', value: msg.messageId ?? `<${id}@fake.mail>` },
      ...(msg.listId ? [{ name: 'List-Id', value: msg.listId }] : []),
      ...(msg.listUnsubscribe ? [{ name: 'List-Unsubscribe', value: msg.listUnsubscribe }] : []),
      ...(msg.inReplyTo ? [{ name: 'In-Reply-To', value: msg.inReplyTo }] : []),
      ...(msg.references ? [{ name: 'References', value: msg.references }] : []),
      ...Object.entries(msg.headers ?? {}).map(([name, value]) => ({ name, value })),
    ];
    const stored: StoredMessage = {
      id,
      threadId,
      labelIds: new Set(resolveLabels(msg.labelIds ?? ['INBOX', 'UNREAD'])),
      headers,
      snippet: msg.snippet ?? (msg.text ?? msg.subject).slice(0, 120),
      internalDate: date,
      historyId,
      text: msg.text ?? (msg.html ? undefined : msg.snippet ?? msg.subject),
      html: msg.html,
      attachments: (msg.attachments ?? []).map((a) => ({
        attachmentId: nextId('att'),
        filename: a.filename,
        mimeType: a.mimeType ?? 'application/octet-stream',
        data: Buffer.from(a.data),
      })),
    };
    messages.set(id, stored);
    const list = threads.get(threadId) ?? [];
    list.push(stored);
    list.sort((a, b) => a.internalDate - b.internalDate);
    threads.set(threadId, list);
    return stored;
  }

  function threadOrThrow(id: string): StoredMessage[] {
    const t = threads.get(id);
    if (!t || t.length === 0) throw notFound(`thread ${id}`);
    return t;
  }

  function applyLabels(threadId: string, add: string[], remove: string[]): void {
    const msgs = threadOrThrow(threadId);
    const addIds = resolveLabels(add);
    const removeIds = remove.map((l) => labelId(l)).filter((l): l is string => !!l);
    const added: gmail_v1.Schema$HistoryLabelAdded[] = [];
    const removed: gmail_v1.Schema$HistoryLabelRemoved[] = [];
    const touched: StoredMessage[] = [];
    for (const m of msgs) {
      const a = addIds.filter((l) => !m.labelIds.has(l));
      const r = removeIds.filter((l) => m.labelIds.has(l) && !addIds.includes(l));
      for (const l of a) m.labelIds.add(l);
      for (const l of r) m.labelIds.delete(l);
      if (a.length) added.push({ message: { id: m.id, threadId, labelIds: [...m.labelIds] }, labelIds: a });
      if (r.length) removed.push({ message: { id: m.id, threadId, labelIds: [...m.labelIds] }, labelIds: r });
      if (a.length || r.length) touched.push(m);
    }
    if (touched.length) record({ ...(added.length ? { labelsAdded: added } : {}), ...(removed.length ? { labelsRemoved: removed } : {}) }, touched);
  }

  function header(m: StoredMessage, name: string): string | undefined {
    return m.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
  }

  function toApiMessage(m: StoredMessage, format: 'metadata' | 'full'): gmail_v1.Schema$Message {
    const base = { id: m.id, threadId: m.threadId, labelIds: [...m.labelIds], snippet: m.snippet, historyId: String(m.historyId), internalDate: String(m.internalDate), sizeEstimate: 500 + (m.html?.length ?? 0) + (m.text?.length ?? 0) + m.attachments.reduce((s, a) => s + a.data.length, 0) };
    const mimeType = m.attachments.length ? 'multipart/mixed' : 'multipart/alternative';
    if (format === 'metadata') {
      const wanted = new Set(METADATA_HEADERS.map((h) => h.toLowerCase()));
      return { ...base, payload: { partId: '', mimeType, filename: '', headers: m.headers.filter((h) => wanted.has(h.name.toLowerCase())) } };
    }
    const bodyParts: gmail_v1.Schema$MessagePart[] = [];
    if (m.text !== undefined) bodyParts.push({ partId: '0.0', mimeType: 'text/plain', filename: '', headers: [], body: { size: m.text.length, data: b64url(m.text) } });
    if (m.html !== undefined) bodyParts.push({ partId: '0.1', mimeType: 'text/html', filename: '', headers: [], body: { size: m.html.length, data: b64url(m.html) } });
    const alternative: gmail_v1.Schema$MessagePart = { partId: '0', mimeType: 'multipart/alternative', filename: '', headers: [], body: { size: 0 }, parts: bodyParts };
    const attachmentParts = m.attachments.map((a, i) => ({ partId: String(i + 1), mimeType: a.mimeType, filename: a.filename, headers: [], body: { attachmentId: a.attachmentId, size: a.data.length } }));
    const payload: gmail_v1.Schema$MessagePart = m.attachments.length
      ? { partId: '', mimeType, filename: '', headers: m.headers, body: { size: 0 }, parts: [alternative, ...attachmentParts] }
      : { ...alternative, partId: '', headers: m.headers };
    return { ...base, payload };
  }

  /** Gmail search over messages; a thread matches when any of its messages matches every term. */
  function matches(m: StoredMessage, q: string | undefined, labelFilter: string[] | undefined): boolean {
    const terms = (q ?? '').match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
    const explicitIn = new Set<string>();
    for (const raw of terms) {
      const neg = raw.startsWith('-');
      const term = (neg ? raw.slice(1) : raw).toLowerCase();
      let ok: boolean;
      const age = /^(newer_than|older_than):(\d+)([dmy])$/.exec(term);
      if (age) {
        const unit = age[3] === 'd' ? DAY_MS : age[3] === 'm' ? 30 * DAY_MS : 365 * DAY_MS;
        const cutoff = now() - Number(age[2]) * unit;
        ok = age[1] === 'newer_than' ? m.internalDate > cutoff : m.internalDate <= cutoff;
      } else if (term.startsWith('in:') || term.startsWith('label:')) {
        const name = term.slice(term.indexOf(':') + 1);
        if (name === 'anywhere') ok = true;
        else {
          explicitIn.add(name.toUpperCase());
          const id = labelId(name.toUpperCase()) ?? labelId(name);
          ok = !!id && m.labelIds.has(id);
        }
      } else if (term === 'is:unread') ok = m.labelIds.has('UNREAD');
      else if (term.startsWith('from:')) ok = (header(m, 'From') ?? '').toLowerCase().includes(term.slice(5));
      else if (term.startsWith('to:')) ok = (header(m, 'To') ?? '').toLowerCase().includes(term.slice(3));
      else if (term.startsWith('subject:')) ok = (header(m, 'Subject') ?? '').toLowerCase().includes(term.slice(8).replace(/"/g, ''));
      else {
        const needle = term.replace(/"/g, '');
        ok = [header(m, 'Subject'), header(m, 'From'), m.snippet, m.text, m.html].some((v) => v?.toLowerCase().includes(needle));
      }
      if (neg ? ok : !ok) return false;
    }
    // Like Gmail, spam and trash only show up when asked for.
    for (const hidden of ['SPAM', 'TRASH']) if (m.labelIds.has(hidden) && !explicitIn.has(hidden)) return false;
    return (labelFilter ?? []).every((l) => m.labelIds.has(labelId(l) ?? l));
  }

  const api: FakeGmail = {
    email,
    calls,

    addThread(t) {
      for (const msg of t.messages) store(t.id, msg);
    },

    deliver(threadId, msg) {
      const m = store(threadId, msg);
      record({ messagesAdded: [{ message: { id: m.id, threadId, labelIds: [...m.labelIds] } }] }, [m]);
      return m.id;
    },

    setLabels(threadId, add, remove, viaApp = true) {
      if (!viaApp) calls.modifyThread.push([threadId, add, remove]);
      applyLabels(threadId, add, remove);
    },

    deleteMessage(messageId) {
      const m = messages.get(messageId);
      if (!m) throw notFound(`message ${messageId}`);
      messages.delete(messageId);
      const rest = (threads.get(m.threadId) ?? []).filter((x) => x.id !== messageId);
      if (rest.length) threads.set(m.threadId, rest);
      else threads.delete(m.threadId);
      record({ messagesDeleted: [{ message: { id: m.id, threadId: m.threadId, labelIds: [...m.labelIds] } }] }, [m]);
    },

    deleteThread(threadId) {
      for (const m of [...threadOrThrow(threadId)]) api.deleteMessage(m.id);
    },

    expireHistory() {
      historyFloor = historyId; // a historyId captured from getProfile after this stays valid, as in Gmail
      history.length = 0;
    },

    revoke() {
      revoked = true;
    },

    addLabel,
    labelId,

    setFilters(f) {
      filters = f;
    },

    currentHistoryId: () => historyId,
    hasThread: (id) => (threads.get(id)?.length ?? 0) > 0,
    threadLabels: (id) => [...new Set(threadOrThrow(id).flatMap((m) => [...m.labelIds]))],

    async getProfile() {
      enter('getProfile');
      return { emailAddress: email, historyId: String(historyId) };
    },

    async listThreads(p) {
      enter('listThreads');
      const ids = [...threads.entries()]
        .filter(([, msgs]) => msgs.some((m) => matches(m, p.q, p.labelIds)))
        .sort((a, b) => Math.max(...b[1].map((m) => m.internalDate)) - Math.max(...a[1].map((m) => m.internalDate)))
        .map(([id]) => id);
      const start = p.pageToken ? Number(p.pageToken) : 0;
      const size = p.maxResults ?? pageSize;
      const page = ids.slice(start, start + size);
      return start + size < ids.length ? { ids: page, nextPageToken: String(start + size) } : { ids: page };
    },

    async getThread(id, format) {
      enter('getThread');
      const msgs = threadOrThrow(id);
      return { id, historyId: String(Math.max(...msgs.map((m) => m.historyId))), snippet: msgs.at(-1)?.snippet, messages: msgs.map((m) => toApiMessage(m, format)) };
    },

    async listHistory(startHistoryId, pageToken) {
      enter('listHistory');
      if (Number(startHistoryId) < historyFloor) throw new GmailHistoryExpired(`history ${startHistoryId} expired`);
      const entries = history.filter((h) => Number(h.id) > Number(startHistoryId));
      const start = pageToken ? Number(pageToken) : 0;
      const page = entries.slice(start, start + pageSize);
      const result = { history: page, historyId: String(historyId) };
      return start + pageSize < entries.length ? { ...result, nextPageToken: String(start + pageSize) } : result;
    },

    async modifyThread(id, add, remove) {
      enter('modifyThread');
      threadOrThrow(id);
      calls.modifyThread.push([id, add, remove]);
      applyLabels(id, add, remove);
    },

    async listLabels() {
      enter('listLabels');
      return [...labels.values()].map((l) => ({ ...l }));
    },

    async createLabel(name) {
      enter('createLabel');
      if (labelId(name) && labels.get(labelId(name)!)!.type === 'user') throw new GmailLabelExists(`label ${name} exists`);
      calls.createLabel.push(name);
      const id = addLabel(name);
      return { id, name };
    },

    async sendRaw(raw, threadId) {
      enter('sendRaw');
      calls.sendRaw.push(raw);
      const mime = Buffer.from(raw, 'base64url').toString('utf8');
      const [head = '', ...bodyParts] = mime.split(/\r?\n\r?\n/);
      const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
      const get = (name: string) => new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(unfolded)?.[1]?.trim();
      const tid = threadId && threads.has(threadId) ? threadId : nextId('t');
      const m = store(tid, {
        from: get('From') ?? email,
        to: get('To') ?? '',
        cc: get('Cc'),
        subject: get('Subject') ?? '',
        messageId: get('Message-ID'),
        inReplyTo: get('In-Reply-To'),
        references: get('References'),
        text: bodyParts.join('\n\n'),
        labelIds: ['SENT'],
      });
      record({ messagesAdded: [{ message: { id: m.id, threadId: tid, labelIds: [...m.labelIds] } }] }, [m]);
      return { id: m.id, threadId: tid };
    },

    async getAttachment(messageId, attachmentId) {
      enter('getAttachment');
      const a = messages.get(messageId)?.attachments.find((x) => x.attachmentId === attachmentId);
      if (!a) throw notFound(`attachment ${attachmentId}`);
      return Buffer.from(a.data);
    },

    async listFilters() {
      enter('listFilters');
      return structuredClone(filters);
    },
  };
  return api;
}
