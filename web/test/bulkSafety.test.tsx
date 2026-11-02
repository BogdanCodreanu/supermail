import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountDTO, BulkRequest, GroupDTO, ThreadPage, ThreadSummaryDTO } from '@supermail/shared';

const api = vi.hoisted(() => ({
  me: vi.fn(),
  accounts: vi.fn(),
  groups: vi.fn(),
  threads: vi.fn(),
  done: vi.fn(),
  snooze: vi.fn(),
  read: vi.fn(),
  undo: vi.fn(),
  reportSpam: vi.fn(),
  bulk: vi.fn(),
  teachBulk: vi.fn(),
  teachPreview: vi.fn(),
}));
vi.mock('../src/api/client', async (importOriginal) => ({ ...(await importOriginal<object>()), api }));

const { applyServerEvent } = await import('../src/api/events');
const { qk } = await import('../src/api/client');
const { AppToasts, bulkSettled, resetToasts, showBulkToast, showToast, useAppToast } = await import('../src/state/toasts');

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settled = (undoId: string, affected: number, failed: string[], skipped: string[] = []) => ({ type: 'bulk.settled' as const, undoId, affected, failed, skipped });

describe('review #4: the Spam screen under a burst of removals', () => {
  it('C1 refetches once for 300 removals, not 299 times', async () => {
    const qc = new QueryClient();
    const fn = vi.fn(async () => ({ threads: [], nextCursor: null }));
    const off = new QueryObserver(qc, { queryKey: qk.spam(), queryFn: fn }).subscribe(() => {});
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    fn.mockClear();
    for (let i = 0; i < 300; i++) {
      applyServerEvent(qc, { type: 'thread.removed', id: `a:t-${i}` });
      await pause(0); // each SSE message is its own task
    }
    expect(fn).not.toHaveBeenCalled(); // still inside the debounce
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1), { timeout: 1500 });
    await pause(600);
    expect(fn).toHaveBeenCalledTimes(1);
    off();
  });

  it('never cancels a read already on its way', async () => {
    const qc = new QueryClient();
    let aborted = false;
    let finish = (_: ThreadPage) => {};
    const fn = vi.fn(({ signal }: { signal: AbortSignal }) => {
      signal.addEventListener('abort', () => (aborted = true));
      return new Promise<ThreadPage>((resolve) => (finish = resolve));
    });
    const off = new QueryObserver(qc, { queryKey: qk.spam(), queryFn: fn }).subscribe(() => {});
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    applyServerEvent(qc, { type: 'thread.removed', id: 'a:t-0' });
    await pause(600);
    expect(aborted).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
    finish({ threads: [], nextCursor: null });
    off();
  });

  it('reads Gmail again when a bulk action settles: only then is the spam really there', async () => {
    const qc = new QueryClient();
    const fn = vi.fn(async () => ({ threads: [], nextCursor: null }));
    const off = new QueryObserver(qc, { queryKey: qk.spam(), queryFn: fn }).subscribe(() => {});
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    fn.mockClear();
    applyServerEvent(qc, settled('u', 3, []));
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1), { timeout: 1500 });
    off();
  });

  it('api.spam hands the abort signal to fetch', async () => {
    const real = await vi.importActual<typeof import('../src/api/client')>('../src/api/client');
    const fetchMock = vi.fn(async () => new Response('{"threads":[],"nextCursor":null}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { signal } = new AbortController();
    await real.api.spam(signal);
    expect(fetchMock).toHaveBeenCalledWith('/api/spam', expect.objectContaining({ signal }));
    vi.unstubAllGlobals();
  });
});

