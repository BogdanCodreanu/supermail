import { useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { ServerEvent, ThreadDetailDTO, ThreadId, ThreadPage, ThreadSummaryDTO } from '@supermail/shared';
import { bulkSettled } from '../state/toasts';
import { qk } from './client';

type ListData = ThreadPage | InfiniteData<ThreadPage>;
type ThreadFilter = { accountId: string | null; groupId: string | null; includeDone: boolean };

function isInfinite(d: ListData): d is InfiniteData<ThreadPage> {
  return 'pages' in d;
}

function mapPages(d: ListData, fn: (threads: ThreadSummaryDTO[], index: number) => ThreadSummaryDTO[]): ListData {
  if (isInfinite(d)) return { ...d, pages: d.pages.map((p, i) => ({ ...p, threads: fn(p.threads, i) })) };
  return { ...d, threads: fn(d.threads, 0) };
}

function contains(d: ListData, id: ThreadId): boolean {
  const pages = isInfinite(d) ? d.pages : [d];
  return pages.some((p) => p.threads.some((t) => t.id === id));
}

const without = (id: ThreadId) => (threads: ThreadSummaryDTO[]) => threads.filter((t) => t.id !== id);

function matchesInbox(t: ThreadSummaryDTO, f: ThreadFilter): boolean {
  return (t.inInbox || (f.includeDone && t.doneAt != null)) && (f.accountId === null || t.accountId === f.accountId) && (f.groupId === null || t.groupId === f.groupId);
}

/** Inserts into the first page by newest-first order; later pages load it on their own. */
function insertSorted(threads: ThreadSummaryDTO[], t: ThreadSummaryDTO): ThreadSummaryDTO[] {
  const at = threads.findIndex((x) => x.lastMessageAt < t.lastMessageAt);
  if (at === -1) return [...threads, t];
  return [...threads.slice(0, at), t, ...threads.slice(at)];
}

function onThreadUpdated(qc: QueryClient, t: ThreadSummaryDTO): void {
  const lists = qc.getQueriesData<ListData>({ queryKey: ['threads'] });
  // A thread no inbox list knows about has just (re)entered the inbox: new mail, a snooze falling due, a restore
  // or an undo. It is inserted by date, but the server ranks resurfaced threads first even when their last message
  // is old, so when it lands below newer threads the lists are refetched to pick up the server's order.
  const enteringInbox = !lists.some(([, data]) => data && contains(data, t.id));
  let refetch = false;
  for (const [key, data] of lists) {
    if (!data) continue;
    const filter = key[1] as ThreadFilter;
    const present = contains(data, t.id);
    if (!matchesInbox(t, filter)) {
      if (present) qc.setQueryData(key, mapPages(data, without(t.id)));
    } else if (present) {
      qc.setQueryData(key, mapPages(data, (ts) => ts.map((x) => (x.id === t.id ? t : x))));
    } else {
      const first = isInfinite(data) ? (data.pages[0]?.threads ?? []) : data.threads;
      if (enteringInbox && first.some((x) => x.lastMessageAt > t.lastMessageAt)) refetch = true;
      qc.setQueryData(key, mapPages(data, (ts, i) => (i === 0 ? insertSorted(ts, t) : ts)));
    }
  }
  // Not restarted for each thread: an undo of 300 threads must not send 300 refetches.
  if (refetch) void qc.invalidateQueries({ queryKey: ['threads'] }, { cancelRefetch: false });
  for (const [key, data] of qc.getQueriesData<ListData>({ queryKey: ['search'] })) {
    if (data && contains(data, t.id)) qc.setQueryData(key, mapPages(data, (ts) => ts.map((x) => (x.id === t.id ? t : x))));
  }
  const skipped = qc.getQueryData<ListData>(qk.skipped());
  if (skipped && t.inInbox && contains(skipped, t.id)) qc.setQueryData(qk.skipped(), mapPages(skipped, without(t.id)));
  // An indexed thread is not spam any more (rescued in the Gmail app, say).
  const spam = qc.getQueryData<ListData>(qk.spam());
  if (spam && contains(spam, t.id)) qc.setQueryData(qk.spam(), mapPages(spam, without(t.id)));
  const detail = qc.getQueryData<ThreadDetailDTO>(qk.thread(t.id));
  if (detail) {
    qc.setQueryData<ThreadDetailDTO>(qk.thread(t.id), { ...detail, thread: t });
    // A new message: the open thread fetches its messages again, so the reply appears.
    if (t.lastMessageAt > detail.thread.lastMessageAt) void qc.invalidateQueries({ queryKey: qk.thread(t.id), exact: true });
  }
}

/**
 * Many threads changed at once, as the owner just asked: one pass over each cached list, where a `thread.updated` per
 * thread would be a pass each. A thread that no longer fits a list leaves it; the server's events add the rest.
 */
export function patchThreads(qc: QueryClient, changed: ThreadSummaryDTO[]): void {
  const byId = new Map(changed.map((t) => [t.id, t]));
  const patch = (filter?: ThreadFilter) => (threads: ThreadSummaryDTO[]) =>
    threads.flatMap((x) => {
      const t = byId.get(x.id);
      if (!t) return [x];
      return !filter || matchesInbox(t, filter) ? [t] : [];
    });
  for (const [key, data] of qc.getQueriesData<ListData>({ queryKey: ['threads'] })) if (data) qc.setQueryData(key, mapPages(data, patch(key[1] as ThreadFilter)));
  for (const [key, data] of qc.getQueriesData<ListData>({ queryKey: ['search'] })) if (data) qc.setQueryData(key, mapPages(data, patch()));
}

/** Every thread in a cached list, search result or open thread, once each. */
export function cachedThreads(qc: QueryClient): ThreadSummaryDTO[] {
  const found = new Map<ThreadId, ThreadSummaryDTO>();
  for (const prefix of [['threads'], ['search'], qk.skipped()]) {
    for (const [, data] of qc.getQueriesData<ListData>({ queryKey: prefix })) {
      for (const page of !data ? [] : isInfinite(data) ? data.pages : [data]) for (const t of page.threads) found.set(t.id, t);
    }
  }
  for (const [, detail] of qc.getQueriesData<ThreadDetailDTO>({ queryKey: ['thread'] })) if (detail) found.set(detail.thread.id, detail.thread);
  return [...found.values()];
}

/** A bulk spam removes hundreds of threads in a burst, and a read of Gmail's spam costs up to 510 quota units. */
const SPAM_REFRESH_MS = 500;
const spamRefresh = new WeakMap<QueryClient, ReturnType<typeof setTimeout>>();

/** The Spam screen reads Gmail again once the burst is over, never cutting off a read already on its way. */
function refreshSpam(qc: QueryClient): void {
  clearTimeout(spamRefresh.get(qc));
  spamRefresh.set(
    qc,
    setTimeout(() => {
      spamRefresh.delete(qc);
      void qc.invalidateQueries({ queryKey: qk.spam() }, { cancelRefetch: false });
    }, SPAM_REFRESH_MS),
  );
}

function onThreadRemoved(qc: QueryClient, id: ThreadId): void {
  for (const prefix of [['threads'], ['search'], qk.skipped()]) {
    for (const [key, data] of qc.getQueriesData<ListData>({ queryKey: prefix })) {
      if (data && contains(data, id)) qc.setQueryData(key, mapPages(data, without(id)));
    }
  }
  // Leaving the index is what mail going to spam looks like, so the Spam screen reads Gmail again. The row itself
  // stays: the poller also sends this for spam that is still in spam.
  refreshSpam(qc);
}

/** Applies one live server event to the TanStack Query caches. */
export function applyServerEvent(qc: QueryClient, e: ServerEvent): void {
  switch (e.type) {
    case 'thread.updated':
      return onThreadUpdated(qc, e.thread);
    case 'thread.removed':
      return onThreadRemoved(qc, e.id);
    case 'groups.updated':
      // The event carries all-account counts; per-account tabs need their own, so refetch.
      void qc.invalidateQueries({ queryKey: ['groups'] });
      return;
    case 'account.updated':
      void qc.invalidateQueries({ queryKey: qk.accounts() });
      return;
    case 'storage.degraded':
      void qc.invalidateQueries({ queryKey: qk.storage() });
      return;
    case 'bulk.settled':
      refreshSpam(qc); // a bulk spam's removals come before Gmail has it: this is when it is really there
      return bulkSettled(e);
  }
}

/** Subscribes to `/api/events` (SSE) for the lifetime of the component. */
export function useServerEvents(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const es = new EventSource('/api/events');
    let dropped = false;
    es.onmessage = (m: MessageEvent<string>) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(m.data) as ServerEvent;
      } catch {
        return;
      }
      applyServerEvent(qc, event);
    };
    es.onerror = () => {
      dropped = true; // EventSource reconnects by itself (server sends `retry: 5000`)
    };
    es.onopen = () => {
      if (!dropped) return;
      dropped = false;
      void qc.invalidateQueries(); // events may have been missed while disconnected
    };
    return () => es.close();
  }, [qc]);
}
