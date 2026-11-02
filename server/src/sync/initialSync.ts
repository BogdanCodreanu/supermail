import type { AccountDTO, AccountStatus } from '@supermail/shared';
import type { DB } from '../db/index.js';
import { bus } from '../events.js';
import { GmailAuthRevoked, type GmailApi } from '../google/gmailApi.js';
import type { ThreadHook } from '../http/app.js';
import { indexThread, ownEmailsOf, removeThread } from './indexer.js';

export const RECENT_QUERY = 'newer_than:90d';
export const BACKFILL_QUERY = 'older_than:90d';
export const BACKFILL_PAGE = 100;
const LIST_PAGE = 100;
const FETCH_CONCURRENCY = 5;

/**
 * Sets an account's status and publishes `account.updated`. Kept as the single place the sync code changes
 * status, so it can be swapped for Task 2's `setAccountStatus` when the branches merge.
 */
export function updateAccountStatus(db: DB, accountId: string, status: AccountStatus): void {
  const row = db.prepare('SELECT id, email, color, status FROM accounts WHERE id = ?').get(accountId) as AccountDTO | undefined;
  if (!row || row.status === status) return;
  db.prepare('UPDATE accounts SET status = ? WHERE id = ?').run(status, accountId);
  bus.publish({ type: 'account.updated', account: { ...row, status } });
}

/** True for a Gmail 404 (thread or message gone), from googleapis (`status`/`code`) or the fake. */
export function isNotFound(err: unknown): boolean {
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } } | null;
  return !!e && (e.status === 404 || e.code === 404 || e.code === '404' || e.response?.status === 404);
}

/**
 * Runs `fn` over `items` with at most `limit` in flight. After the first failure no new item is started; the
 * ones already running settle, then the first error is thrown.
 */
