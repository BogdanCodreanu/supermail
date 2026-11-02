import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { GroupDTO, ThreadDetailDTO, ThreadPage, ThreadSummaryDTO } from '@supermail/shared';
import { qk } from '../src/api/client';
import { actedOn, movedMessage, moveOptimistically, teachMessage } from '../src/lib/teach';
import { GROUP_PALETTE, nextGroupColor } from '../src/lib/newGroup';

const thread = (id: string, over: Partial<ThreadSummaryDTO> = {}): ThreadSummaryDTO => ({
  id, accountId: 'a', subject: `Subject ${id}`, snippet: '', fromName: 'Jordan', fromEmail: 'jordan@x.com', lastMessageAt: 100, unread: false, inInbox: true,
  groupId: 'news', groupName: 'News', reason: { source: 'default', text: '', at: null }, snoozedUntil: null, hasAttachments: false, suggestRule: false, ...over,
});
const page = (...threads: ThreadSummaryDTO[]): InfiniteData<ThreadPage> => ({ pages: [{ threads, nextCursor: null }], pageParams: [null] });
const ids = (qc: QueryClient, key: readonly unknown[]) => qc.getQueryData<InfiniteData<ThreadPage>>(key)!.pages.flatMap((p) => p.threads.map((t) => t.id));
const groupOf = (qc: QueryClient, key: readonly unknown[], id: string) => qc.getQueryData<InfiniteData<ThreadPage>>(key)!.pages.flatMap((p) => p.threads).find((t) => t.id === id)?.groupId;

const ALL = qk.threads({});
const NEWS = qk.threads({ groupId: 'news' });
const DEV = qk.threads({ groupId: 'dev' });
const target = { id: 'dev', name: 'Dev' };

function cache() {
  const qc = new QueryClient();
  const t1 = thread('t1');
  const t2 = thread('t2', { fromEmail: 'JORDAN@x.com' });
  const bea = thread('bea', { fromName: 'Bea', fromEmail: 'bea@x.com' });
  const other = thread('other', { fromName: 'Zed', fromEmail: 'zed@y.com', listId: 'list.y.com' });
  const listed = thread('listed', { fromName: 'Lou', fromEmail: 'lou@z.com', listId: 'list.y.com' });
  qc.setQueryData(ALL, page(t1, t2, bea, other, listed));
  qc.setQueryData(NEWS, page(t1, t2, bea, other, listed));
  qc.setQueryData(DEV, page());
  return { qc, t1, other };
}

describe('moveOptimistically', () => {
  it('moves every cached thread from the sender, in every cached list', () => {
    const { qc, t1 } = cache();
    moveOptimistically(qc, t1, 'sender', target);
    expect(ids(qc, NEWS)).toEqual(['bea', 'other', 'listed']);
    expect(ids(qc, DEV).sort()).toEqual(['t1', 't2']);
    expect(groupOf(qc, ALL, 't2')).toBe('dev');
    expect(groupOf(qc, ALL, 'bea')).toBe('news');
  });

  it('moves the whole domain', () => {
    const { qc, t1 } = cache();
    moveOptimistically(qc, t1, 'domain', target);
    expect(groupOf(qc, ALL, 'bea')).toBe('dev');
    expect(groupOf(qc, ALL, 'other')).toBe('news');
  });

  it('moves the whole list', () => {
    const { qc, other } = cache();
    moveOptimistically(qc, other, 'list', target);
    expect(groupOf(qc, ALL, 'listed')).toBe('dev');
    expect(groupOf(qc, ALL, 't1')).toBe('news');
  });

  it('moves only the one thread for "only this email"', () => {
    const { qc, t1 } = cache();
    moveOptimistically(qc, t1, 'thread', target);
    expect(groupOf(qc, ALL, 't1')).toBe('dev');
    expect(groupOf(qc, ALL, 't2')).toBe('news');
  });

  it('never matches threads that simply have no sender or list', () => {
    const qc = new QueryClient();
    const a = thread('a', { fromEmail: null, listId: null });
    const b = thread('b', { fromEmail: null, listId: null });
    qc.setQueryData(ALL, page(a, b));
    moveOptimistically(qc, a, 'sender', target);
    moveOptimistically(qc, a, 'list', target);
    expect(groupOf(qc, ALL, 'b')).toBe('news');
  });

  it('reaches search results and open threads too, and drops the rule suggestion', () => {
    const { qc, t1 } = cache();
    qc.setQueryData(qk.search('jordan'), { threads: [thread('t3', { inInbox: false })], nextCursor: null } satisfies ThreadPage);
    qc.setQueryData(qk.thread('t4'), { thread: thread('t4', { suggestRule: true }), messages: [] } satisfies ThreadDetailDTO);
    moveOptimistically(qc, t1, 'sender', target);
    expect(qc.getQueryData<ThreadPage>(qk.search('jordan'))!.threads[0]).toMatchObject({ groupId: 'dev', groupName: 'Dev' });
    expect(qc.getQueryData<ThreadDetailDTO>(qk.thread('t4'))!.thread).toMatchObject({ groupId: 'dev', suggestRule: false });
  });

  it('gives back a rollback', () => {
    const { qc, t1 } = cache();
    const rollback = moveOptimistically(qc, t1, 'sender', target);
    rollback();
    expect(ids(qc, DEV)).toEqual([]);
    expect(groupOf(qc, ALL, 't1')).toBe('news');
  });
});

describe('toast messages', () => {
  const t = thread('t', { subject: 'Weekend la Brașov?', fromName: 'Jordan' });

  it('names the email an action was done on', () => {
    expect(actedOn(t, 'Done')).toBe('Weekend la Brașov? · Done');
    expect(actedOn({ ...t, subject: '' }, 'Done')).toBe('(no subject) · Done');
  });

  it('says who moved where and how many', () => {
    expect(teachMessage(t, 'always_group', 'sender', 'Jordan', 12)).toBe('12 emails from Jordan → Jordan');
    expect(teachMessage(t, 'always_group', 'domain', 'Clients', 40)).toBe('40 emails from x.com → Clients');
    expect(teachMessage(t, 'always_group', 'list', 'News', 8)).toBe('8 emails from this list → News');
    expect(teachMessage(thread('a', { fromName: 'Alibaba.com' }), 'not_important', 'sender', 'Low priority', 31)).toBe('Alibaba.com → Low priority · 31 emails');
    expect(teachMessage(t, 'important', 'sender', 'Important', 1)).toBe('Jordan → Important · 1 email');
  });

  it('leaves the count out when nothing moved', () => {
    expect(teachMessage(t, 'always_group', 'sender', 'Dev', 0)).toBe('Jordan → Dev');
    expect(teachMessage(t, 'important', 'list', 'Important', undefined)).toBe('This list → Important');
  });

  it('names the email for a one-off move', () => {
    expect(movedMessage(t, 'Dev')).toBe('Weekend la Brașov? → Dev');
  });
});

describe('nextGroupColor', () => {
  const g = (color: string) => ({ color }) as GroupDTO;
  it('takes the first colour nobody uses', () => {
    expect(nextGroupColor([g(GROUP_PALETTE[0]!), g('#123456')])).toBe(GROUP_PALETTE[1]);
  });
  it('goes round again when all are taken', () => {
    expect(GROUP_PALETTE).toContain(nextGroupColor(GROUP_PALETTE.map(g)));
  });
});
