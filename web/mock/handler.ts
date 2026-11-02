import type {
  ActionResult,
  AddressDTO,
  BulkRequest,
  BulkResult,
  GroupDTO,
  MatchType,
  PushDeviceDTO,
  SendRequest,
  ServerEvent,
  TeachingDTO,
  TeachPreviewDTO,
  TeachBulkRequest,
  TeachRequest,
  TeachScopeDTO,
  ThreadDetailDTO,
  ThreadId,
  ThreadPage,
  ThreadSummaryDTO,
} from '@supermail/shared';
import { buildWorld, htmlToText, incomingThread, sentMessage, snippetOf, taughtReason, UNSORTED_REASON, type MockThread, type MockWorld } from './fixtures';
import { matchesTeaching, nextTeaching, seedTeachings, teachingGroup, teachingValue, type MockTeaching, type TeachingKey } from './teaching';

/**
 * An in-memory SuperMail server for UI work: every route in shared/src/api.ts, with the real server's
 * semantics (inbox order and cursor, undo with redo, `x-supermail` on writes). No Google, no disk.
 */

/** Same value as API_HEADER in shared/src/api.ts; the mock only imports types so Vite's config loader never needs it built. */
const API_HEADER = 'x-supermail';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MIN_SNOOZE_MS = 60_000;
const MAX_BULK_IDS = 1000;
const MAX_BULK_SENDERS = 50;
const BULK_ACTIONS = ['done', 'snooze', 'read', 'unread', 'move', 'spam'];
const SEARCH_LIMIT = 50;
const DONE_WINDOW_MS = 30 * 86_400_000;
/** A real P-256 public key, so a browser's `subscribe` takes it. Its private half was thrown away: nothing can push with it. */
const PUSH_PUBLIC_KEY = 'BHru85FvKsi3i_rphRqfQeC9W8QvZkmx98pEg9-5TSxtV1zZJIwFRr-fxbKhlDnaPoUS35TDfsC6DfCbC2tC-a4';
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'proton.me', 'protonmail.com']);

export interface MockRequest {
  method: string;
  /** Path and query, e.g. `/api/threads?groupId=dev`. */
  url: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface MockResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array;
}

export interface MockApi {
  handle(req: MockRequest): MockResponse;
  /** Live events, as the server's `/api/events` would send them. */
  subscribe(fn: (e: ServerEvent) => void): () => void;
  /** Delivers one new thread and surfaces due snoozes; the dev server calls it every 45 s. */
  tick(): ThreadSummaryDTO;
  readonly world: MockWorld;
}

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

type Snapshot = Pick<MockThread, 'inInbox' | 'unread' | 'groupId' | 'reason' | 'snoozedUntil' | 'surfacedAt' | 'skipped' | 'doneAt' | 'suggestRule'>;
interface UndoEntry { threadId: ThreadId; snapshots: Map<ThreadId, Snapshot>; bulk?: boolean }

const json = (status: number, data: unknown): MockResponse => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  body: data === undefined ? '' : JSON.stringify(data),
});

