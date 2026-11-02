import { createHash } from 'node:crypto';
import { type Auth, google } from 'googleapis';
import type { AppConfig } from '../config.js';
import type { DB } from '../db/index.js';
import { GmailAuthRevoked, GmailHistoryExpired, GmailLabelExists, type GmailApi, GmailNoAnswer, METADATA_HEADERS } from './gmailApi.js';

export type OAuth2Client = Auth.OAuth2Client;

/** Concurrent Gmail requests per account. */
export const GMAIL_CONCURRENCY = 5;

/** Gmail quota units per second per account: below Gmail's 250/user/s, so bursts never hit 429s. */
export const GMAIL_QUOTA_UNITS_PER_SEC = 200;

/** How long a request may take, so a hung one cannot hold a worker. */
export const GMAIL_TIMEOUT_MS = 30_000;
/** Sending and attachments move up to 35 MB, and giving up on a send that went through would send it twice. */
const GMAIL_TRANSFER_TIMEOUT_MS = 120_000;

/** Gmail quota units per method (developers.google.com/gmail/api/reference/quota). */
export const GMAIL_QUOTA_COST = {
  getProfile: 1,
  listThreads: 10,
  getThread: 10,
  listHistory: 2,
  modifyThread: 10,
  listLabels: 1,
  createLabel: 1,
  sendRaw: 100,
  getAttachment: 5,
  listFilters: 1,
} as const satisfies Record<keyof GmailApi, number>;

export interface QuotaClock { now(): number; sleep(ms: number): Promise<void> }

const realClock: QuotaClock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface TokenBucket { take(units: number): Promise<void> }

/**
 * A token bucket: holds up to `capacity` units, refilled at `unitsPerSecond`. `take` waits until enough units
 * are available; callers are served in arrival order. A cost above the capacity waits for a full bucket and
 * leaves it in debt.
 */
export function createTokenBucket(unitsPerSecond: number, capacity: number, clock: QuotaClock = realClock): TokenBucket {
  let tokens = capacity;
  let last = clock.now();
  let queue: Promise<void> = Promise.resolve();
  const refill = () => {
    const t = clock.now();
    tokens = Math.min(capacity, tokens + ((t - last) * unitsPerSecond) / 1000);
    last = t;
  };
  return {
    take(units) {
      const turn = queue.then(async () => {
        const need = Math.min(units, capacity);
        refill();
        while (tokens < need) {
          await clock.sleep(Math.ceil(((need - tokens) * 1000) / unitsPerSecond));
          refill();
        }
        tokens -= units;
      });
      queue = turn;
      return turn;
    },
  };
}

/** Task 2's token and OAuth functions, injected so this module does not depend on Task 2's files. */
export interface GmailAuthDeps {
  getRefreshToken(db: DB, key: Buffer, accountId: string): string;
  oauthClient(cfg: AppConfig): OAuth2Client;
}

interface ErrorShape { status?: unknown; code?: unknown; message?: unknown; response?: { status?: unknown; data?: unknown } }

function statusOf(err: unknown): number | undefined {
  const e = err as ErrorShape | null;
  for (const v of [e?.response?.status, e?.status, e?.code]) {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n === 'number' && Number.isInteger(n)) return n;
  }
  return undefined;
}

function isAuthRevoked(err: unknown): boolean {
  const e = err as ErrorShape | null;
  const data = e?.response?.data as { error?: unknown; error_description?: unknown } | undefined;
  const text = `${String(e?.message ?? '')} ${typeof data?.error === 'string' ? data.error : ''}`;
  if (/invalid_grant/i.test(text)) return true; // refresh token revoked, expired or password changed
  if (statusOf(err) === 401) return true; // still unauthorized after the client's own refresh
  // The owner unticked the Gmail permission on the consent screen: only a reconnect fixes it.
  return statusOf(err) === 403 && /insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(`${text} ${JSON.stringify(e?.response?.data ?? '')}`);
}

/** The connection dropped before any answer: `code` is a socket error such as ECONNRESET, and there is no response. */
function isNoAnswer(err: unknown): boolean {
  const e = err as ErrorShape | null;
  return !e?.response && typeof e?.code === 'string' && !/^\d+$/.test(e.code);
}

function mapError(err: unknown, on404?: () => Error, on409?: () => Error): Error {
  if (isAuthRevoked(err)) return new GmailAuthRevoked(err instanceof Error ? err.message : 'invalid_grant', { cause: err });
  if (isNoAnswer(err)) return new GmailNoAnswer(err instanceof Error ? err.message : 'no answer from Gmail', { cause: err });
  const status = statusOf(err);
  if (status === 404 && on404) return on404();
  if (status === 409 && on409) return on409();
  return err instanceof Error ? err : new Error(String(err));
}

