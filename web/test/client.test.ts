import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupReasonDTO, ServerEvent, ThreadPage, ThreadSummaryDTO } from '@supermail/shared';
import { api, ApiError, attachmentUrl, qk } from '../src/api/client';
import { applyServerEvent, useServerEvents } from '../src/api/events';

function json(body: unknown, status = 200) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => json({ undoId: 'u1', thread: null }));
  vi.stubGlobal('fetch', fetchMock);
  assign = vi.fn();
  vi.stubGlobal('location', { pathname: '/', assign });
});

function lastCall() {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init, headers: new Headers(init.headers) };
}

describe('api client', () => {
  it('api.done posts to the encoded thread URL with the x-supermail header', async () => {
    await expect(api.done('a:1')).resolves.toEqual({ undoId: 'u1', thread: null });
    const { url, init, headers } = lastCall();
    expect(url).toBe('/api/threads/a%3A1/done');
    expect(init.method).toBe('POST');
    expect(headers.get('x-supermail')).toBe('1');
  });

  it('GET requests carry no x-supermail header and build query strings without empty values', async () => {
    fetchMock.mockResolvedValueOnce(json({ threads: [], nextCursor: null }));
    await api.threads({ groupId: 'dev', accountId: null, cursor: '10:a:1', limit: 2 });
    const { url, init, headers } = lastCall();
    expect(url).toBe('/api/threads?groupId=dev&cursor=10%3Aa%3A1&limit=2');
    expect(init.method ?? 'GET').toBe('GET');
    expect(headers.has('x-supermail')).toBe(false);
  });

  it('asks for done threads only when told to', async () => {
    fetchMock.mockResolvedValueOnce(json({ threads: [], nextCursor: null }));
    await api.threads({ groupId: 'dev', includeDone: true });
    expect(lastCall().url).toBe('/api/threads?groupId=dev&includeDone=1');
    fetchMock.mockResolvedValueOnce(json({ threads: [], nextCursor: null }));
    await api.threads({ groupId: 'dev', includeDone: false });
    expect(lastCall().url).toBe('/api/threads?groupId=dev');
  });

  it('sends JSON bodies for actions', async () => {
    await api.snooze('a:1', 1_800_000_000_000);
    expect(lastCall().init.body).toBe(JSON.stringify({ until: 1_800_000_000_000 }));
    expect(lastCall().headers.get('content-type')).toBe('application/json');
    await api.move('a:1', 'dev');
    expect(lastCall().url).toBe('/api/threads/a%3A1/move');
    expect(lastCall().init.body).toBe(JSON.stringify({ groupId: 'dev' }));
    await api.read('a:1', false);
    expect(lastCall().init.body).toBe(JSON.stringify({ read: false }));
    await api.teach({ threadId: 'a:1', action: 'not_important', scope: 'domain' });
    expect(lastCall().url).toBe('/api/teach');
    await api.undo('u/1');
    expect(lastCall().url).toBe('/api/undo/u%2F1');
    await api.restore('a:9');
    expect(lastCall().url).toBe('/api/skipped/a%3A9/restore');
  });

  it('maps every remaining route', async () => {
    const calls: [() => Promise<unknown>, string, string][] = [
      [() => api.me(), 'GET', '/api/me'],
      [() => api.accounts(), 'GET', '/api/accounts'],
      [() => api.groups(), 'GET', '/api/groups'],
      [() => api.groups('acc1'), 'GET', '/api/groups?accountId=acc1'],
      [() => api.thread('a:1'), 'GET', '/api/threads/a%3A1'],
      [() => api.unsnooze('a:1'), 'POST', '/api/threads/a%3A1/unsnooze'],
      [() => api.send({ accountId: 'a', to: ['x@y'], cc: [], bcc: [], subject: 's', text: 't' }), 'POST', '/api/send'],
      [() => api.search('from:bolt is:unread'), 'GET', '/api/search?q=from%3Abolt+is%3Aunread'],
      [() => api.skipped(), 'GET', '/api/skipped'],
      [() => api.filters(), 'GET', '/api/filters'],
      [() => api.storage(), 'GET', '/api/storage'],
      [() => api.labels(), 'GET', '/api/labels'],
      [() => api.createGroup({ name: 'Legal', existingLabelName: 'Legal' }), 'POST', '/api/groups'],
      [() => api.patchGroup('g1', { name: 'X', position: 2 }), 'PATCH', '/api/groups/g1'],
      [() => api.deleteGroup('g1'), 'DELETE', '/api/groups/g1'],
      [() => api.removeAccount('acc 1'), 'DELETE', '/api/accounts/acc%201'],
      [() => api.logout(), 'POST', '/auth/logout'],
    ];
    for (const [call, method, url] of calls) {
      await call();
      expect(lastCall().url).toBe(url);
      expect(lastCall().init.method ?? 'GET').toBe(method);
      expect(lastCall().headers.get('x-supermail')).toBe(method === 'GET' ? null : '1');
      expect(lastCall().init.credentials).toBe('same-origin');
    }
  });

  it('resolves empty bodies (204) to undefined', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(api.deleteGroup('g1')).resolves.toBeUndefined();
  });

  it('401 sends the browser to /login and rejects', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'unauthorized' }, 401));
    await expect(api.me()).rejects.toMatchObject({ status: 401 });
    expect(assign).toHaveBeenCalledWith('/login');
  });

  it('401 on the login page does not redirect again', async () => {
    vi.stubGlobal('location', { pathname: '/login', assign });
    fetchMock.mockResolvedValueOnce(json({ error: 'unauthorized' }, 401));
    await expect(api.me()).rejects.toBeInstanceOf(ApiError);
    expect(assign).not.toHaveBeenCalled();
  });

  it('other errors reject with the server message and status', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'until must be in the future' }, 400));
    await expect(api.snooze('a:1', 1)).rejects.toMatchObject({ status: 400, message: 'until must be in the future' });
    expect(assign).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------

