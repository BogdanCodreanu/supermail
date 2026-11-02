import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { MatchType, TeachAction, ThreadSummaryDTO } from '@supermail/shared';
import { applyServerEvent, cachedThreads } from '../api/events';
import { senderOf } from '../components/ThreadRow';

/** What a teaching or a move reaches: its match, or just the one email. */
export type TeachScope = MatchType | 'thread';
export interface GroupRef { id: string; name: string }

// Built-in group ids equal their builtin_key; teaching marks land in these two.
export const IMPORTANT = 'important';
export const LOW_PRIORITY = 'low_priority';

/** Every cache an optimistic change can touch (lists, search results, skipped, open threads). */
export const THREAD_CACHES = { predicate: (q: { queryKey: QueryKey }) => ['threads', 'search', 'skipped', 'thread'].includes(q.queryKey[0] as string) };

export function domainOf(t: Pick<ThreadSummaryDTO, 'fromEmail'>): string | null {
  const at = t.fromEmail?.lastIndexOf('@') ?? -1;
  return at >= 0 ? t.fromEmail!.slice(at + 1).toLowerCase() : null;
}

function matches(x: ThreadSummaryDTO, t: ThreadSummaryDTO, scope: TeachScope): boolean {
  if (x.id === t.id) return true;
  if (scope === 'sender') return !!t.fromEmail && x.fromEmail?.toLowerCase() === t.fromEmail.toLowerCase();
  if (scope === 'domain') return domainOf(t) !== null && domainOf(x) === domainOf(t);
  if (scope === 'list') return !!t.listId && x.listId === t.listId;
  return false;
}

/** Moves every cached thread in `scope` to the group, in every cached list, and returns how to put them back. */
export function moveOptimistically(qc: QueryClient, t: ThreadSummaryDTO, scope: TeachScope, group: GroupRef): () => void {
  const snapshot = qc.getQueriesData(THREAD_CACHES);
  const reached = cachedThreads(qc).filter((x) => matches(x, t, scope));
  for (const x of reached.some((r) => r.id === t.id) ? reached : [t, ...reached]) {
    applyServerEvent(qc, { type: 'thread.updated', thread: { ...x, groupId: group.id, groupName: group.name, suggestRule: false } });
  }
  return () => {
    for (const [key, data] of snapshot) qc.setQueryData(key, data);
  };
}

/** The heading of the scope prompt. */
export function scopeTitle(action: TeachAction, groupName: string): string {
  if (action === 'important') return 'Mark as important';
  return action === 'not_important' ? 'Mark as not important' : `Always group to ${groupName}`;
}

const subjectOf = (t: Pick<ThreadSummaryDTO, 'subject'>) => t.subject || '(no subject)';
export const emails = (n: number) => `${n} email${n === 1 ? '' : 's'}`;

/** "Weekend la Brașov? · Done" */
export const actedOn = (t: Pick<ThreadSummaryDTO, 'subject'>, what: string) => `${subjectOf(t)} · ${what}`;

/** "Weekend la Brașov? → Dev" */
export const movedMessage = (t: Pick<ThreadSummaryDTO, 'subject'>, groupName: string) => `${subjectOf(t)} → ${groupName}`;

/** "12 emails from Jordan → Jordan", "Alibaba.com → Low priority · 31 emails"; no count when nothing moved. */
export function teachMessage(t: ThreadSummaryDTO, action: TeachAction, scope: MatchType, groupName: string, affected = 0): string {
  const who = scope === 'list' ? 'This list' : scope === 'domain' ? (domainOf(t) ?? senderOf(t)) : senderOf(t);
  if (affected === 0) return `${who} → ${groupName}`;
  if (action !== 'always_group') return `${who} → ${groupName} · ${emails(affected)}`;
  return `${emails(affected)} from ${scope === 'list' ? 'this list' : who} → ${groupName}`;
}