const sortKey = (t: MockThread) => Math.max(t.lastMessageAt, t.surfacedAt ?? 0);
const byInboxOrder = (a: MockThread, b: MockThread) => sortKey(b) - sortKey(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

function snapshot(t: MockThread): Snapshot {
  const { inInbox, unread, groupId, reason, snoozedUntil, surfacedAt, skipped, doneAt, suggestRule } = t;
  return { inInbox, unread, groupId, reason: { ...reason }, snoozedUntil, surfacedAt, skipped, doneAt, suggestRule };
}

function contentDisposition(filename: string, inline: boolean): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function header(req: MockRequest, name: string): string | undefined {
  const v = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${what} is required`);
  return v.trim();
}

const addresses = (list: unknown): AddressDTO[] =>
  (Array.isArray(list) ? list : []).filter((x): x is string => typeof x === 'string' && x.includes('@')).map((email) => ({ name: null, email }));

export function createMockApi(opts: { now?: () => number; world?: MockWorld } = {}): MockApi {
  const now = opts.now ?? Date.now;
  const world = opts.world ?? buildWorld(now());
  const listeners = new Set<(e: ServerEvent) => void>();
  const undos = new Map<string, UndoEntry>();
  let undoSeq = 0;
  let teachings = seedTeachings(now());
  let teachingSeq = 0;
  /** What each thread was before it was first taught, so removing the teaching can put it back. */
  const guesses = new Map<ThreadId, Pick<MockThread, 'groupId' | 'reason'>>();
  /** How to undo a move in or out of spam. The undo of each is the other, so each returns a new undo id. */
  const spamUndos = new Map<string, () => ActionResult>();
  /** The teaching entry an undo puts back, as on the server. */
  const teachUndos = new Map<string, { key: TeachingKey; entry: MockTeaching | null; oppositeKey: TeachingKey; opposite: MockTeaching | null }>();
  let groupSeq = 0;
  /** How many of the next bulk writes "Gmail" refuses, as if it were having a bad day. */
  let refuseWrites = 0;

  const emit = (e: ServerEvent) => {
    for (const fn of listeners) fn(e);
  };
  const groupName = (id: string) => world.groups.find((g) => g.id === id)?.name ?? 'Unsorted';

  function summary(t: MockThread): ThreadSummaryDTO {
    return {
      id: t.id,
      accountId: t.accountId,
      subject: t.subject,
      snippet: snippetOf(t.messages.at(-1)!),
      fromName: t.fromName,
      fromEmail: t.fromEmail,
      lastMessageAt: t.lastMessageAt,
      unread: t.unread,
      inInbox: t.inInbox,
      groupId: t.groupId,
      groupName: groupName(t.groupId),
      reason: { ...t.reason },
      snoozedUntil: t.snoozedUntil,
      hasAttachments: t.messages.some((m) => m.attachments.length > 0),
      suggestRule: t.suggestRule,
      doneAt: t.doneAt,
      listId: t.listId,
    };
  }

  function groups(accountId?: string | null): GroupDTO[] {
    return [...world.groups]
      .sort((a, b) => a.position - b.position)
      .map((g) => {
        const inbox = world.threads.filter((t) => t.inInbox && t.groupId === g.id && (!accountId || t.accountId === accountId));
        return { ...g, inboxCount: inbox.length, unreadCount: inbox.filter((t) => t.unread).length };
      });
  }

  function thread(id: string): MockThread {
    const t = world.threads.find((x) => x.id === id);
    if (!t) throw new HttpError(404, `thread ${id} not found`);
    return t;
  }

  function assertGroup(id: unknown): string {
    if (typeof id !== 'string' || !world.groups.some((g) => g.id === id)) throw new HttpError(400, 'Unknown group');
    return id;
  }

  function publish(ts: MockThread[]): void {
    for (const t of ts) emit({ type: 'thread.updated', thread: summary(t) });
    emit({ type: 'groups.updated', groups: groups() });
  }

  /** Runs a change on `affected`, records an undo that restores them, and returns the main thread's result. */
  function act(main: MockThread, affected: MockThread[], change: () => void): ActionResult {
    const snapshots = new Map(affected.map((t) => [t.id, snapshot(t)]));
    change();
    const undoId = `u${++undoSeq}`;
    undos.set(undoId, { threadId: main.id, snapshots });
    publish(affected);
    return { undoId, thread: summary(main), affected: affected.filter((t) => snapshots.get(t.id)!.groupId !== t.groupId).length };
  }

  function spamUndo(undoFn: () => ActionResult): string {
    const undoId = `u${++undoSeq}`;
    spamUndos.set(undoId, undoFn);
    return undoId;
  }

  function reportSpam(t: MockThread): ActionResult {
    const before = snapshot(t);
    world.threads = world.threads.filter((x) => x !== t);
    world.spam.push(t);
    emit({ type: 'thread.removed', id: t.id });
    emit({ type: 'groups.updated', groups: groups() });
    return { undoId: spamUndo(() => backFromSpam(t, before)), thread: null };
  }

  /** One undo id over several: undoing it undoes them all, and returns one that redoes them all. */
  function combinedUndo(undoIds: string[]): string {
    return spamUndo(() => {
      const results = undoIds.map(undo);
      return { undoId: combinedUndo(results.map((r) => r.undoId)), thread: null, affected: undoIds.length };
    });
  }

  function bulkChange(t: MockThread, b: BulkRequest, at: number): Partial<MockThread> {
    switch (b.action) {
      case 'done':
        return { inInbox: false, snoozedUntil: null, doneAt: at };
      case 'snooze':
        return { inInbox: false, snoozedUntil: b.until!, doneAt: null };
      case 'read':
        return { unread: false };
      case 'unread':
        return { unread: true };
      default:
        return { groupId: b.groupId!, reason: taughtReason(b.groupId!, at, 'override'), suggestRule: false };
    }
  }

  /** As on the server: the threads change now and Gmail follows. "Now" and "follows" are one step here. */
  function bulk(b: Partial<BulkRequest>): BulkResult {
    const ids = b.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string')) throw new HttpError(400, 'ids must be a list of thread ids');
    if (ids.length > MAX_BULK_IDS) throw new HttpError(400, `At most ${MAX_BULK_IDS} threads at a time`);
    if (!b.action || !BULK_ACTIONS.includes(b.action)) throw new HttpError(400, 'Unknown bulk action');
    const at = now();
    if (b.action === 'snooze' && (typeof b.until !== 'number' || b.until <= at + MIN_SNOOZE_MS)) throw new HttpError(400, 'Snooze time must be at least a minute in the future');
    if (b.action === 'move') assertGroup(b.groupId);
    const req = b as BulkRequest;
    const unique = [...new Set(ids)];
    const found = unique.flatMap((id) => world.threads.filter((t) => t.id === id));
    const refused = found.slice(0, refuseWrites);
    refuseWrites = 0;
    const accepted = { affected: found.length, failed: unique.filter((id) => !found.some((t) => t.id === id)) };
    if (req.action === 'spam') {
      const undoIds = found.map((t) => ({ t, undoId: reportSpam(t).undoId }));
      for (const { t, undoId } of undoIds.filter((u) => refused.includes(u.t))) undo(undoId);
      const undoId = combinedUndo(undoIds.filter((u) => !refused.includes(u.t)).map((u) => u.undoId));
      emit({ type: 'bulk.settled', undoId, affected: found.length - refused.length, failed: refused.map((t) => t.id), skipped: [] });
      return { undoId, ...accepted };
    }
    const { undoId } = act(found[0] ?? thread(ids[0]!), found, () => {
      for (const t of found) Object.assign(t, bulkChange(t, req, at));
    });
    const entry = undos.get(undoId)!;
    entry.bulk = true;
    for (const t of refused) {
      Object.assign(t, entry.snapshots.get(t.id));
      entry.snapshots.delete(t.id);
    }
    if (refused.length > 0) publish(refused);
    emit({ type: 'bulk.settled', undoId, affected: found.length - refused.length, failed: refused.map((t) => t.id), skipped: [] });
    return { undoId, ...accepted };
  }

  function teachBulk(b: Partial<TeachBulkRequest>): BulkResult {
    const ids = b.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BULK_IDS) throw new HttpError(400, 'ids must be a list of thread ids');
    if (!b.action || !['important', 'not_important', 'always_group'].includes(b.action)) throw new HttpError(400, 'Unknown teach action');
    const senders = new Map<string, ThreadId>();
    const failed: ThreadId[] = [];
    for (const id of new Set(ids)) {
      const email = world.threads.find((t) => t.id === id)?.fromEmail?.toLowerCase();
      if (email) senders.set(email, senders.get(email) ?? id);
      else failed.push(id);
    }
    if (senders.size > MAX_BULK_SENDERS) throw new HttpError(400, `At most ${MAX_BULK_SENDERS} senders at a time`);
    const taught = [...senders.values()].map((threadId) => teach({ threadId, action: b.action!, scope: 'sender', groupId: b.groupId }));
    return { undoId: combinedUndo(taught.map((r) => r.undoId)), affected: taught.reduce((n, r) => n + (r.affected ?? 0), 0), failed };
  }

  function backFromSpam(t: MockThread, state: Partial<Snapshot>): ActionResult {
    world.spam = world.spam.filter((x) => x !== t);
    Object.assign(t, state);
    world.threads.push(t);
    publish([t]);
    return { undoId: spamUndo(() => reportSpam(t)), thread: summary(t) };
  }

  function spamThread(id: string): MockThread {
    const t = world.spam.find((x) => x.id === id);
    if (!t) throw new HttpError(404, 'This thread is no longer in spam');
    return t;
  }

  /** As the server shows it: no group of its own, nothing the index would know. */
  const spamSummary = (t: MockThread): ThreadSummaryDTO => ({
    ...summary(t), inInbox: false, groupId: 'unsorted', groupName: 'Spam', reason: { source: 'default', text: 'In Gmail spam', at: null }, snoozedUntil: null, suggestRule: false, doneAt: null,
  });

  function undo(undoId: string): ActionResult {
    const undoSpam = spamUndos.get(undoId);
    if (undoSpam) {
      spamUndos.delete(undoId);
      return undoSpam();
    }
    const entry = undos.get(undoId);
    if (!entry) throw new HttpError(404, 'Nothing to undo');
    undos.delete(undoId);
    const affected = [...entry.snapshots.keys()].map((id) => world.threads.find((t) => t.id === id)).filter((t): t is MockThread => !!t);
    const main = affected.find((t) => t.id === entry.threadId) ?? thread(entry.threadId);
    // The undo of an undo is a redo, as on the server.
    const result = act(main, affected, () => {
      for (const t of affected) Object.assign(t, entry.snapshots.get(t.id));
    });
    if (entry.bulk) {
      undos.get(result.undoId)!.bulk = true;
      emit({ type: 'bulk.settled', undoId: result.undoId, affected: affected.length, failed: [], skipped: [] });
      return { undoId: result.undoId, thread: null, affected: affected.length };
    }
    const taught = teachUndos.get(undoId);
    if (taught) {
      teachUndos.delete(undoId);
      teachUndos.set(result.undoId, { ...taught, entry: putTeaching(taught.key, taught.entry), opposite: putTeaching(taught.oppositeKey, taught.opposite) });
    }
    return result;
  }

  function listInbox(q: URLSearchParams): ThreadPage {
    const limit = Math.min(Math.max(Math.trunc(Number(q.get('limit') ?? DEFAULT_LIMIT)) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const accountId = q.get('accountId');
    const groupId = q.get('groupId');
    const cursor = q.get('cursor');
    const doneSince = q.get('includeDone') === '1' ? now() - DONE_WINDOW_MS : null;
    let after: { at: number; id: string } | null = null;
    if (cursor) {
      const sep = cursor.indexOf(':');
      const at = Number(cursor.slice(0, sep));
      const id = cursor.slice(sep + 1);
      if (sep <= 0 || !Number.isSafeInteger(at) || !id) throw new HttpError(400, 'invalid cursor');
      after = { at, id };
    }
    const rows = world.threads
      .filter((t) => t.inInbox || (doneSince !== null && t.doneAt !== null && t.doneAt >= doneSince))
      .filter((t) => (!accountId || t.accountId === accountId) && (!groupId || t.groupId === groupId))
      .filter((t) => !after || sortKey(t) < after.at || (sortKey(t) === after.at && t.id < after.id))
      .sort(byInboxOrder);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return { threads: page.map(summary), nextCursor: rows.length > limit && last ? `${sortKey(last)}:${last.id}` : null };
  }

  function search(q: string): ThreadPage {
    const needle = q.trim().toLowerCase();
    const hits = world.threads.filter((t) => {
      const hay = [t.subject, t.fromName ?? '', t.fromEmail ?? '', ...t.messages.map((m) => m.text ?? htmlToText(m.html ?? ''))].join('\n').toLowerCase();
      return hay.includes(needle);
    });
    return { threads: hits.sort(byInboxOrder).slice(0, SEARCH_LIMIT).map(summary), nextCursor: null };
  }

  function matching(t: MockThread, scope: MatchType): MockThread[] {
    const email = t.fromEmail?.toLowerCase();
    if (scope === 'sender') {
      if (!email) throw new HttpError(400, 'This thread has no sender to teach on');
      return world.threads.filter((x) => x.fromEmail?.toLowerCase() === email);
    }
    if (scope === 'domain') {
      if (!email) throw new HttpError(400, 'This thread has no domain to teach on');
      const domain = email.slice(email.indexOf('@'));
      return world.threads.filter((x) => x.fromEmail?.toLowerCase().endsWith(domain));
    }
    if (!t.listId) throw new HttpError(400, 'This thread has no list to teach on');
    return world.threads.filter((x) => x.listId === t.listId);
  }

  function teach(b: Partial<TeachRequest>): ActionResult {
    const t = thread(str(b.threadId, 'threadId'));
    if (!b.action || !['important', 'not_important', 'always_group'].includes(b.action)) throw new HttpError(400, 'Unknown teach action');
    if (!b.scope || !['sender', 'domain', 'list'].includes(b.scope)) throw new HttpError(400, 'Unknown teach scope');
    const groupId = b.action === 'always_group' ? assertGroup(b.groupId) : b.action === 'important' ? 'important' : 'low_priority';
    const source = b.action === 'always_group' ? 'rule' : 'mark';
    const affected = [...new Set([t, ...matching(t, b.scope)])];
    for (const x of affected) if (!['override', 'rule', 'mark'].includes(x.reason.source) && !guesses.has(x.id)) guesses.set(x.id, { groupId: x.groupId, reason: x.reason });
    const key: TeachingKey = { kind: source, matchType: b.scope, matchValue: teachingValue(t, b.scope)! };
    const entry = { ...key, id: `teaching-${++teachingSeq}`, groupId: source === 'rule' ? groupId : null, mark: b.action === 'always_group' ? null : b.action, createdAt: now() };
    const oppositeKey: TeachingKey = { ...key, kind: source === 'rule' ? 'mark' : 'rule' };
    const prev = putTeaching(key, entry);
    const opposite = putTeaching(oppositeKey, null); // the latest teaching wins
    const result = act(t, affected, () => {
      const at = now();
      for (const x of affected) Object.assign(x, { groupId, reason: taughtReason(groupId, at, source), suggestRule: false });
    });
    teachUndos.set(result.undoId, { key, entry: prev, oppositeKey, opposite });
    return result;
  }

  function teachPreview(threadId: string): TeachPreviewDTO {
    const t = thread(threadId);
    const scope = (type: MatchType): TeachScopeDTO | null => {
      const value = teachingValue(t, type);
      return value === null ? null : { value, count: matching(t, type).filter(isActive).length };
    };
    const domain = teachingValue(t, 'domain');
    return { subject: t.subject, senderName: t.fromName, sender: scope('sender'), domain: domain && FREE_MAIL.has(domain) ? null : scope('domain'), list: scope('list') };
  }

  // ---- Teaching list (Settings → Rules)

  function putTeaching(key: TeachingKey, entry: MockTeaching | null): MockTeaching | null {
    const prev = teachings.find((e) => e.kind === key.kind && e.matchType === key.matchType && e.matchValue === key.matchValue) ?? null;
    teachings = teachings.filter((e) => e !== prev);
    if (entry) teachings.push(entry);
    return prev;
  }

  const isActive = (t: MockThread) => t.inInbox || t.snoozedUntil !== null;

  function teachingList(): TeachingDTO[] {
    return teachings
      .filter((e) => e.groupId === null || world.groups.some((g) => g.id === e.groupId)) // deleting a group cascades its rules
      .map((e) => ({
        id: e.id, kind: e.kind, matchType: e.matchType, matchValue: e.matchValue, groupId: e.groupId, groupName: e.groupId ? groupName(e.groupId) : null,
        mark: e.mark, createdAt: e.createdAt, threadCount: world.threads.filter((t) => isActive(t) && matchesTeaching(t, e)).length,
      }))
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1));
  }

  /** Inbox and snoozed threads fall back to the next teaching or their guess; archived ones and hand moves stay put. */
  function deleteTeaching(kind: string, id: string): { ok: true } {
    const entry = teachings.find((e) => e.kind === kind && e.id === id);
    if (!entry) throw new HttpError(404, 'Nothing to remove');
    teachings = teachings.filter((e) => e !== entry);
    const moved = world.threads.filter((t) => isActive(t) && t.reason.source !== 'override' && matchesTeaching(t, entry));
    for (const t of moved) {
      const next = nextTeaching(t, teachings);
      const groupId = next && teachingGroup(next);
      Object.assign(t, next ? { groupId, reason: taughtReason(groupId!, next.createdAt, next.kind) } : guesses.get(t.id) ?? { groupId: 'unsorted', reason: { source: 'default', text: UNSORTED_REASON, at: null } });
    }
    publish(moved);
    return { ok: true };
  }

  function send(b: Partial<SendRequest>): { threadId: ThreadId } {
    const account = world.accounts.find((a) => a.id === b.accountId);
    if (!account) throw new HttpError(400, 'Unknown account');
    const to = addresses(b.to);
    const cc = addresses(b.cc);
    if (!to.length && !cc.length && !addresses(b.bcc).length) throw new HttpError(400, 'Add at least one recipient');
    const text = typeof b.text === 'string' ? b.text : '';
    const from: AddressDTO = { name: 'Alex Doe', email: account.email };
    const at = now();
    if (b.replyToThreadId) {
      const t = thread(b.replyToThreadId);
      const subject = typeof b.subject === 'string' && b.subject.trim() ? b.subject : `Re: ${t.subject}`;
      t.messages.push(sentMessage(world, from, to, cc, subject, text, at, t.id.split(':')[1]!));
      Object.assign(t, { lastMessageAt: at, fromName: from.name, fromEmail: from.email, unread: false });
      publish([t]);
      return { threadId: t.id };
    }
    const key = `19b${(world.seq * 104_729).toString(16).padStart(10, '0')}`;
    const subject = typeof b.subject === 'string' ? b.subject : '';
    const t: MockThread = {
      id: `${account.id}:${key}`, accountId: account.id, subject, fromName: from.name, fromEmail: from.email, listId: null,
      lastMessageAt: at, surfacedAt: null, unread: false, inInbox: false, groupId: 'unsorted',
      reason: { source: 'default', text: UNSORTED_REASON, at: null }, snoozedUntil: null, skipped: false, doneAt: null, suggestRule: false,
      messages: [sentMessage(world, from, to, cc, subject, text, at, key)],
    };
    world.threads.push(t);
    return { threadId: t.id };
  }

  function attachment(accountId: string, gmailMessageId: string, attachmentId: string, q: URLSearchParams): MockResponse {
    const message = world.threads.filter((t) => t.accountId === accountId).flatMap((t) => t.messages).find((m) => m.gmailMessageId === gmailMessageId);
    const name = q.get('name');
    const meta = message?.attachments.find((a) => a.attachmentId === attachmentId) ?? (name ? message?.attachments.find((a) => a.filename === name) : undefined);
    const bytes = meta && world.blobs.get(meta.attachmentId);
    if (!meta || !bytes) throw new HttpError(404, 'attachment not found');
    const inline = ['application/pdf', 'image/png', 'image/jpeg', 'text/plain'].includes(meta.mimeType) && q.get('download') !== '1';
    return {
      status: 200,
      headers: {
        'content-type': meta.mimeType,
        'content-disposition': contentDisposition(meta.filename, inline),
        'content-length': String(bytes.length),
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
      },
      body: bytes,
    };
  }

  function createGroup(b: Record<string, unknown>): GroupDTO {
    const existing = typeof b.existingLabelName === 'string' ? b.existingLabelName.trim() : '';
    const name = (typeof b.name === 'string' ? b.name.trim() : '') || existing;
    if (!name) throw new HttpError(400, 'name is required');
    if (world.groups.some((g) => g.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, `A group named "${name}" already exists`);
    const position = Math.max(-1, ...world.groups.map((g) => g.position)) + 1;
    const color = typeof b.color === 'string' && /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : ['#db2777', '#0d9488', '#7c3aed', '#ea580c'][position % 4]!;
    const g = { id: `g${++groupSeq}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name, position, color, notify: true, kind: existing ? ('existing_label' as const) : ('custom' as const) };
    world.groups.push(g);
    emit({ type: 'groups.updated', groups: groups() });
    return groups().find((x) => x.id === g.id)!;
  }

  function patchGroup(id: string, b: Record<string, unknown>): GroupDTO {
    const g = world.groups.find((x) => x.id === id);
    if (!g) throw new HttpError(404, 'Unknown group');
    if (b.name !== undefined) {
      const name = str(b.name, 'name');
      if (world.groups.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, `A group named "${name}" already exists`);
      g.name = name;
    }
    if (b.color !== undefined) {
      if (typeof b.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(b.color)) throw new HttpError(400, 'color must be #rrggbb');
      g.color = b.color;
    }
    if (b.position !== undefined) {
      if (!Number.isInteger(b.position)) throw new HttpError(400, 'position must be an integer');
      g.position = b.position as number;
    }
    if (b.notify !== undefined) {
      if (typeof b.notify !== 'boolean') throw new HttpError(400, 'notify must be true or false');
      g.notify = b.notify;
    }
    if (b.name !== undefined) publish(world.threads.filter((t) => t.groupId === id));
    else emit({ type: 'groups.updated', groups: groups() });
    return groups().find((x) => x.id === id)!;
  }

  function deleteGroup(id: string): { ok: true } {
    const g = world.groups.find((x) => x.id === id);
    if (!g) throw new HttpError(404, 'Unknown group');
    if (g.kind === 'builtin') throw new HttpError(400, 'Built-in groups cannot be deleted');
    world.groups = world.groups.filter((x) => x.id !== id);
    const moved = world.threads.filter((t) => t.groupId === id);
    for (const t of moved) Object.assign(t, { groupId: 'unsorted', reason: { source: 'default', text: UNSORTED_REASON, at: null } });
    publish(moved);
    return { ok: true };
  }

  function removeAccount(id: string): { ok: true } {
    if (!world.accounts.some((a) => a.id === id)) throw new HttpError(404, 'Unknown account');
    world.accounts = world.accounts.filter((a) => a.id !== id);
    const gone = world.threads.filter((t) => t.accountId === id);
    world.threads = world.threads.filter((t) => t.accountId !== id);
    world.spam = world.spam.filter((t) => t.accountId !== id);
    for (const t of gone) emit({ type: 'thread.removed', id: t.id });
    emit({ type: 'groups.updated', groups: groups() });
    return { ok: true };
  }

  // Push: devices live here only, and nothing is ever pushed. /api/push/test hands the notification back for the app to show.
  let pushDevices: PushDeviceDTO[] = [];
  const removedDevices = new Set<string>();

  function route(req: MockRequest): MockResponse {
    const url = new URL(req.url, 'http://mock.local');
    const path = url.pathname;
    const q = url.searchParams;
    const method = req.method.toUpperCase();
    const b = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    if (path.startsWith('/api/') && method !== 'GET' && method !== 'HEAD' && header(req, API_HEADER) !== '1') {
      throw new HttpError(403, `missing ${API_HEADER} header`);
    }
    const seg = path.split('/').slice(1).map(decodeURIComponent);
    const is = (m: string, pattern: RegExp) => method === m && pattern.test(path);

    if (path === '/auth/login' || path === '/auth/connect' || path === '/auth/google/callback') return { status: 302, headers: { location: '/' }, body: '' };
    if (is('POST', /^\/auth\/logout$/)) return json(200, { ok: true });
    if (is('GET', /^\/api\/me$/)) return json(200, { email: world.me });
    if (is('GET', /^\/api\/accounts$/)) return json(200, world.accounts);
    if (is('DELETE', /^\/api\/accounts\/[^/]+$/)) return json(200, removeAccount(seg[2]!));
    if (is('GET', /^\/api\/groups$/)) return json(200, groups(q.get('accountId')));
    if (is('POST', /^\/api\/groups$/)) return json(200, createGroup(b));
    if (is('PATCH', /^\/api\/groups\/[^/]+$/)) return json(200, patchGroup(seg[2]!, b));
    if (is('DELETE', /^\/api\/groups\/[^/]+$/)) return json(200, deleteGroup(seg[2]!));
    if (is('GET', /^\/api\/labels$/)) return json(200, world.labels);
    if (is('GET', /^\/api\/threads$/)) return json(200, listInbox(q));
    if (is('POST', /^\/api\/threads\/bulk$/)) return json(200, bulk(b as Partial<BulkRequest>));
    if (is('POST', /^\/api\/teach\/bulk$/)) return json(200, teachBulk(b as Partial<TeachBulkRequest>));
    if (is('POST', /^\/api\/mock\/refuse-writes$/)) {
      refuseWrites = Number(b.count) || 0;
      return json(200, { ok: true });
    }
    if (is('POST', /^\/api\/mock\/deliver$/)) {
      const delivered = Array.from({ length: Number(b.count) || 0 }, () => incomingThread(world, now()));
      world.threads.push(...delivered);
      publish(delivered);
      return json(200, { ok: true });
    }
    if (is('GET', /^\/api\/threads\/[^/]+$/)) {
      const t = thread(seg[2]!);
      return json(200, { thread: summary(t), messages: t.messages } satisfies ThreadDetailDTO);
    }
    if (method === 'POST' && /^\/api\/threads\/[^/]+\/(done|snooze|unsnooze|move|read)$/.test(path)) {
      const t = thread(seg[2]!);
      const at = now();
      switch (seg[3]) {
        case 'done':
          return json(200, act(t, [t], () => Object.assign(t, { inInbox: false, snoozedUntil: null, doneAt: at })));
        case 'snooze': {
          const until = b.until;
          if (typeof until !== 'number' || !Number.isFinite(until) || until <= at + MIN_SNOOZE_MS) throw new HttpError(400, 'Snooze time must be at least a minute in the future');
          return json(200, act(t, [t], () => Object.assign(t, { inInbox: false, snoozedUntil: until, doneAt: null })));
        }
        case 'unsnooze':
          return json(200, act(t, [t], () => Object.assign(t, { inInbox: true, snoozedUntil: null, doneAt: null, surfacedAt: at })));
        case 'move': {
          const groupId = assertGroup(b.groupId);
          return json(200, act(t, [t], () => Object.assign(t, { groupId, reason: taughtReason(groupId, at, 'override'), suggestRule: false })));
        }
        default: {
          if (typeof b.read !== 'boolean') throw new HttpError(400, 'read must be true or false');
          const read = b.read;
          return json(200, act(t, [t], () => Object.assign(t, { unread: !read })));
        }
      }
    }
    if (is('POST', /^\/api\/teach$/)) return json(200, teach(b as Partial<TeachRequest>));
    if (is('GET', /^\/api\/teach\/preview$/)) return json(200, teachPreview(str(q.get('threadId'), 'threadId')));
    if (is('GET', /^\/api\/teaching$/)) return json(200, teachingList());
    if (is('DELETE', /^\/api\/teaching\/[^/]+\/[^/]+$/)) return json(200, deleteTeaching(seg[2]!, seg[3]!));
    if (is('POST', /^\/api\/undo\/[^/]+$/)) return json(200, undo(seg[2]!));
    if (is('POST', /^\/api\/send$/)) return json(200, send(b as Partial<SendRequest>));
    if (is('GET', /^\/api\/search$/)) {
      const term = q.get('q');
      if (!term?.trim()) throw new HttpError(400, 'missing q');
      return json(200, search(term));
    }
    if (is('GET', /^\/api\/skipped$/)) {
      const accountId = q.get('accountId');
      const rows = world.threads.filter((t) => t.skipped && !t.inInbox && (!accountId || t.accountId === accountId)).sort(byInboxOrder);
      return json(200, { threads: rows.map(summary), nextCursor: null } satisfies ThreadPage);
    }
    if (is('POST', /^\/api\/skipped\/[^/]+\/restore$/)) {
      const t = thread(seg[2]!);
      if (t.inInbox) throw new HttpError(400, 'This thread is already in the inbox');
      const at = now();
      return json(200, act(t, [t], () => Object.assign(t, { inInbox: true, skipped: false, snoozedUntil: null, doneAt: null, surfacedAt: at })));
    }
    if (is('POST', /^\/api\/threads\/[^/]+\/spam$/)) return json(200, reportSpam(thread(seg[2]!)));
    if (is('GET', /^\/api\/spam$/)) {
      return json(200, { threads: [...world.spam].sort(byInboxOrder).map(spamSummary), nextCursor: null } satisfies ThreadPage);
    }
    if (is('GET', /^\/api\/spam\/[^/]+$/)) {
      const t = spamThread(seg[2]!);
      return json(200, { thread: spamSummary(t), messages: t.messages } satisfies ThreadDetailDTO);
    }
    if (is('POST', /^\/api\/spam\/[^/]+\/not-spam$/)) {
      return json(200, backFromSpam(spamThread(seg[2]!), { inInbox: true, skipped: false, snoozedUntil: null, doneAt: null, surfacedAt: now() }));
    }
    if (is('GET', /^\/api\/push\/key$/)) return json(200, { publicKey: PUSH_PUBLIC_KEY, keysReset: false });
    if (is('POST', /^\/api\/push\/subscribe$/)) {
      const endpoint = String(b.endpoint ?? '');
      const keys = (b.keys ?? {}) as { p256dh?: unknown; auth?: unknown };
      if (!endpoint.startsWith('https://') || !keys.p256dh || !keys.auth) throw new HttpError(400, 'endpoint and keys are required');
      if (b.refresh === true && removedDevices.has(endpoint)) return json(200, { ok: true, removed: true });
      removedDevices.delete(endpoint);
      if (!pushDevices.some((d) => d.endpoint === endpoint)) {
        pushDevices.push({ id: `device-${pushDevices.length + 1}`, endpoint, userAgent: typeof b.userAgent === 'string' ? b.userAgent : null, createdAt: now(), lastOkAt: null });
      }
      return json(200, { ok: true });
    }
    if (is('DELETE', /^\/api\/push\/subscribe$/)) {
      removedDevices.delete(String(b.endpoint));
      pushDevices = pushDevices.filter((d) => d.endpoint !== b.endpoint);
      return json(200, { ok: true });
    }
    if (is('GET', /^\/api\/push\/devices$/)) return json(200, pushDevices);
    if (is('DELETE', /^\/api\/push\/devices\/[^/]+$/)) {
      const device = pushDevices.find((d) => d.id === seg[3]);
      if (!device) throw new HttpError(404, 'No such device');
      removedDevices.add(device.endpoint);
      pushDevices = pushDevices.filter((d) => d !== device);
      return json(200, { ok: true });
    }
    if (is('POST', /^\/api\/push\/test$/)) {
      const device = pushDevices.find((d) => d.endpoint === b.endpoint);
      if (!device) throw new HttpError(404, 'This device is not subscribed');
      device.lastOkAt = now();
      return json(200, { ok: true, preview: { title: 'SuperMail', body: 'Notifications work on this device. (The mock shows this itself: no push service was involved.)' } });
    }
    if (is('GET', /^\/api\/filters$/)) return json(200, world.filters);
    if (is('GET', /^\/api\/storage$/)) {
      return json(200, {
        bodyCacheMB: 41.2, indexMB: 18.7, logsMB: 2.1, totalMB: 62, diskFreeGB: 21.4,
        limits: { bodyCacheMB: 500, indexMB: 300, logsMB: 50, totalMB: 1000, minFreeDiskGB: 2 }, degraded: false,
      });
    }
    if (is('GET', /^\/api\/attachments\/[^/]+\/[^/]+\/[^/]+$/)) return attachment(seg[2]!, seg[3]!, seg[4]!, q);
    throw new HttpError(404, `No mock route for ${method} ${path}`);
  }

  return {
    world,
    handle(req) {
      try {
        return route(req);
      } catch (err) {
        if (err instanceof HttpError) return json(err.status, { error: err.message });
        throw err;
      }
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    tick() {
      const at = now();
      for (const t of world.threads.filter((x) => x.snoozedUntil !== null && x.snoozedUntil <= at)) {
        Object.assign(t, { inInbox: true, snoozedUntil: null, surfacedAt: at });
        emit({ type: 'thread.updated', thread: summary(t) });
      }
      const t = incomingThread(world, at);
      world.threads.push(t);
      publish([t]);
      return summary(t);
    },
  };
}
