import type { DB } from '../db/index.js';
import { bus } from '../events.js';
import { GmailAuthRevoked, GmailHistoryExpired, type GmailApi } from '../google/gmailApi.js';
import type { ThreadHook } from '../http/app.js';
import { groupCounts, toSummary } from '../threads/queries.js';
import { ownEmailsOf } from './indexer.js';
import { backfillStep, fetchAndIndex, initialSync, initialSyncPending, mapLimit, type ThreadFailures, threadFailures, updateAccountStatus } from './initialSync.js';

export interface Poller { start(): void; stop(): void; tick(): Promise<void> }

export interface PollerLog {
  error(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
}

export interface PollerDeps {
  db: DB;
  gmailFor: (id: string) => GmailApi;
  intervalMs: number;
  onChange?: ThreadHook;
  canIndexMore?: () => boolean;
  onAfterTick?: () => void;
  /**
   * After a poll: the threads the live history pass found new mail in, classified by then. Only this path can call it:
   * initial sync, a resync, backfill, search and opening a thread never come through here.
   */
  onNewMail?: (accountId: string, threadIds: string[]) => void;
  log?: PollerLog;
  /** Clock for retry backoff and log throttling (tests). */
  now?: () => number;
}

interface AccountRow { id: string; status: string; history_id: string | null; backfill_done: number }

const FETCH_CONCURRENCY = 5;
/** History is polled often so mail notifies quickly. Backfill keeps its own gentler pace, whatever the interval. */
const BACKFILL_EVERY_MS = 30_000;

const consoleLog: PollerLog = {
  error: (obj, msg) => console.error(msg ?? '', obj),
  warn: (obj, msg) => console.warn(msg ?? '', obj),
  info: () => {},
};

/** A revoked or expired grant, or a token we can no longer decrypt (Task 2's TokenDecryptError). */
function needsReconnect(err: unknown): boolean {
  return err instanceof GmailAuthRevoked || (err instanceof Error && (err.name === 'GmailAuthRevoked' || err.name === 'TokenDecryptError'));
}

/** Every thread id a history page touches: added, deleted, relabelled. */
function touchedThreads(history: Awaited<ReturnType<GmailApi['listHistory']>>['history']): Set<string> {
  const ids = new Set<string>();
  for (const h of history) {
    for (const m of h.messages ?? []) if (m.threadId) ids.add(m.threadId);
    for (const list of [h.messagesAdded, h.messagesDeleted, h.labelsAdded, h.labelsRemoved]) {
      for (const e of list ?? []) if (e.message?.threadId) ids.add(e.message.threadId);
    }
  }
  return ids;
}

/**
 * Polls Gmail `history.list` for every connected account. Each account is handled independently, so one
 * account's failure (revoked grant, expired history, network) never blocks the others (Review Focus 1, 2), and
 * each has its own in-flight guard, so one account's long initial sync or backfill never delays polling of the
 * others: the timer keeps firing and only starts accounts that are idle.
 */
export function createPoller(deps: PollerDeps): Poller {
  const { db, gmailFor, intervalMs } = deps;
  const log = deps.log ?? consoleLog;
  const now = deps.now ?? Date.now;
  const canIndexMore = deps.canIndexMore ?? (() => true);
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let tickInFlight: Promise<void> | undefined;
  /** Per account: the poll in progress, resolving to whether it changed anything. */
  const polls = new Map<string, Promise<boolean>>();
  const backfillEvery = Math.max(1, Math.round(BACKFILL_EVERY_MS / intervalMs));
  /** Per account: polls since its last backfill step. */
  const sinceBackfill = new Map<string, number>();

  function backfillDue(accountId: string): boolean {
    const polled = (sinceBackfill.get(accountId) ?? backfillEvery - 1) + 1;
    sinceBackfill.set(accountId, polled % backfillEvery);
    return polled >= backfillEvery;
  }

  async function syncHistory(account: AccountRow, gmail: GmailApi, failures: ThreadFailures, onChange: ThreadHook, onRemoved: (threadId: string) => void): Promise<void> {
    const own = ownEmailsOf(db);
    const fetch = async (gmailThreadId: string) => {
      // Gone before this fetch means the screen was told when it went: a bulk spam of 300 must not say so 600 times.
      const known = !!db.prepare('SELECT 1 FROM threads WHERE account_id = ? AND gmail_thread_id = ?').get(account.id, gmailThreadId);
      const result = await failures.attempt(gmailThreadId, () => fetchAndIndex(db, account.id, gmail, gmailThreadId, own, onChange, 'live'));
      if (result === 'removed' && known) onRemoved(`${account.id}:${gmailThreadId}`);
    };
    const start = account.history_id!;
    let pageToken: string | undefined;
    do {
      const page = await gmail.listHistory(start, pageToken);
      await mapLimit([...touchedThreads(page.history)], FETCH_CONCURRENCY, fetch);
      pageToken = page.nextPageToken;
      // Advance after each page is indexed, so a failure replays only the page that failed. Mid-way the
      // checkpoint is the page's last record; after the last page it is the mailbox's current historyId.
      const checkpoint = pageToken ? page.history.at(-1)?.id : page.historyId || start;
      if (checkpoint) db.prepare('UPDATE accounts SET history_id = ? WHERE id = ?').run(checkpoint, account.id);
    } while (pageToken);
    // Threads parked after repeated failures (here, in initial sync or backfill) are retried with backoff.
    await mapLimit(failures.due(), FETCH_CONCURRENCY, fetch);
  }

  async function pollAccount(account: AccountRow): Promise<boolean> {
    const changed = new Set<string>();
    const removed = new Set<string>();
    const fresh = new Set<string>();
    let resynced = false;
    const onChange: ThreadHook = (threadId, reason) => {
      changed.add(threadId);
      if (reason === 'new') fresh.add(threadId);
      deps.onChange?.(threadId, reason);
    };
    const onRemoved = (threadId: string) => {
      removed.add(threadId);
    };

    try {
      const gmail = gmailFor(account.id);
      const failures = threadFailures(db, account.id, log, now);
      if (account.history_id === null || initialSyncPending(db, account.id)) {
        await initialSync(db, account.id, gmail, deps.onChange, failures);
        resynced = true;
      } else {
        try {
          await syncHistory(account, gmail, failures, onChange, onRemoved);
        } catch (err) {
          if (!(err instanceof GmailHistoryExpired)) throw err;
          log.warn({ accountId: account.id }, 'Gmail history expired; running a full resync');
          await initialSync(db, account.id, gmail, deps.onChange, failures);
          resynced = true;
        }
      }
      if (account.backfill_done === 0 && canIndexMore() && backfillDue(account.id)) {
        await backfillStep(db, account.id, gmail, canIndexMore, deps.onChange, failures);
      }
    } catch (err) {
      if (needsReconnect(err)) {
        log.warn({ accountId: account.id, err: (err as Error).message }, 'Gmail access revoked; account needs reconnect');
        updateAccountStatus(db, account.id, 'reconnect_needed');
      } else {
        log.error({ accountId: account.id, err }, 'Gmail sync failed; retrying next tick');
      }
    } finally {
      for (const id of changed) {
        if (removed.has(id)) continue;
        try {
          bus.publish({ type: 'thread.updated', thread: toSummary(db, id) });
        } catch {
          // Removed from the index after it changed (e.g. deleted in the same tick).
        }
      }
      for (const id of removed) bus.publish({ type: 'thread.removed', id });
      if (fresh.size > 0) {
        try {
          deps.onNewMail?.(account.id, [...fresh]);
        } catch (err) {
          log.error({ accountId: account.id, err }, 'onNewMail failed');
        }
      }
    }
    const anyChange = resynced || changed.size > 0 || removed.size > 0;
    if (anyChange) bus.publish({ type: 'groups.updated', groups: groupCounts(db) });
    return anyChange;
  }

  /** Starts a poll of `account` unless one is already running, and returns the running poll. */
  function pollOnce(account: AccountRow): Promise<boolean> {
    let p = polls.get(account.id);
    if (!p) {
      p = pollAccount(account).finally(() => polls.delete(account.id));
      polls.set(account.id, p);
    }
    return p;
  }

  function accountsToPoll(): AccountRow[] {
    // A reconnect_needed account is skipped entirely until Task 2's reconnect sets it back to 'syncing'.
    return db.prepare("SELECT id, status, history_id, backfill_done FROM accounts WHERE status != 'reconnect_needed' ORDER BY created_at, id").all() as AccountRow[];
  }

  function afterTick(): void {
    try {
      deps.onAfterTick?.();
    } catch (err) {
      log.error({ err }, 'onAfterTick failed');
    }
  }

  /** Every account, joining polls already in flight; resolves once all are done. */
  async function runTick(): Promise<void> {
    await Promise.all(accountsToPoll().map(pollOnce));
    afterTick();
  }

  /** A timer fire: starts only idle accounts and never waits for an account that is still busy. */
  function fire(): void {
    let started: Promise<boolean>[];
    try {
      started = accountsToPoll().filter((a) => !polls.has(a.id)).map(pollOnce);
    } catch (err) {
      log.error({ err }, 'poller tick failed');
      return;
    }
    void Promise.all(started).then(afterTick, (err: unknown) => log.error({ err }, 'poller tick failed'));
  }

  const poller: Poller = {
    tick() {
      // Overlapping calls share the tick already in progress.
      tickInFlight ??= runTick().finally(() => {
        tickInFlight = undefined;
      });
      return tickInFlight;
    },
    start() {
      if (running) return;
      running = true;
      const loop = () => {
        if (!running) return;
        fire();
        timer = setTimeout(loop, intervalMs);
      };
      loop();
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
  return poller;
}