describe('review #6: a late bulk failure', () => {
  beforeEach(() => resetToasts());

  it('C2 never takes over the undo of a newer toast', () => {
    const { result, rerender } = renderHook(() => useAppToast());
    showBulkToast((n) => `${n} done`, { undoId: 'bulk-1', affected: 300, failed: [] });
    showToast('Snoozed', { undoId: 'single-2' });
    bulkSettled(settled('bulk-1', 297, ['x', 'y', 'z']));
    rerender();
    expect(result.current?.undoId).toBe('single-2');
    expect(result.current?.message).toContain('Snoozed');
    expect(result.current?.message).toContain('297 done · 3 failed');
    expect(result.current?.tone).toBe('error');
  });

  it('keeps its own undo while its toast is still up', () => {
    const { result, rerender } = renderHook(() => useAppToast());
    showBulkToast((n) => `${n} done`, { undoId: 'bulk-1', affected: 300, failed: [] });
    bulkSettled(settled('bulk-1', 297, ['x', 'y', 'z']));
    rerender();
    expect(result.current).toMatchObject({ message: '297 done · 3 failed', undoId: 'bulk-1', tone: 'error' });
  });

  it('offers no undo once its own toast has gone', () => {
    const { result, rerender } = renderHook(() => useAppToast());
    showBulkToast((n) => `${n} done`, { undoId: 'bulk-1', affected: 300, failed: [] });
    act(() => showToast('Copied'));
    bulkSettled(settled('bulk-1', 297, ['x', 'y', 'z']));
    rerender();
    expect(result.current).toMatchObject({ message: '297 done · 3 failed', tone: 'error' });
    expect(result.current?.undoId).toBeUndefined();
  });

  it('says how many threads stood down for new mail, without calling it an error', () => {
    const { result, rerender } = renderHook(() => useAppToast());
    showBulkToast((n) => `${n} done`, { undoId: 'bulk-1', affected: 300, failed: [] });
    bulkSettled(settled('bulk-1', 298, [], ['x', 'y']));
    rerender();
    expect(result.current).toMatchObject({ message: '298 done · 2 skipped: new mail', undoId: 'bulk-1', tone: 'info' });
  });

  it('says so even when the event beats the answer', () => {
    const { result, rerender } = renderHook(() => useAppToast());
    bulkSettled(settled('bulk-1', 298, [], ['x', 'y']));
    showBulkToast((n) => `${n} done`, { undoId: 'bulk-1', affected: 300, failed: [] });
    rerender();
    expect(result.current?.message).toBe('298 done · 2 skipped: new mail');
  });
});

describe('item 11: the toast of a bulk action', () => {
  beforeEach(() => {
    resetToasts();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const renderToasts = () =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <AppToasts />
        </MemoryRouter>
      </QueryClientProvider>,
    );

  it('stays 15 s', () => {
    renderToasts();
    act(() => showBulkToast((n) => `${n} done`, { undoId: 'bulk-1', affected: 300, failed: [] }));
    act(() => void vi.advanceTimersByTime(14_900));
    expect(screen.getByText('300 done')).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(200));
    expect(screen.queryByText('300 done')).not.toBeInTheDocument();
  });

  it('leaves a single action at 5 s', () => {
    renderToasts();
    act(() => showToast('Done', { undoId: 'one' }));
    act(() => void vi.advanceTimersByTime(4_900));
    expect(screen.getByText('Done')).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(200));
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
  });
});

const PAGE = 50;
const accounts: AccountDTO[] = [{ id: 'a', email: 'me@a.com', color: '#2563eb', status: 'ok' }];
const GROUPS: GroupDTO[] = [{ id: 'important', name: 'Important', position: 0, color: '#64748b', notify: false, kind: 'builtin', inboxCount: 7, unreadCount: 0 }];

function thread(n: number, sender = n): ThreadSummaryDTO {
  return {
    id: `a:${n}`, accountId: 'a', subject: `Subject ${n}`, snippet: `snippet ${n}`, fromName: `Sender ${sender}`, fromEmail: `s${sender}@example.com`, lastMessageAt: 100_000 - n, unread: false, inInbox: true,
    groupId: 'important', groupName: 'Important', reason: { source: 'mark', text: `Reason ${n}`, at: null }, snoozedUntil: null, hasAttachments: false, suggestRule: false,
  };
}

async function renderInbox() {
  vi.resetModules(); // the list remembers its selection and cursor from one screen to the next
  const { Inbox } = await import('../src/views/Inbox');
  const { AppToasts } = await import('../src/state/toasts');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<Inbox />} />
        </Routes>
        <AppToasts />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByText('Subject 0');
  return qc;
}

function press(key: string, init: KeyboardEventInit = {}) {
  act(() => {
    fireEvent.keyDown(document.body, { key, ...init });
  });
}
const checkedRows = () => [...document.querySelectorAll('[data-testid="thread-row"][aria-checked="true"]')].map((el) => el.getAttribute('data-thread-id'));

let all: ThreadSummaryDTO[];
/** Page requests wait here while set, so a test can act during Ctrl+A's loading. */
let gate: Promise<void> | null;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
  Element.prototype.scrollTo ??= () => {};
  all = Array.from({ length: 6 }, (_, i) => thread(i));
  gate = null;
  for (const fn of Object.values(api)) fn.mockReset();
  api.accounts.mockResolvedValue(accounts);
  api.groups.mockResolvedValue(GROUPS);
  api.threads.mockImplementation(async (q: { cursor?: string | null } = {}): Promise<ThreadPage> => {
    if (q.cursor && gate) await gate;
    const at = q.cursor ? Number(q.cursor) : 0;
    return { threads: all.slice(at, at + PAGE), nextCursor: at + PAGE < all.length ? String(at + PAGE) : null };
  });
  api.bulk.mockImplementation(async (r: BulkRequest) => ({ undoId: 'u-bulk', affected: r.ids.length, failed: [] }));
  api.done.mockResolvedValue({ undoId: 'u-one', thread: null });
  resetToasts();
});