const reason: GroupReasonDTO = { source: 'heuristic', text: 'In Dev: github.com (automatic guess)', at: null };
function thread(id: string, over: Partial<ThreadSummaryDTO> = {}): ThreadSummaryDTO {
  return {
    id, accountId: id.split(':')[0]!, subject: `s ${id}`, snippet: '', fromName: null, fromEmail: 'x@github.com',
    lastMessageAt: 100, unread: false, inInbox: true, groupId: 'dev', groupName: 'Dev', reason,
    snoozedUntil: null, hasAttachments: false, suggestRule: false, ...over,
  };
}
const page = (...threads: ThreadSummaryDTO[]): ThreadPage => ({ threads, nextCursor: null });
const ids = (p: ThreadPage | undefined) => p?.threads.map((t) => t.id);

describe('applyServerEvent', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient();
  });

  describe('lists that include done threads', () => {
    const withDone = qk.threads({ includeDone: true });
    const list = () => qc.getQueryData<ThreadPage>(withDone);

    it('keeps its own cache, apart from the plain list', () => {
      expect(withDone).not.toEqual(qk.threads({}));
      expect(qk.threads({ includeDone: false })).toEqual(qk.threads({}));
    });

    it('a thread marked done stays there, updated, and leaves the plain list', () => {
      qc.setQueryData(withDone, page(thread('a:1')));
      qc.setQueryData(qk.threads({}), page(thread('a:1')));
      applyServerEvent(qc, { type: 'thread.updated', thread: thread('a:1', { inInbox: false, doneAt: 500 }) });
      expect(list()?.threads[0]).toMatchObject({ id: 'a:1', doneAt: 500 });
      expect(ids(qc.getQueryData(qk.threads({})))).toEqual([]);
    });

    it('a change to a done thread keeps it listed', () => {
      qc.setQueryData(withDone, page(thread('a:1', { inInbox: false, doneAt: 500 })));
      applyServerEvent(qc, { type: 'thread.updated', thread: thread('a:1', { inInbox: false, doneAt: 500, unread: true }) });
      expect(list()?.threads[0]?.unread).toBe(true);
    });

    it('a thread leaving the inbox without Done (snoozed, archived in Gmail) leaves the list', () => {
      qc.setQueryData(withDone, page(thread('a:1')));
      applyServerEvent(qc, { type: 'thread.updated', thread: thread('a:1', { inInbox: false, doneAt: null }) });
      expect(ids(list())).toEqual([]);
    });

    it('still follows the group filter', () => {
      const dev = qk.threads({ groupId: 'dev', includeDone: true });
      qc.setQueryData(dev, page(thread('a:1', { inInbox: false, doneAt: 500 })));
      applyServerEvent(qc, { type: 'thread.updated', thread: thread('a:1', { inInbox: false, doneAt: 500, groupId: 'news' }) });
      expect(ids(qc.getQueryData(dev))).toEqual([]);
    });
  });

  it('thread.updated replaces a thread in place in every list that still matches', () => {
    qc.setQueryData(qk.threads({}), page(thread('a:1', { lastMessageAt: 300 }), thread('a:2', { lastMessageAt: 200 })));
    applyServerEvent(qc, { type: 'thread.updated', thread: thread('a:2', { lastMessageAt: 200, unread: true }) });
    const all = qc.getQueryData<ThreadPage>(qk.threads({}));
    expect(ids(all)).toEqual(['a:1', 'a:2']);
    expect(all?.threads[1]?.unread).toBe(true);
  });

  it('thread.updated moves a thread between group lists and keeps newest-first order', () => {
    qc.setQueryData(qk.threads({ groupId: 'dev' }), page(thread('a:1', { lastMessageAt: 300 })));
    qc.setQueryData(qk.threads({ groupId: 'news' }), page(thread('a:5', { groupId: 'news', lastMessageAt: 500 }), thread('a:6', { groupId: 'news', lastMessageAt: 100 })));
    applyServerEvent(qc, { type: 'thread.updated', thread: thread('a:1', { groupId: 'news', groupName: 'News', lastMessageAt: 300 }) });
    expect(ids(qc.getQueryData(qk.threads({ groupId: 'dev' })))).toEqual([]);
    expect(ids(qc.getQueryData(qk.threads({ groupId: 'news' })))).toEqual(['a:5', 'a:1', 'a:6']);
  });

  it('thread.updated respects the account filter and drops threads that left the inbox', () => {
    qc.setQueryData(qk.threads({ accountId: 'b' }), page(thread('b:1')));
    qc.setQueryData(qk.threads({}), page(thread('a:1')));
    applyServerEvent(qc, { type: 'thread.updated', thread: thread('a:2') });
    expect(ids(qc.getQueryData(qk.threads({ accountId: 'b' })))).toEqual(['b:1']);
    expect(ids(qc.getQueryData(qk.threads({})))).toEqual(['a:1', 'a:2']);
    applyServerEvent(qc, { type: 'thread.updated', thread: thread('a:1', { inInbox: false }) });
    expect(ids(qc.getQueryData(qk.threads({})))).toEqual(['a:2']);
  });

  it('works on infinite-query pages and updates the open thread detail', () => {
    const inf: InfiniteData<ThreadPage> = { pages: [page(thread('a:1', { lastMessageAt: 300 })), page(thread('a:2', { lastMessageAt: 100 }))], pageParams: [null, 'c'] };
    qc.setQueryData(qk.threads({}), inf);
    qc.setQueryData(qk.thread('a:2'), { thread: thread('a:2'), messages: [] });
    applyServerEvent(qc, { type: 'thread.updated', thread: thread('a:2', { lastMessageAt: 100, unread: true }) });
    const after = qc.getQueryData<InfiniteData<ThreadPage>>(qk.threads({}));
    expect(after?.pages.map(ids)).toEqual([['a:1'], ['a:2']]);
    expect(after?.pages[1]?.threads[0]?.unread).toBe(true);
    expect(qc.getQueryData<{ thread: ThreadSummaryDTO }>(qk.thread('a:2'))?.thread.unread).toBe(true);
    applyServerEvent(qc, { type: 'thread.updated', thread: thread('a:9', { lastMessageAt: 900 }) });
    expect(qc.getQueryData<InfiniteData<ThreadPage>>(qk.threads({}))?.pages.map(ids)).toEqual([['a:9', 'a:1'], ['a:2']]);
  });

  it('an old thread re-entering the inbox (resurfaced snooze) refetches the lists for the server order', () => {
    qc.setQueryData(qk.threads({}), page(thread('a:1', { lastMessageAt: 300 }), thread('a:2', { lastMessageAt: 200 })));
    applyServerEvent(qc, { type: 'thread.updated', thread: thread('a:7', { lastMessageAt: 50 }) });
    expect(qc.getQueryState(qk.threads({}))?.isInvalidated).toBe(true);
  });

  it('brand-new mail entering on top does not refetch', () => {
    qc.setQueryData(qk.threads({}), page(thread('a:1', { lastMessageAt: 300 })));
    applyServerEvent(qc, { type: 'thread.updated', thread: thread('a:8', { lastMessageAt: 900 }) });
    expect(ids(qc.getQueryData(qk.threads({})))).toEqual(['a:8', 'a:1']);
    expect(qc.getQueryState(qk.threads({}))?.isInvalidated).toBe(false);
  });

  it('a new message in the open thread reloads it, so the reply shows', () => {
    qc.setQueryData(qk.thread('a:2'), { thread: thread('a:2', { lastMessageAt: 100 }), messages: [] });
    applyServerEvent(qc, { type: 'thread.updated', thread: thread('a:2', { lastMessageAt: 200 }) });
    expect(qc.getQueryState(qk.thread('a:2'))?.isInvalidated).toBe(true);
  });

  it('a change without new mail updates the open thread in place', () => {
    qc.setQueryData(qk.thread('a:2'), { thread: thread('a:2', { lastMessageAt: 100 }), messages: [] });
    applyServerEvent(qc, { type: 'thread.updated', thread: thread('a:2', { lastMessageAt: 100, unread: true }) });
    expect(qc.getQueryState(qk.thread('a:2'))?.isInvalidated).toBe(false);
  });

  it('thread.removed drops the thread from lists, search and skipped', () => {
    qc.setQueryData(qk.threads({}), page(thread('a:1'), thread('a:2')));
    qc.setQueryData(qk.search('bolt'), page(thread('a:1')));
    qc.setQueryData(qk.skipped(), page(thread('a:1', { inInbox: false })));
    applyServerEvent(qc, { type: 'thread.removed', id: 'a:1' });
    expect(ids(qc.getQueryData(qk.threads({})))).toEqual(['a:2']);
    expect(ids(qc.getQueryData(qk.search('bolt')))).toEqual([]);
    expect(ids(qc.getQueryData(qk.skipped()))).toEqual([]);
  });

  it('a thread restored to the inbox leaves the skipped list; search results update in place', () => {
    qc.setQueryData(qk.skipped(), page(thread('a:1', { inInbox: false })));
    qc.setQueryData(qk.search('x'), page(thread('a:1', { inInbox: false })));
    applyServerEvent(qc, { type: 'thread.updated', thread: thread('a:1', { inInbox: true }) });
    expect(ids(qc.getQueryData(qk.skipped()))).toEqual([]);
    expect(qc.getQueryData<ThreadPage>(qk.search('x'))?.threads[0]?.inInbox).toBe(true);
  });

  it.each<[ServerEvent, readonly unknown[]]>([
    [{ type: 'groups.updated', groups: [] }, ['groups']],
    [{ type: 'account.updated', account: { id: 'a', email: 'a@x', color: '#000', status: 'ok' } }, ['accounts']],
    [{ type: 'storage.degraded', degraded: true }, ['storage']],
  ])('%o invalidates %o', (event, key) => {
    const spy = vi.spyOn(qc, 'invalidateQueries');
    applyServerEvent(qc, event);
    expect(spy).toHaveBeenCalledWith({ queryKey: key });
  });
});