/** A tiny semaphore: at most `limit` calls of `run` in flight. */
function limiter(limit: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

export interface GmailApiOptions {
  /** Quota bucket; defaults to GMAIL_QUOTA_UNITS_PER_SEC with one second of burst. */
  quota?: TokenBucket;
  /** Overrides how long a request may take. */
  timeoutMs?: number;
}

/** What each request hands googleapis, so a timeout aborts the socket as well. */
interface RequestOptions { signal: AbortSignal }

/**
 * Gmail API client over an authorized OAuth2 client. Errors are mapped to the `GmailApi` error classes. Each
 * client (one per account) paces itself with a quota token bucket on top of the concurrency limit.
 */
export function createGmailApi(auth: OAuth2Client, opts: GmailApiOptions = {}): GmailApi {
  const gmail = google.gmail({ version: 'v1', auth });
  const users = gmail.users;
  const run = limiter(GMAIL_CONCURRENCY);
  const quota = opts.quota ?? createTokenBucket(GMAIL_QUOTA_UNITS_PER_SEC, GMAIL_QUOTA_UNITS_PER_SEC);
  const call = <T>(method: keyof GmailApi, fn: (o: RequestOptions) => Promise<T>, on404?: () => Error, on409?: () => Error): Promise<T> =>
    quota.take(GMAIL_QUOTA_COST[method]).then(() =>
      run(async () => {
        const abort = new AbortController();
        const ms = opts.timeoutMs ?? (method === 'sendRaw' || method === 'getAttachment' ? GMAIL_TRANSFER_TIMEOUT_MS : GMAIL_TIMEOUT_MS);
        let timer: NodeJS.Timeout | undefined;
        const timedOut = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new GmailNoAnswer(`Gmail did not answer ${method} within ${ms} ms`));
          }, ms);
        });
        try {
          return await Promise.race([fn({ signal: abort.signal }), timedOut]);
        } catch (err) {
          throw mapError(err, on404, on409);
        } finally {
          clearTimeout(timer);
        }
      }));

  return {
    getProfile: () =>
      call('getProfile', async (o) => {
        const { data } = await users.getProfile({ userId: 'me' }, o);
        return { emailAddress: data.emailAddress ?? '', historyId: data.historyId ?? '' };
      }),

    listThreads: (p) =>
      call('listThreads', async (o) => {
        const { data } = await users.threads.list({ userId: 'me', q: p.q, labelIds: p.labelIds, pageToken: p.pageToken, maxResults: p.maxResults }, o);
        const ids = (data.threads ?? []).map((t) => t.id).filter((id): id is string => !!id);
        return data.nextPageToken ? { ids, nextPageToken: data.nextPageToken } : { ids };
      }),

    getThread: (id, format) =>
      call('getThread', async (o) => {
        const { data } = await users.threads.get({ userId: 'me', id, format, ...(format === 'metadata' ? { metadataHeaders: METADATA_HEADERS } : {}) }, o);
        return data;
      }),

    listHistory: (startHistoryId, pageToken) =>
      call(
        'listHistory',
        async (o) => {
          const { data } = await users.history.list({ userId: 'me', startHistoryId, pageToken, maxResults: 500 }, o);
          const result = { history: data.history ?? [], historyId: data.historyId ?? startHistoryId };
          return data.nextPageToken ? { ...result, nextPageToken: data.nextPageToken } : result;
        },
        () => new GmailHistoryExpired(`history ${startHistoryId} is no longer available`),
      ),

    modifyThread: (id, add, remove) =>
      call('modifyThread', async (o) => {
        await users.threads.modify({ userId: 'me', id, requestBody: { addLabelIds: add, removeLabelIds: remove } }, o);
      }),

    listLabels: () =>
      call('listLabels', async (o) => {
        const { data } = await users.labels.list({ userId: 'me' }, o);
        return (data.labels ?? [])
          .filter((l) => l.id && l.name)
          .map((l) => ({ id: l.id!, name: l.name!, type: l.type === 'system' ? ('system' as const) : ('user' as const) }));
      }),

    createLabel: (name) =>
      call(
        'createLabel',
        async (o) => {
          const { data } = await users.labels.create({ userId: 'me', requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' } }, o);
          return { id: data.id ?? '', name: data.name ?? name };
        },
        undefined,
        () => new GmailLabelExists(`label ${name} already exists`),
      ),

    sendRaw: (raw, threadId) =>
      call('sendRaw', async (o) => {
        const { data } = await users.messages.send({ userId: 'me', requestBody: { raw, ...(threadId ? { threadId } : {}) } }, o);
        return { id: data.id ?? '', threadId: data.threadId ?? threadId ?? '' };
      }),

    getAttachment: (messageId, attachmentId) =>
      call('getAttachment', async (o) => {
        const { data } = await users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId }, o);
        return Buffer.from(data.data ?? '', 'base64url');
      }),

    listFilters: () =>
      call('listFilters', async (o) => {
        const { data } = await users.settings.filters.list({ userId: 'me' }, o);
        return data.filter ?? [];
      }),
  };
}

/**
 * Returns `gmailFor(accountId)`, caching one client per account. The cache is keyed on the stored encrypted
 * token, so a reconnect (new refresh token) gets a fresh client instead of the revoked one.
 */
export function gmailForFactory(db: DB, cfg: AppConfig, key: Buffer, auth: GmailAuthDeps): (accountId: string) => GmailApi {
  const cache = new Map<string, { fingerprint: string; api: GmailApi }>();
  const tokenOf = db.prepare('SELECT token_enc FROM accounts WHERE id = ?');
  return (accountId) => {
    const row = tokenOf.get(accountId) as { token_enc: Buffer | null } | undefined;
    if (!row) throw new Error(`unknown account ${accountId}`);
    if (!row.token_enc) throw new GmailAuthRevoked(`account ${accountId} has no refresh token`);
    const fingerprint = createHash('sha256').update(row.token_enc).digest('hex');
    const hit = cache.get(accountId);
    if (hit?.fingerprint === fingerprint) return hit.api;
    const client = auth.oauthClient(cfg);
    client.setCredentials({ refresh_token: auth.getRefreshToken(db, key, accountId) });
    const api = createGmailApi(client);
    cache.set(accountId, { fingerprint, api });
    return api;
  };
}
