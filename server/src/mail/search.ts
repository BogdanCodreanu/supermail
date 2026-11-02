import type { ThreadId, ThreadPage, ThreadSummaryDTO } from '@supermail/shared';
import { HttpError } from '../errors.js';
import type { AppDeps } from '../http/app.js';
import { ownEmailsOf } from '../sync/indexer.js';
import { fetchAndIndex, mapLimit } from '../sync/initialSync.js';
import { toSummary } from '../threads/queries.js';

export const SEARCH_RESULTS_PER_ACCOUNT = 25;
const FETCH_CONCURRENCY = 5;

/**
 * Gmail search (`q=`) across every connected account in parallel, merged newest first. Threads not yet in the
 * index are indexed in `sync` mode, so they are grouped for display but never treated as new mail; search
 * itself never writes labels. An account that fails is left out rather than failing the whole search.
 */
export async function search(d: AppDeps, q: string): Promise<ThreadPage> {
  const query = q.trim();
  if (!query) throw new HttpError(400, 'empty search');
  const accounts = d.db.prepare("SELECT id FROM accounts WHERE status = 'ok' ORDER BY created_at, rowid").pluck().all() as string[];
  const own = ownEmailsOf(d.db);
  const known = d.db.prepare('SELECT 1 FROM threads WHERE account_id = ? AND gmail_thread_id = ?').pluck();

  const results = await Promise.allSettled(
    accounts.map(async (accountId) => {
      const gmail = d.gmailFor(accountId);
      const { ids } = await gmail.listThreads({ q: query, maxResults: SEARCH_RESULTS_PER_ACCOUNT });
      const found: ThreadId[] = [];
      await mapLimit(ids, FETCH_CONCURRENCY, async (gmailThreadId) => {
        if (!known.get(accountId, gmailThreadId)) {
          if ((await fetchAndIndex(d.db, accountId, gmail, gmailThreadId, own, d.onThreadChange, 'sync')) === 'removed') return;
        }
        found.push(`${accountId}:${gmailThreadId}`);
      });
      return found;
    }),
  );
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (accounts.length > 0 && failures.length === accounts.length) throw failures[0]!.reason;

  const threads: ThreadSummaryDTO[] = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const id of r.value) {
      try {
        threads.push(toSummary(d.db, id));
      } catch {
        /* removed concurrently */
      }
    }
  }
  threads.sort((a, b) => b.lastMessageAt - a.lastMessageAt || (a.id < b.id ? 1 : -1));
  return { threads, nextCursor: null };
}
