import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountDTO, BulkRequest, GroupDTO, ThreadPage, ThreadSummaryDTO } from '@supermail/shared';
import { liftAfterLongPress, pressDown, stubPhone, stubRowWidth, swipe, touchAt } from './phone';

const api = vi.hoisted(() => ({
  me: vi.fn(), accounts: vi.fn(), groups: vi.fn(), threads: vi.fn(), done: vi.fn(), snooze: vi.fn(), move: vi.fn(), read: vi.fn(), teach: vi.fn(), teachPreview: vi.fn(),
  undo: vi.fn(), restore: vi.fn(), reportSpam: vi.fn(), bulk: vi.fn(), teachBulk: vi.fn(),
}));
vi.mock('../src/api/client', async (importOriginal) => ({ ...(await importOriginal<object>()), api }));

const accounts: AccountDTO[] = [{ id: 'a', email: 'me@a.com', color: '#2563eb', status: 'ok' }];
const group = (id: string, name: string, position: number): GroupDTO => ({ id, name, position, color: '#64748b', notify: false, kind: 'builtin', inboxCount: 3, unreadCount: 0 });
const GROUPS: GroupDTO[] = [group('important', 'Important', 0), group('dev', 'Dev', 1), group('low', 'Low', 2)];
const thread = (n: number, over: Partial<ThreadSummaryDTO> = {}): ThreadSummaryDTO => ({
  id: `a:${n}`, accountId: 'a', subject: `Subject ${n}`, snippet: `snippet ${n}`, fromName: `Sender ${n}`, fromEmail: `s${n}@example.com`, lastMessageAt: 100_000 - n, unread: true, inInbox: true,
  groupId: 'important', groupName: 'Important', reason: { source: 'mark', text: `Reason ${n}`, at: null }, snoozedUntil: null, hasAttachments: false, suggestRule: false, ...over,
});

let all: ThreadSummaryDTO[];

beforeEach(async () => {
  stubPhone();
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(360);
  stubRowWidth();
  Element.prototype.scrollTo ??= () => {};
  vi.resetModules();
  all = [thread(0), thread(1), thread(2)];
  for (const fn of Object.values(api)) fn.mockReset();
  api.accounts.mockResolvedValue(accounts);
  api.groups.mockResolvedValue(GROUPS);
  api.threads.mockImplementation(async (q: { includeDone?: boolean; groupId?: string | null } = {}): Promise<ThreadPage> => ({ threads: all.filter((t) => (t.inInbox || q.includeDone) && (!q.groupId || t.groupId === q.groupId)), nextCursor: null }));
  api.done.mockImplementation(async (id: string) => ({ undoId: 'u-done', thread: { ...all.find((t) => t.id === id)!, inInbox: false, doneAt: 5 } }));
  api.snooze.mockImplementation(async (id: string) => ({ undoId: 'u-snooze', thread: { ...all.find((t) => t.id === id)!, inInbox: false } }));
  api.restore.mockImplementation(async (id: string) => ({ undoId: 'u-restore', thread: { ...all.find((t) => t.id === id)!, inInbox: true, doneAt: null } }));
  api.bulk.mockImplementation(async (r: BulkRequest) => ({ undoId: 'u-bulk', affected: r.ids.length, failed: [] }));
});

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search}|{JSON.stringify(l.state)}</output>;
}

function GoBack() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(-1)}>test back</button>;
}

async function renderInbox(path = '/') {
  const { Inbox } = await import('../src/views/Inbox');
  const { AppToasts } = await import('../src/state/toasts');
  const { whenBackSettled } = await import('../src/components/phone/backStack');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/elsewhere', path]} initialIndex={1}>
        <Routes>
          <Route path="/" element={<Inbox />} />
          <Route path="*" element={<p>elsewhere</p>} />
        </Routes>
        <Where />
        <GoBack />
        <AppToasts />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findAllByTestId('thread-row');
  return { client, settled: () => new Promise<void>((r) => whenBackSettled(r)) };
}
const rowOf = (n: number) => document.querySelector(`[data-thread-id="a:${n}"]`)!;
const rowCount = () => screen.queryAllByTestId('thread-row').length;