describe('item 11: bulk spam asks first', () => {
  const selectRows = (n: number) => {
    for (let i = 0; i < n; i++) press('x');
  };

  it('asks before reporting 10 or more threads, with the sender count', async () => {
    all = Array.from({ length: 12 }, (_, i) => thread(i, i % 3));
    await renderInbox();
    selectRows(12);
    press('!');
    const dialog = await screen.findByRole('dialog', { name: 'Report 12 emails as spam?' });
    expect(dialog).toHaveTextContent('From 3 senders');
    expect(api.bulk).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog, { key: 'Enter' });
    await waitFor(() => expect(api.bulk).toHaveBeenCalledTimes(1));
    expect(api.bulk.mock.calls[0]![0]).toMatchObject({ action: 'spam' });
    expect(api.bulk.mock.calls[0]![0].ids).toHaveLength(12);
  });

  it('Escape reports nothing and keeps the selection', async () => {
    all = Array.from({ length: 10 }, (_, i) => thread(i));
    await renderInbox();
    selectRows(10);
    press('!');
    const dialog = await screen.findByRole('dialog', { name: 'Report 10 emails as spam?' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.bulk).not.toHaveBeenCalled();
    expect(checkedRows()).toHaveLength(10);
  });

  it('goes straight through for fewer than 10', async () => {
    all = Array.from({ length: 9 }, (_, i) => thread(i));
    await renderInbox();
    selectRows(9);
    press('!');
    await waitFor(() => expect(api.bulk).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('review #8: while Ctrl+A is loading', () => {
  const ctrlA = () => press('a', { ctrlKey: true });
  const loading = () => waitFor(() => expect(screen.getByTestId('bulk-bar')).toHaveTextContent('Selecting'));
  const pagesAsked = () => api.threads.mock.calls.filter(([q]) => q?.cursor).length;

  beforeEach(() => {
    all = Array.from({ length: 170 }, (_, i) => thread(i));
  });

  it('triage keys do nothing', async () => {
    let open = () => {};
    gate = new Promise((r) => (open = r));
    await renderInbox();
    ctrlA();
    await loading();
    for (const key of ['e', '!', 'u']) press(key);
    await pause(10);
    expect(api.done).not.toHaveBeenCalled();
    expect(api.reportSpam).not.toHaveBeenCalled();
    expect(api.read).not.toHaveBeenCalled();
    expect(api.bulk).not.toHaveBeenCalled();
    gate = null;
    open();
    await waitFor(() => expect(checkedRows().length).toBeGreaterThan(0));
    expect(document.querySelector('[data-thread-id="a:0"]')).toHaveAttribute('aria-checked', 'true');
  });

  it('stops, and ticks nothing, if the row it started from leaves the list', async () => {
    let open = () => {};
    gate = new Promise((r) => (open = r));
    const qc = await renderInbox();
    ctrlA();
    await loading();
    act(() => applyServerEvent(qc, { type: 'thread.removed', id: 'a:0' }));
    await waitFor(() => expect(screen.queryByTestId('bulk-bar')).not.toBeInTheDocument());
    expect(await screen.findByText(/nothing selected/)).toBeInTheDocument();
    open(); // the page on its way changes nothing now
    await pause(20);
    expect(checkedRows()).toEqual([]);
    expect(pagesAsked()).toBe(1); // of the two still to load
  });

  it('stays quiet when the owner leaves for another list', async () => {
    let open = () => {};
    gate = new Promise((r) => (open = r));
    await renderInbox();
    ctrlA();
    await loading();
    press('`'); // the next account: a new list, so the selection is over
    await waitFor(() => expect(screen.queryByTestId('bulk-bar')).not.toBeInTheDocument());
    open();
    await pause(20);
    expect(screen.queryByText(/nothing selected/)).not.toBeInTheDocument();
  });

  it('Escape stops the loading', async () => {
    let open = () => {};
    gate = new Promise((r) => (open = r));
    await renderInbox();
    ctrlA();
    await loading();
    press('Escape');
    await waitFor(() => expect(screen.queryByTestId('bulk-bar')).not.toBeInTheDocument());
    open();
    await pause(20);
    expect(checkedRows()).toEqual([]);
    expect(pagesAsked()).toBe(1);
  });
});