export async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed: { err: unknown } | undefined;
  const worker = async () => {
    while (!failed && next < items.length) {
      try {
        await fn(items[next++]!);
      } catch (err) {
        failed ??= { err };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw failed.err;
}

export interface SyncLog { warn(obj: unknown, msg?: string): void }

const consoleSyncLog: SyncLog = { warn: (obj, msg) => console.warn(msg ?? '', obj) };

/** Failures a thread may have before it is parked and skipped. */
export const MAX_THREAD_ATTEMPTS = 3;
const PARKED_LOG_MS = 3_600_000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 3_600_000;
const RETRY_BATCH = 20;
const MAX_TRACKED = 1000;

/** `n` failures so far; a parked thread (n >= MAX_THREAD_ATTEMPTS) is retried from `next`; `logged` is its last log. */
interface FailureEntry { n: number; next: number; logged: number }

/**
 * Per-account record of threads Gmail keeps failing to serve, kept in `kv` so it survives a restart.
 * A failing thread fails its page (so the page is retried) until it has failed MAX_THREAD_ATTEMPTS times; after
 * that it is parked: skipped, so sync moves on, and retried later with backoff. Each parked thread is logged at
 * most once per hour.
 */
export interface ThreadFailures {
  /** Runs `fn` for one thread; resolves undefined when the thread is parked instead of failing the caller. */
  attempt<T>(gmailThreadId: string, fn: () => Promise<T>): Promise<T | undefined>;
  /** Parked threads due for a retry, oldest due first. */
  due(): string[];
}

const failuresKey = (accountId: string) => `sync_failures:${accountId}`;

function isAuthError(err: unknown): boolean {
  return err instanceof GmailAuthRevoked || (err instanceof Error && (err.name === 'GmailAuthRevoked' || err.name === 'TokenDecryptError'));
}

export function threadFailures(db: DB, accountId: string, log: SyncLog = consoleSyncLog, now: () => number = Date.now): ThreadFailures {
  const key = failuresKey(accountId);
  const raw = db.prepare('SELECT value FROM kv WHERE key = ?').pluck().get(key) as string | undefined;
  const entries = new Map<string, FailureEntry>(raw ? Object.entries(JSON.parse(raw) as Record<string, FailureEntry>) : []);
  const save = () => {
    if (entries.size === 0) db.prepare('DELETE FROM kv WHERE key = ?').run(key);
    else db.prepare('INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(Object.fromEntries(entries)));
  };

  return {
    async attempt(id, fn) {
      try {
        const result = await fn();
        if (entries.delete(id)) save();
        return result;
      } catch (err) {
        if (isAuthError(err)) throw err;
        const t = now();
        const e = entries.get(id) ?? { n: 0, next: 0, logged: 0 };
        entries.delete(id); // re-insert at the end, so the oldest entries are dropped first
        e.n++;
        e.next = t + Math.min(RETRY_BASE_MS * 2 ** Math.max(0, e.n - MAX_THREAD_ATTEMPTS), RETRY_MAX_MS);
        const parked = e.n >= MAX_THREAD_ATTEMPTS;
        if (parked && t - e.logged >= PARKED_LOG_MS) {
          e.logged = t;
          log.warn({ accountId, threadId: id, attempts: e.n, err: err instanceof Error ? err.message : String(err) }, 'Gmail thread keeps failing; skipping it and retrying later');
        }
        entries.set(id, e);
        while (entries.size > MAX_TRACKED) entries.delete(entries.keys().next().value!);
        save();
        if (!parked) throw err;
        return undefined;
      }
    },
    due() {
      const t = now();
      return [...entries].filter(([, e]) => e.n >= MAX_THREAD_ATTEMPTS && e.next <= t).sort((x, y) => x[1].next - y[1].next).slice(0, RETRY_BATCH).map(([id]) => id);
    },
  };
}

/** Fetches one thread (metadata) and indexes it; a thread Gmail no longer has is removed from the index. */
export async function fetchAndIndex(
  db: DB, accountId: string, gmail: GmailApi, gmailThreadId: string, ownEmails: Set<string>, onChange: ThreadHook | undefined, mode: 'live' | 'sync',
): Promise<'indexed' | 'removed'> {
  let thread;
  try {
    thread = await gmail.getThread(gmailThreadId, 'metadata');
  } catch (err) {
    if (!isNotFound(err)) throw err;
    removeThread(db, accountId, gmailThreadId);
    return 'removed';
  }
  if (!thread.messages?.length) {
    removeThread(db, accountId, gmailThreadId);
    return 'removed';
  }
  indexThread(db, accountId, { ...thread, id: thread.id ?? gmailThreadId }, ownEmails, onChange, mode);
  // Only drafts, spam or trash left: the indexer dropped it, so the UI must drop it too.
  const kept = db.prepare('SELECT 1 FROM threads WHERE account_id = ? AND gmail_thread_id = ?').get(accountId, gmailThreadId);
  return kept ? 'indexed' : 'removed';
}

async function listAll(gmail: GmailApi, q: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await gmail.listThreads({ q, pageToken, maxResults: LIST_PAGE });
    ids.push(...page.ids);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return ids;
}

/** An initial sync that has started but not finished, kept in `kv` so a restart resumes it. */
interface PendingSync {
  /** The mailbox historyId captured before indexing began; becomes `accounts.history_id` once the sync finishes. */
  historyId: string;
  /** A first sync of an empty index: a resumed run can skip threads an earlier run already indexed. */
  skipKnown: boolean;
}

const pendingKey = (accountId: string) => `initial_sync:${accountId}`;

/** True while an account's initial sync (or resync) has started and not finished. */
export function initialSyncPending(db: DB, accountId: string): boolean {
  return db.prepare('SELECT 1 FROM kv WHERE key = ?').get(pendingKey(accountId)) !== undefined;
}

/**
 * Indexes the inbox and the last 90 days. Also used to resync after history expires (Review Focus 2):
 * it only upserts, so threads are never duplicated and overrides, rules and snoozes are kept.
 *
 * `accounts.history_id` is only written once the sync finishes; until then a pending record in `kv` makes the
 * poller run it again, so an interrupted sync (restart, persistent error) is resumed instead of abandoned.
 */
export async function initialSync(db: DB, accountId: string, gmail: GmailApi, onChange?: ThreadHook, failures?: ThreadFailures): Promise<void> {
  updateAccountStatus(db, accountId, 'syncing');
  const fails = failures ?? threadFailures(db, accountId);
  const key = pendingKey(accountId);
  const stored = db.prepare('SELECT value FROM kv WHERE key = ?').pluck().get(key) as string | undefined;
  let pending: PendingSync;
  if (stored) {
    // Resuming: keep the historyId from the first attempt, so history replays everything since then.
    pending = JSON.parse(stored) as PendingSync;
  } else {
    // Capture the historyId first: anything that changes while we index is replayed by the next history poll.
    const profile = await gmail.getProfile();
    const acct = db.prepare('SELECT history_id FROM accounts WHERE id = ?').get(accountId) as { history_id: string | null } | undefined;
    const indexed = db.prepare('SELECT 1 FROM threads WHERE account_id = ? LIMIT 1').get(accountId) !== undefined;
    pending = { historyId: profile.historyId, skipKnown: acct?.history_id == null && !indexed };
    db.prepare('INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(pending));
  }

  const own = ownEmailsOf(db);
  const known = db.prepare('SELECT 1 FROM threads WHERE account_id = ? AND gmail_thread_id = ?');
  const seen = new Set<string>();
  const index = (ids: string[]) =>
    mapLimit(ids.filter((id) => !seen.has(id) && seen.add(id) && !(pending.skipKnown && known.get(accountId, id))), FETCH_CONCURRENCY, async (id) => {
      await fails.attempt(id, () => fetchAndIndex(db, accountId, gmail, id, own, onChange, 'sync'));
    });

  const inbox = await listAll(gmail, 'in:inbox');
  await index(inbox);
  await index(await listAll(gmail, RECENT_QUERY));

  // Threads the index still shows in the inbox but Gmail did not list there (archived or deleted while we were
  // not polling, and older than 90 days): refresh them so they don't linger as stale inbox rows.
  const inboxSet = new Set(inbox);
  const stale = (db.prepare('SELECT gmail_thread_id FROM threads WHERE account_id = ? AND in_inbox = 1').pluck().all(accountId) as string[])
    .filter((id) => !inboxSet.has(id) && !seen.has(id));
  await index(stale);

  db.transaction(() => {
    db.prepare('UPDATE accounts SET history_id = ? WHERE id = ?').run(pending.historyId, accountId);
    db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  })();
  updateAccountStatus(db, accountId, 'ok');
}

/**
 * Indexes one page of older history (`older_than:90d`), resuming from `accounts.backfill_page_token`.
 * Returns true while more pages remain; false once done, or immediately (doing nothing) when storage is full.
 */
export async function backfillStep(
  db: DB, accountId: string, gmail: GmailApi, canIndexMore: () => boolean, onChange?: ThreadHook, failures?: ThreadFailures,
): Promise<boolean> {
  const acct = db.prepare('SELECT backfill_page_token, backfill_done FROM accounts WHERE id = ?').get(accountId) as
    { backfill_page_token: string | null; backfill_done: number } | undefined;
  if (!acct || acct.backfill_done === 1 || !canIndexMore()) return false;

  const page = await gmail.listThreads({ q: BACKFILL_QUERY, pageToken: acct.backfill_page_token ?? undefined, maxResults: BACKFILL_PAGE });
  const known = db.prepare('SELECT 1 FROM threads WHERE account_id = ? AND gmail_thread_id = ?');
  const own = ownEmailsOf(db);
  const fails = failures ?? threadFailures(db, accountId);
  await mapLimit(page.ids.filter((id) => !known.get(accountId, id)), FETCH_CONCURRENCY, async (id) => {
    await fails.attempt(id, () => fetchAndIndex(db, accountId, gmail, id, own, onChange, 'sync'));
  });

  const more = !!page.nextPageToken;
  db.prepare('UPDATE accounts SET backfill_page_token = ?, backfill_done = ? WHERE id = ?').run(page.nextPageToken ?? null, more ? 0 : 1, accountId);
  return more;
}