describe('useServerEvents', () => {
  class FakeEventSource {
    static last: FakeEventSource | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor(public url: string) {
      FakeEventSource.last = this;
    }
    close() {
      this.closed = true;
    }
  }

  it('subscribes to /api/events, applies events and closes on unmount', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const qc = new QueryClient();
    qc.setQueryData(qk.threads({}), page(thread('a:1')));
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
    const { unmount } = renderHook(() => useServerEvents(), { wrapper });
    const es = FakeEventSource.last!;
    expect(es.url).toBe('/api/events');
    act(() => es.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'thread.removed', id: 'a:1' }) })));
    expect(ids(qc.getQueryData(qk.threads({})))).toEqual([]);
    act(() => es.onmessage?.(new MessageEvent('message', { data: 'not json' })));
    unmount();
    expect(es.closed).toBe(true);
  });

  it('refetches everything after reconnecting, since events may have been missed', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
    renderHook(() => useServerEvents(), { wrapper });
    const es = FakeEventSource.last!;
    act(() => es.onopen?.());
    expect(spy).not.toHaveBeenCalled();
    act(() => {
      es.onerror?.();
      es.onopen?.();
    });
    expect(spy).toHaveBeenCalledWith();
  });
});

describe('attachmentUrl', () => {
  it('encodes ids and adds name and download only when asked', () => {
    expect(attachmentUrl('a', 'm1', 'x/y')).toBe('/api/attachments/a/m1/x%2Fy');
    expect(attachmentUrl('a', 'm1', 'id', { name: 'Poză vară.jpg', download: true })).toBe(
      '/api/attachments/a/m1/id?name=Poz%C4%83+var%C4%83.jpg&download=1',
    );
  });
});

describe('teaching', () => {
  it('lists with GET and removes with an encoded DELETE that carries the api header', async () => {
    fetchMock.mockImplementation(async () => json([]));
    await api.teaching();
    expect(lastCall().url).toBe('/api/teaching');
    expect(lastCall().init.method).toBe('GET');

    await api.deleteTeaching('mark', 'a/b');
    expect(lastCall().url).toBe('/api/teaching/mark/a%2Fb');
    expect(lastCall().init.method).toBe('DELETE');
    expect(lastCall().headers.get('x-supermail')).toBe('1');
    expect(qk.teaching()).toEqual(['teaching']);
  });
});