async function longPress(n: number) {
  vi.useFakeTimers();
  pressDown(rowOf(n));
  await act(async () => void vi.advanceTimersByTime(450));
  vi.useRealTimers();
  liftAfterLongPress(rowOf(n));
}

describe('the phone inbox', () => {
  afterEach(() => vi.useRealTimers());

  it('lays out 72px rows', async () => {
    await renderInbox();
    const offsets = screen.getAllByTestId('thread-row').map((r) => (r.closest('[style*="translateY"]') as HTMLElement).style.transform);
    expect(offsets.slice(0, 2)).toEqual(['translateY(0px)', 'translateY(72px)']);
  });

  it('has no strip of reasons and no Show done in the tab row, which is in More', async () => {
    await renderInbox();
    expect(screen.queryByTestId('reason-strip')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('subheader')).queryByRole('button', { name: /Show done/ })).not.toBeInTheDocument();
  });

  it('marks a row Done on a right swipe, with Undo', async () => {
    await renderInbox();
    swipe(rowOf(1), 50, 250);
    await waitFor(() => expect(api.done).toHaveBeenCalledWith('a:1'));
    expect(await screen.findByRole('button', { name: /Undo/ })).toBeInTheDocument();
    await waitFor(() => expect(rowOf(1)).toBeNull());
  });

  it('moves a done row back to the inbox on a right swipe', async () => {
    all = [thread(0), thread(1, { inInbox: false, doneAt: 5 })];
    const { useShowDone } = await import('../src/state/ui');
    function Turn() {
      useShowDone()[1](true);
      return null;
    }
    render(<Turn />);
    await renderInbox();
    swipe(rowOf(1), 50, 250);
    await waitFor(() => expect(api.restore).toHaveBeenCalledWith('a:1'));
    expect(api.done).not.toHaveBeenCalled();
  });

  it('offers snooze on a left swipe, and only then snoozes', async () => {
    await renderInbox();
    swipe(rowOf(1), 320, 100);
    expect(api.snooze).not.toHaveBeenCalled();
    const sheet = await screen.findByRole('dialog', { name: 'Snooze until…' });
    fireEvent.click(within(sheet).getAllByRole('button')[0]!);
    await waitFor(() => expect(api.snooze).toHaveBeenCalledWith('a:1', expect.any(Number)));
  });

  it('opens the row sheet on a long-press, for that row', async () => {
    await renderInbox();
    await longPress(2);
    expect(screen.getByRole('dialog', { name: 'Actions for Subject 2' })).toBeInTheDocument();
  });

  it('runs an action from the sheet on the pressed row, not the first', async () => {
    await renderInbox();
    await longPress(2);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(api.done).toHaveBeenCalledWith('a:2'));
    expect(screen.queryByRole('dialog', { name: /Actions for/ })).not.toBeInTheDocument();
  });

  it('opens the composer from Reply in the sheet, with the list for the reader', async () => {
    const { settled } = await renderInbox();
    await longPress(1);
    await settled();
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/t/a%3A1'));
    expect(screen.getByTestId('where')).toHaveTextContent('"compose":"reply"');
  });

  it('hands over from the sheet to the snooze picker', async () => {
    await renderInbox();
    await longPress(1);
    fireEvent.click(screen.getByRole('button', { name: 'Snooze' }));
    expect(await screen.findByRole('dialog', { name: 'Snooze until…' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /Actions for/ })).not.toBeInTheDocument();
  });
});

describe('selection mode on the phone', () => {
  afterEach(() => vi.useRealTimers());

  async function select(n: number) {
    const r = await renderInbox();
    await longPress(n);
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    await screen.findByText('1 selected');
    return r;
  }

  it('starts from Select, with that row ticked and every row showing a checkbox', async () => {
    await select(1);
    expect(rowOf(1)).toHaveAttribute('aria-checked', 'true');
    expect(screen.getAllByTestId('row-checkbox')).toHaveLength(3);
  });

  it('ticks on tap instead of opening', async () => {
    await select(1);
    fireEvent.click(rowOf(2));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/|');
    fireEvent.click(rowOf(2));
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  it('does not swipe while selecting', async () => {
    await select(1);
    swipe(rowOf(2), 50, 250);
    await new Promise((r) => setTimeout(r, 250));
    expect(api.done).not.toHaveBeenCalled();
  });

  it('runs bulk actions from the bottom bar through the existing bulk call, then leaves the mode', async () => {
    await select(1);
    fireEvent.click(rowOf(2));
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Actions on the selection' })).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(api.bulk).toHaveBeenCalledWith(expect.objectContaining({ ids: ['a:1', 'a:2'], action: 'done' })));
    expect(screen.queryByRole('toolbar', { name: 'Actions on the selection' })).not.toBeInTheDocument();
  });

  it('gives bar actions icons, names, 44px targets and no key hints', async () => {
    await select(1);
    const bar = screen.getByRole('toolbar', { name: 'Actions on the selection' });
    for (const b of within(bar).getAllByRole('button')) {
      expect(b.querySelector('svg')).not.toBeNull();
      expect(b).toHaveAccessibleName();
      expect(b.className).toContain('min-h-11');
      expect(b.querySelector('kbd')).toBeNull();
    }
    expect(bar.closest('[data-testid="selection-bar"]')!.className).toContain('pb-[env(safe-area-inset-bottom)]');
  });

  it('keeps the actions that do not fit in a sheet, reachable by touch', async () => {
    await select(1);
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Actions on the selection' })).getByRole('button', { name: 'More actions' }));
    const sheet = await screen.findByRole('dialog', { name: 'More actions' });
    expect(within(sheet).getAllByRole('button').map((b) => b.textContent)).toEqual(['Important', 'Not important', 'Report spam']);
  });

  it('selects everything below the row', async () => {
    await select(1);
    fireEvent.click(screen.getByRole('button', { name: 'Select all below' }));
    expect(await screen.findByText('2 selected')).toBeInTheDocument();
    expect(rowOf(0)).toHaveAttribute('aria-checked', 'false');
  });

  it('leaves on Close', async () => {
    await select(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close selection' }));
    expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId('row-checkbox')).toHaveLength(0);
  });

  it('leaves on the Android back gesture, without leaving the screen', async () => {
    const { settled } = await select(1);
    await settled();
    act(() => void window.dispatchEvent(new PopStateEvent('popstate', { state: null })));
    await waitFor(() => expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument());
    expect(screen.getByTestId('where')).toHaveTextContent('/|');
  });
});

describe('the Compose button on the phone', () => {
  // By address: while hidden it has no accessible name to find it by.
  const fab = () => document.querySelector('a[href="/compose"]')!;
  const hidden = () => fab().getAttribute('aria-hidden') === 'true';
  const scrollTo = (top: number) => {
    const list = screen.getByRole('listbox', { name: 'Threads' });
    list.scrollTop = top;
    fireEvent.scroll(list);
  };

  it('is a 56px accent button above the safe area, going to the composer', async () => {
    await renderInbox();
    expect(screen.getByRole('link', { name: 'Compose' })).toBe(fab());
    expect(fab()).toHaveAttribute('href', '/compose');
    expect(fab().className).toContain('h-14');
    expect(fab().className).toContain('w-14');
    expect(fab().className).toContain('bg-accent');
    expect(fab().className).toContain('bottom-[calc(16px+env(safe-area-inset-bottom))]');
  });

  it('hides scrolling down and comes back scrolling up', async () => {
    await renderInbox();
    expect(hidden()).toBe(false);
    scrollTo(100);
    expect(hidden()).toBe(true);
    scrollTo(300);
    expect(hidden()).toBe(true);
    scrollTo(280);
    expect(hidden()).toBe(false);
  });

  it('ignores the small jitter of a resting finger', async () => {
    await renderInbox();
    scrollTo(100);
    scrollTo(98);
    expect(hidden()).toBe(true);
  });

  it('leaves the tab order while hidden', async () => {
    await renderInbox();
    scrollTo(100);
    expect(fab()).toHaveAttribute('tabindex', '-1');
  });

  it('is not there in selection mode', async () => {
    await renderInbox();
    await longPress(1);
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    await screen.findByText('1 selected');
    expect(fab()).toBeNull();
  });
});

describe('pull to refresh', () => {
  afterEach(() => vi.useRealTimers());
  const area = () => screen.getByTestId('pull-area');
  const pull = (to: number) => {
    touchAt(area(), 'touchstart', 100);
    touchAt(area(), 'touchmove', 130);
    touchAt(area(), 'touchmove', to);
  };

  it('refetches the list, says Updated, and clears itself', async () => {
    await renderInbox();
    api.threads.mockClear();
    api.groups.mockClear();
    pull(400);
    touchAt(area(), 'touchend', 400);
    await waitFor(() => expect(api.threads).toHaveBeenCalled());
    expect(api.groups).toHaveBeenCalled();
    expect(await screen.findByText('Updated')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Updated')).not.toBeInTheDocument(), { timeout: 3_000 });
  });

  it('never shows a spinner stuck on screen', async () => {
    await renderInbox();
    pull(400);
    touchAt(area(), 'touchend', 400);
    await screen.findByText('Updated');
    expect(document.querySelector('.animate-spin')).toBeNull();
  });

  it('does nothing on a short pull', async () => {
    await renderInbox();
    api.threads.mockClear();
    pull(140);
    touchAt(area(), 'touchend', 140);
    await new Promise((r) => setTimeout(r, 30));
    expect(api.threads).not.toHaveBeenCalled();
  });

  it('leaves the scroll alone below the top of the list', async () => {
    await renderInbox();
    api.threads.mockClear();
    screen.getByRole('listbox', { name: 'Threads' }).scrollTop = 200;
    touchAt(area(), 'touchstart', 100);
    const move = touchAt(area(), 'touchmove', 400);
    touchAt(area(), 'touchend', 400);
    await new Promise((r) => setTimeout(r, 30));
    expect(move.defaultPrevented).toBe(false);
    expect(api.threads).not.toHaveBeenCalled();
  });

  it('leaves an upward scroll to the browser', async () => {
    await renderInbox();
    touchAt(area(), 'touchstart', 300);
    expect(touchAt(area(), 'touchmove', 250).defaultPrevented).toBe(false);
  });

  it('takes over the touch on a downward pull at the top', async () => {
    await renderInbox();
    touchAt(area(), 'touchstart', 100);
    expect(touchAt(area(), 'touchmove', 130).defaultPrevented).toBe(true);
    touchAt(area(), 'touchend', 130);
  });

  it('says so when the refresh fails, and keeps the rows', async () => {
    await renderInbox();
    api.threads.mockRejectedValue(new Error('offline'));
    pull(400);
    touchAt(area(), 'touchend', 400);
    expect(await screen.findByText("Couldn't update. Pull to try again")).toBeInTheDocument();
    expect(rowCount()).toBe(3);
  });

  it('is off in selection mode', async () => {
    await renderInbox();
    await longPress(1);
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    await screen.findByText('1 selected');
    api.threads.mockClear();
    pull(400);
    touchAt(area(), 'touchend', 400);
    await new Promise((r) => setTimeout(r, 30));
    expect(api.threads).not.toHaveBeenCalled();
  });
});

describe('coming back to the list from a thread', () => {
  it('lands where it left, under StrictMode too, which makes the virtualizer scroll again', async () => {
    const { Inbox } = await import('../src/views/Inbox');
    const { writeListMemory, listKey } = await import('../src/state/listMemory');
    const rows = Array.from({ length: 40 }, (_, i) => thread(i));
    all = rows;
    writeListMemory(listKey(null, null), { selId: rows[20]!.id, index: 20, scrollTop: 1_300 });
    // jsdom's scrollTo does nothing; the virtualizer's writes have to land for this to mean anything.
    vi.spyOn(Element.prototype, 'scrollTo').mockImplementation(function (this: Element, opts?: ScrollToOptions | number) {
      if (typeof opts === 'object' && opts.top !== undefined) this.scrollTop = opts.top;
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['threads', { accountId: null, groupId: null, includeDone: false }], { pages: [{ threads: rows, nextCursor: null }], pageParams: [null] });
    render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/']}>
            <Routes>
              <Route path="/" element={<Inbox />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </StrictMode>,
    );
    const list = await screen.findByRole('listbox', { name: 'Threads' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(list.scrollTop).toBe(1_300);
  });
});

describe('changing group on the phone', () => {
  const groupCalls = () => api.threads.mock.calls.map(([q]) => (q as { groupId?: string | null }).groupId ?? null);
  const tapGroup = (name: RegExp) => fireEvent.click(screen.getByRole('tab', { name }));

  it('prefetches the first page of both neighbours while on a group', async () => {
    all = [thread(0, { groupId: 'dev', groupName: 'Dev' })];
    await renderInbox('/?group=dev');
    await waitFor(() => expect(groupCalls()).toEqual(expect.arrayContaining(['dev', 'important', 'low'])));
  });

  it('prefetches All and the first group from All, and nothing past them', async () => {
    await renderInbox();
    await waitFor(() => expect(groupCalls()).toEqual(expect.arrayContaining([null, 'important'])));
    expect(groupCalls()).not.toContain('dev');
  });

  it('shows a neighbour at once from the prefetch, with no skeleton and no second fetch', async () => {
    all = [thread(0), thread(1, { groupId: 'dev', groupName: 'Dev' })];
    await renderInbox('/?group=important');
    await waitFor(() => expect(groupCalls()).toContain('dev'));
    await act(async () => {});
    api.threads.mockImplementation(() => new Promise(() => {}));
    tapGroup(/^Dev/);
    expect(screen.queryByTestId('list-skeleton')).not.toBeInTheDocument();
    expect(rowOf(1)).not.toBeNull();
  });

  it('shows the skeleton only when there is really nothing cached', async () => {
    await renderInbox();
    await act(async () => {});
    api.threads.mockImplementation(() => new Promise(() => {}));
    tapGroup(/^Low/);
    expect(await screen.findByTestId('list-skeleton')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('puts the group in the URL by replacing, so Back never walks through the groups', async () => {
    await renderInbox();
    tapGroup(/^Important/);
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/?group=important'));
    tapGroup(/^Dev/);
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/?group=dev'));
    tapGroup(/^Low/);
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/?group=low'));
    fireEvent.click(screen.getByRole('button', { name: 'test back' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/elsewhere'));
  });

  it('comes back to each group at its own scroll position', async () => {
    const { readListMemory, writeListMemory, listKey } = await import('../src/state/listMemory');
    await renderInbox();
    writeListMemory(listKey(null, 'important'), { scrollTop: 480 });
    tapGroup(/^Important/);
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/?group=important'));
    expect(readListMemory(listKey(null, 'important'))?.scrollTop).toBe(480);
    const list = await screen.findByRole('listbox', { name: 'Threads' });
    await waitFor(() => expect(list.scrollTop).toBe(480));
  });

  it('crossfades the list by opacity in about 120ms', async () => {
    const animate = vi.fn();
    Element.prototype.animate = animate as never;
    await renderInbox();
    animate.mockClear();
    tapGroup(/^Important/);
    await waitFor(() => expect(animate).toHaveBeenCalled());
    const [frames, options] = animate.mock.calls[0]! as [{ opacity: number }[], { duration: number }];
    expect(frames.map((f) => Object.keys(f))).toEqual([['opacity'], ['opacity']]);
    expect(options.duration).toBe(120);
    delete (Element.prototype as { animate?: unknown }).animate;
  });

  it('keeps the slider out of the pull area, so a swipe there never pulls to refresh', async () => {
    await renderInbox();
    expect(screen.getByTestId('pull-area').contains(screen.getByTestId('group-slider'))).toBe(false);
  });

  it('still swipes rows on a group', async () => {
    await renderInbox('/?group=important');
    swipe(rowOf(1), 50, 250);
    await waitFor(() => expect(api.done).toHaveBeenCalledWith('a:1'));
  });

  it('leaves selection mode first when the group changes, so history stays straight', async () => {
    const { settled } = await renderInbox();
    await longPress(1);
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    await screen.findByText('1 selected');
    await settled();
    tapGroup(/^Dev/);
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/?group=dev'));
    expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
  });
});
