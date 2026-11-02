import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountDTO, BulkRequest, GroupDTO, TeachBulkRequest, ThreadPage, ThreadSummaryDTO } from '@supermail/shared';

const api = vi.hoisted(() => ({
  me: vi.fn(),
  accounts: vi.fn(),
  groups: vi.fn(),
  threads: vi.fn(),
  done: vi.fn(),
  snooze: vi.fn(),
  move: vi.fn(),
  read: vi.fn(),
  teach: vi.fn(),
  teachPreview: vi.fn(),
  undo: vi.fn(),
  reportSpam: vi.fn(),
  bulk: vi.fn(),
  teachBulk: vi.fn(),
}));
vi.mock('../src/api/client', async (importOriginal) => ({ ...(await importOriginal<object>()), api }));

const PAGE = 50;
const accounts: AccountDTO[] = [
  { id: 'a', email: 'me@a.com', color: '#2563eb', status: 'ok' },
  { id: 'b', email: 'me@b.com', color: '#16a34a', status: 'ok' },
];

function group(id: string, name: string, position: number, inboxCount: number): GroupDTO {
  return { id, name, position, color: '#64748b', notify: false, kind: 'builtin', inboxCount, unreadCount: 0 };
}
const GROUPS = [group('important', 'Important', 0, 7), group('dev', 'Dev', 1, 8), group('low_priority', 'Low priority', 2, 9)];

function thread(n: number, over: Partial<ThreadSummaryDTO> = {}): ThreadSummaryDTO {
  return {
    id: `a:${n}`, accountId: 'a', subject: `Subject ${n}`, snippet: `snippet ${n}`, fromName: `Sender ${n}`, fromEmail: `s${n}@example.com`, lastMessageAt: 100_000 - n, unread: false, inInbox: true,
    groupId: 'important', groupName: 'Important', reason: { source: 'mark', text: `Reason ${n}`, at: null }, snoozedUntil: null, hasAttachments: false, suggestRule: false, ...over,
  };
}
const threads = (count: number, over: Partial<ThreadSummaryDTO> = {}) => Array.from({ length: count }, (_, i) => thread(i, over));

let all: ThreadSummaryDTO[];

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
  Element.prototype.scrollTo ??= () => {};
  vi.resetModules();
  all = threads(6);
  for (const fn of Object.values(api)) fn.mockReset();
  api.accounts.mockResolvedValue(accounts);
  api.groups.mockResolvedValue(GROUPS);
  api.threads.mockImplementation(async (q: { accountId?: string | null; groupId?: string | null; includeDone?: boolean; cursor?: string | null } = {}): Promise<ThreadPage> => {
    const rows = all.filter((t) => (t.inInbox || q.includeDone) && (!q.accountId || t.accountId === q.accountId) && (!q.groupId || t.groupId === q.groupId));
    const at = q.cursor ? Number(q.cursor) : 0;
    return { threads: rows.slice(at, at + PAGE), nextCursor: at + PAGE < rows.length ? String(at + PAGE) : null };
  });
  api.bulk.mockImplementation(async (r: BulkRequest) => ({ undoId: 'u-bulk', affected: r.ids.length, failed: [] }));
  api.teachBulk.mockImplementation(async (r: TeachBulkRequest) => ({ undoId: 'u-teach', affected: r.ids.length, failed: [] }));
  api.undo.mockResolvedValue({ undoId: 'u-redo', thread: null, affected: 2 });
  api.done.mockResolvedValue({ undoId: 'u-one', thread: null });
  api.teachPreview.mockImplementation(async (id: string) => {
    const t = all.find((x) => x.id === id)!;
    return { subject: t.subject, senderName: t.fromName, sender: { value: t.fromEmail!, count: 3 }, domain: null, list: null };
  });
});

function ThreadStub() {
  const navigate = useNavigate();
  return (
    <div>
      thread page {useParams().id}
      <button type="button" onClick={() => navigate(-1)}>
        stub back
      </button>
    </div>
  );
}

async function renderInbox(path = '/') {
  const { Inbox } = await import('../src/views/Inbox');
  const { AppToasts, resetToasts } = await import('../src/state/toasts');
  resetToasts();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={<Inbox />} />
          <Route path="/t/:id" element={<ThreadStub />} />
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
const ctrlA = () => press('a', { ctrlKey: true });

const row = (n: number) => document.querySelector<HTMLElement>(`[data-thread-id="a:${n}"]`)!;
const checkbox = (n: number) => within(row(n).parentElement!).getByLabelText(`Select Subject ${n}`);
const isChecked = (n: number) => row(n).getAttribute('aria-checked') === 'true';
const checkedRows = () => [...document.querySelectorAll('[data-testid="thread-row"][aria-checked="true"]')].map((el) => el.getAttribute('data-thread-id'));
const bar = () => screen.findByTestId('bulk-bar');
const liveRegion = () => screen.getByTestId('selection-status');

describe('x', () => {
  it('toggles the row under the keyboard selection and moves down one row', async () => {
    await renderInbox();
    press('x');
    expect(isChecked(0)).toBe(true);
    expect(row(1)).toHaveAttribute('aria-selected', 'true');
    press('x');
    expect(checkedRows()).toEqual(['a:0', 'a:1']);
    expect(row(2)).toHaveAttribute('aria-selected', 'true');
  });

  it('takes a row back off', async () => {
    await renderInbox();
    press('x');
    press('k');
    press('x');
    expect(checkedRows()).toEqual([]);
  });

  it('works on the row under the mouse', async () => {
    await renderInbox();
    fireEvent.mouseMove(row(3));
    press('x');
    expect(checkedRows()).toEqual(['a:3']);
  });

  it('stays on the last row at the bottom of the list', async () => {
    await renderInbox();
    press('End');
    for (let i = 0; i < 6; i++) press('j');
    press('x');
    press('x');
    expect(checkedRows()).toEqual([]); // the same row, twice
  });

  it('is not taken over while typing in the search field', async () => {
    await renderInbox();
    fireEvent.keyDown(screen.getByLabelText('Search mail'), { key: 'x' });
    expect(checkedRows()).toEqual([]);
  });
});

describe('the row checkbox', () => {
  it('shows on hover until something is selected, then on every row', async () => {
    await renderInbox();
    expect(checkbox(1).className).toContain('group-hover:flex');
    expect(checkbox(1).className).toContain('hidden');
    press('x');
    await bar();
    expect(checkbox(1).className).not.toContain('hidden');
  });

  it('toggles the row without opening it', async () => {
    await renderInbox();
    fireEvent.click(checkbox(2));
    expect(checkedRows()).toEqual(['a:2']);
    expect(screen.queryByText(/thread page/)).not.toBeInTheDocument();
    fireEvent.click(checkbox(2));
    expect(checkedRows()).toEqual([]);
  });

  it('checking a row keeps it one line tall, so nothing shifts', async () => {
    await renderInbox();
    press('x');
    expect(row(0).className).toContain('h-9');
  });
});

describe('Ctrl+A', () => {
  it('selects from the current row to the bottom, rows not loaded yet included', async () => {
    all = threads(120);
    await renderInbox();
    press('j');
    press('j');
    ctrlA();
    await waitFor(() => expect(screen.getByTestId('bulk-bar')).toHaveTextContent('118 selected'));
    expect(api.threads).toHaveBeenCalledWith(expect.objectContaining({ cursor: '100' }));
    press('e');
    await waitFor(() => expect(api.bulk).toHaveBeenCalled());
    const { ids } = api.bulk.mock.calls[0]![0] as BulkRequest;
    expect(ids).toHaveLength(118);
    expect(ids[0]).toBe('a:2');
    expect(ids.at(-1)).toBe('a:119');
    expect(ids).not.toContain('a:0');
  });

  it("takes the browser's select-all away, outside text fields", async () => {
    await renderInbox();
    const e = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true });
    act(() => void document.body.dispatchEvent(e));
    expect(e.defaultPrevented).toBe(true);
  });

  it('works with Cmd on a Mac', async () => {
    await renderInbox();
    press('a', { metaKey: true });
    await waitFor(() => expect(screen.getByTestId('bulk-bar')).toHaveTextContent('6 selected'));
  });

  it('leaves select-all to the search field', async () => {
    await renderInbox();
    const field = screen.getByLabelText('Search mail');
    field.focus();
    const e = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true });
    act(() => void field.dispatchEvent(e));
    expect(e.defaultPrevented).toBe(false);
    expect(screen.queryByTestId('bulk-bar')).not.toBeInTheDocument();
  });

  it('stops at 1000 threads and says so', async () => {
    all = threads(1203);
    await renderInbox();
    ctrlA();
    await waitFor(() => expect(screen.getByTestId('bulk-bar')).toHaveTextContent('1000 selected'), { timeout: 4000 });
    expect(await screen.findByText(/first 1000/)).toBeInTheDocument();
    expect(api.threads.mock.calls.length).toBeLessThanOrEqual(20);
  });

  it('says nothing about a cap when the list ends first', async () => {
    all = threads(60);
    await renderInbox();
    ctrlA();
    await waitFor(() => expect(screen.getByTestId('bulk-bar')).toHaveTextContent('60 selected'));
    expect(screen.queryByText(/first 1000/)).not.toBeInTheDocument();
  });

  it('Escape while the pages load drops the selection for good', async () => {
    all = threads(120);
    await renderInbox();
    let release = () => {};
    const real = api.threads.getMockImplementation()!;
    api.threads.mockImplementation((q) => new Promise((resolve) => (release = () => resolve(real(q)))));
    ctrlA();
    await waitFor(() => expect(screen.getByTestId('bulk-bar')).toHaveTextContent('Selecting'));
    press('Escape');
    api.threads.mockImplementation(real);
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(screen.queryByTestId('bulk-bar')).not.toBeInTheDocument();
    expect(checkedRows()).toEqual([]);
  });

  it('says so if the next page cannot be loaded, and keeps what it has', async () => {
    all = threads(120);
    await renderInbox();
    api.threads.mockRejectedValue(new Error('offline'));
    ctrlA();
    await waitFor(() => expect(screen.getByTestId('bulk-bar')).toHaveTextContent('50 selected'));
    expect(await screen.findByText(/Couldn't load the rest/)).toBeInTheDocument();
  });
});

describe('ranges', () => {
  it('Shift+j and Shift+k grow and shrink a range from the anchor', async () => {
    await renderInbox();
    press('x'); // anchor on 0, cursor on 1
    press('J', { shiftKey: true });
    expect(checkedRows()).toEqual(['a:0', 'a:1', 'a:2']);
    expect(row(2)).toHaveAttribute('aria-selected', 'true');
    press('K', { shiftKey: true });
    expect(checkedRows()).toEqual(['a:0', 'a:1']);
  });

  it('Shift+j with nothing selected starts at the current row', async () => {
    await renderInbox();
    press('J', { shiftKey: true });
    expect(checkedRows()).toEqual(['a:0', 'a:1']);
  });

  it('Shift+k goes up past the anchor', async () => {
    await renderInbox();
    press('j');
    press('j');
    press('K', { shiftKey: true });
    press('K', { shiftKey: true });
    expect(checkedRows()).toEqual(['a:0', 'a:1', 'a:2']);
  });

  it('Shift+click selects from the last anchor to that row', async () => {
    await renderInbox();
    press('j');
    press('x'); // anchor on 1
    fireEvent.click(row(4), { shiftKey: true });
    expect(checkedRows()).toEqual(['a:1', 'a:2', 'a:3', 'a:4']);
    expect(screen.queryByText(/thread page/)).not.toBeInTheDocument();
  });

  it('a range keeps what was selected before it', async () => {
    await renderInbox();
    press('x'); // 0
    press('j');
    press('j');
    press('x'); // 3, the new anchor; the cursor is on 4
    fireEvent.click(row(5), { shiftKey: true });
    expect(checkedRows()).toEqual(['a:0', 'a:3', 'a:4', 'a:5']);
  });

  it('Ctrl+click toggles one row without opening it', async () => {
    await renderInbox();
    fireEvent.click(row(2), { ctrlKey: true });
    fireEvent.click(row(4), { metaKey: true });
    expect(checkedRows()).toEqual(['a:2', 'a:4']);
    expect(screen.queryByText(/thread page/)).not.toBeInTheDocument();
  });

  it('a plain click still opens the email while rows are selected', async () => {
    await renderInbox();
    press('x');
    fireEvent.click(row(3));
    expect(await screen.findByText('thread page a:3')).toBeInTheDocument();
  });
});

describe('clearing', () => {
  it('Escape clears the selection', async () => {
    await renderInbox();
    press('x');
    await bar();
    press('Escape');
    expect(checkedRows()).toEqual([]);
    expect(screen.queryByTestId('bulk-bar')).not.toBeInTheDocument();
  });

  it('Escape does nothing to an inbox with no selection', async () => {
    await renderInbox();
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => void document.body.dispatchEvent(e));
    expect(e.defaultPrevented).toBe(false);
  });

  it('switching group clears it', async () => {
    all = threads(6).map((t, i) => (i < 3 ? t : { ...t, groupId: 'dev', groupName: 'Dev' }));
    await renderInbox();
    press('x');
    press('2');
    await screen.findByText('Subject 3');
    await waitFor(() => expect(screen.queryByTestId('bulk-bar')).not.toBeInTheDocument());
    press('1');
    await screen.findByText('Subject 0');
    expect(checkedRows()).toEqual([]);
  });

  it('switching account clears it', async () => {
    await renderInbox();
    press('x');
    await bar();
    press('`');
    await waitFor(() => expect(screen.queryByTestId('bulk-bar')).not.toBeInTheDocument());
  });

  it('Show done clears it', async () => {
    await renderInbox();
    press('x');
    await bar();
    press('d');
    await waitFor(() => expect(screen.queryByTestId('bulk-bar')).not.toBeInTheDocument());
  });

  it('the bar has a Clear button', async () => {
    await renderInbox();
    press('x');
    fireEvent.click(within(await bar()).getByRole('button', { name: 'Clear' }));
    expect(checkedRows()).toEqual([]);
  });

  it('coming back from an email keeps the selection', async () => {
    await renderInbox();
    press('x');
    press('x');
    fireEvent.click(row(3));
    fireEvent.click(await screen.findByRole('button', { name: 'stub back' }));
    await screen.findByText('Subject 0');
    expect(checkedRows()).toEqual(['a:0', 'a:1']);
  });
});

describe('the bar', () => {
  it('replaces the status strip and counts the selection', async () => {
    await renderInbox();
    expect(screen.getByTestId('reason-strip')).toBeInTheDocument();
    press('x');
    press('x');
    expect(await bar()).toHaveTextContent('2 selected');
    expect(screen.queryByTestId('reason-strip')).not.toBeInTheDocument();
  });

  it('has every action, each with its key hint', async () => {
    all = [thread(0, { unread: true }), thread(1)];
    await renderInbox();
    press('x');
    const b = within(await bar());
    for (const [name, key] of [['Done', 'e'], ['Snooze', 'h'], ['Read', 'u'], ['Important', '+'], ['Not important', '-'], ['Move to group', 'l'], ['Report spam', '!']] as const) {
      const button = b.getByRole('button', { name });
      expect(button.querySelector(`[data-key="${key}"]`), name).not.toBeNull();
      expect(button.querySelector('svg'), name).not.toBeNull();
    }
  });

  it('offers Unread when everything selected is already read, Read when anything is unread', async () => {
    all = [thread(0), thread(1, { unread: true }), thread(2)];
    await renderInbox();
    press('x');
    expect(within(await bar()).getByRole('button', { name: 'Unread' })).toBeInTheDocument();
    press('x');
    expect(within(await bar()).getByRole('button', { name: 'Read' })).toBeInTheDocument();
  });

  it('announces the count', async () => {
    await renderInbox();
    expect(liveRegion()).toHaveAttribute('aria-live', 'polite');
    expect(liveRegion()).toHaveTextContent('');
    press('x');
    expect(liveRegion()).toHaveTextContent('1 selected');
    press('x');
    expect(liveRegion()).toHaveTextContent('2 selected');
  });

  it('leaves the group tab counts alone until an action lands', async () => {
    await renderInbox();
    const counts = () => screen.getByRole('tablist').textContent;
    await waitFor(() => expect(counts()).toContain('8'));
    const before = counts();
    const calls = api.groups.mock.calls.length;
    press('x');
    press('x');
    await bar();
    expect(counts()).toBe(before);
    expect(api.groups.mock.calls.length).toBe(calls);
  });

  it('Done on the bar takes the rows off the screen before the server answers', async () => {
    await renderInbox();
    let answer = (_: unknown) => {};
    api.bulk.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    press('x');
    press('x');
    fireEvent.click(within(await bar()).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByText('Subject 0')).not.toBeInTheDocument());
    expect(screen.queryByText('Subject 1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('bulk-bar')).not.toBeInTheDocument();
    await act(async () => answer({ undoId: 'u', affected: 2, failed: [] }));
    expect(await screen.findByText('2 done')).toBeInTheDocument();
  });

  it('the bar and the group chips stay on one line of fixed height', async () => {
    await renderInbox();
    press('x');
    expect((await bar()).className).toContain('h-8');
    expect(screen.getByTestId('bulk-bar').className).toContain('shrink-0');
  });
});

describe('the keys act on everything selected', () => {
  const select2 = async () => {
    press('x');
    press('x');
    await bar();
  };

  it('e marks them done, with one call and one toast', async () => {
    await renderInbox();
    await select2();
    press('e');
    await screen.findByText('2 done');
    expect(api.bulk).toHaveBeenCalledTimes(1);
    expect(api.bulk).toHaveBeenCalledWith({ ids: ['a:0', 'a:1'], action: 'done' });
    expect(api.done).not.toHaveBeenCalled();
  });

  it('a single e with nothing selected still acts on the row alone', async () => {
    await renderInbox();
    press('e');
    await waitFor(() => expect(api.done).toHaveBeenCalledWith('a:0'));
    expect(api.bulk).not.toHaveBeenCalled();
  });

  it('h opens the snooze picker and snoozes them all', async () => {
    await renderInbox();
    await select2();
    press('h');
    const dialog = await screen.findByRole('dialog', { name: 'Snooze until…' });
    fireEvent.click(within(dialog).getAllByRole('button')[0]!);
    await waitFor(() => expect(api.bulk).toHaveBeenCalledWith({ ids: ['a:0', 'a:1'], action: 'snooze', until: expect.any(Number) }));
    expect(await screen.findByText(/^2 snoozed until/)).toBeInTheDocument();
  });

  it('u marks them read when any is unread', async () => {
    all = [thread(0, { unread: true }), thread(1), thread(2)];
    await renderInbox();
    await select2();
    press('u');
    await waitFor(() => expect(api.bulk).toHaveBeenCalledWith({ ids: ['a:0', 'a:1'], action: 'read' }));
    expect(await screen.findByText('2 marked read')).toBeInTheDocument();
  });

  it('u marks them unread when all are read', async () => {
    await renderInbox();
    await select2();
    press('u');
    await waitFor(() => expect(api.bulk).toHaveBeenCalledWith({ ids: ['a:0', 'a:1'], action: 'unread' }));
    expect(row(0)).toHaveAttribute('data-unread', 'true');
  });

  it('! reports them as spam', async () => {
    await renderInbox();
    await select2();
    press('!', { shiftKey: true });
    await waitFor(() => expect(api.bulk).toHaveBeenCalledWith({ ids: ['a:0', 'a:1'], action: 'spam' }));
    expect(await screen.findByText('2 reported as spam')).toBeInTheDocument();
    expect(screen.queryByText('Subject 0')).not.toBeInTheDocument();
  });

  it('+ asks first, and leaves the rows alone until answered', async () => {
    await renderInbox();
    await select2();
    press('+', { shiftKey: true });
    await screen.findByRole('dialog', { name: 'Mark as important' });
    expect(api.bulk).not.toHaveBeenCalled();
    expect(api.teachBulk).not.toHaveBeenCalled();
  });

  it('with Show done on, Done leaves the done rows out of the action', async () => {
    all = [thread(0, { inInbox: false, doneAt: 5 }), thread(1), thread(2)];
    localStorage.setItem('sm.showDone', '1');
    await renderInbox();
    press('x');
    press('x');
    press('e');
    await waitFor(() => expect(api.bulk).toHaveBeenCalledWith({ ids: ['a:1'], action: 'done' }));
  });
});

describe('the scope prompt', () => {
  const selectAll = async () => {
    ctrlA();
    await bar();
  };
  const scopes = () => screen.getAllByRole('radio').map((r) => r.textContent);

  it('offers only these emails, as the default, or all from the senders', async () => {
    await renderInbox();
    await selectAll();
    press('+', { shiftKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Mark as important' });
    expect(scopes()).toEqual([expect.stringContaining('Only these 6 emails'), expect.stringContaining('All from the 6 senders')]);
    expect(within(dialog).getByRole('radio', { name: /Only these/ })).toHaveAttribute('aria-checked', 'true');
    expect(within(dialog).getByText('6 emails from 6 senders')).toBeInTheDocument();
  });

  it('Only these moves them one by one, as one-off moves', async () => {
    await renderInbox();
    await selectAll();
    press('-');
    await screen.findByRole('dialog', { name: 'Mark as not important' });
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    await waitFor(() => expect(api.bulk).toHaveBeenCalledWith({ ids: all.map((t) => t.id), action: 'move', groupId: 'low_priority' }));
    expect(api.teachBulk).not.toHaveBeenCalled();
    expect(await screen.findByText('6 emails → Low priority')).toBeInTheDocument();
  });

  it('All from the senders teaches each one, with one undo', async () => {
    await renderInbox();
    await selectAll();
    press('+', { shiftKey: true });
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('radio', { name: /All from the 6 senders/ }));
    await waitFor(() => expect(api.teachBulk).toHaveBeenCalledWith({ ids: all.map((t) => t.id), action: 'important' }));
    expect(api.bulk).not.toHaveBeenCalled();
    expect(await screen.findByText('6 senders → Important')).toBeInTheDocument();
    press('z');
    await waitFor(() => expect(api.undo).toHaveBeenCalledWith('u-teach'));
  });

  it('counts unique senders', async () => {
    all = [thread(0, { fromEmail: 'same@x.com' }), thread(1, { fromEmail: 'SAME@x.com' }), thread(2, { fromEmail: 'other@x.com' })];
    await renderInbox();
    await selectAll();
    press('-');
    await screen.findByRole('dialog');
    expect(scopes()[1]).toContain('All from the 2 senders');
  });

  it('says one sender plainly', async () => {
    all = [thread(0, { fromEmail: 'same@x.com' }), thread(1, { fromEmail: 'same@x.com' })];
    await renderInbox();
    await selectAll();
    press('-');
    await screen.findByRole('dialog');
    expect(scopes()[1]).toContain('All from this sender');
  });

  it('leaves the sender option out over 50 senders, and says why', async () => {
    all = threads(51);
    await renderInbox();
    await selectAll();
    press('+', { shiftKey: true });
    const dialog = await screen.findByRole('dialog');
    expect(scopes()).toEqual([expect.stringContaining('Only these 51 emails')]);
    expect(within(dialog).getByText(/51 senders is too many/)).toBeInTheDocument();
  });

  it('keeps it at exactly 50 senders', async () => {
    all = threads(50);
    await renderInbox();
    await selectAll();
    press('+', { shiftKey: true });
    await screen.findByRole('dialog');
    expect(scopes()).toHaveLength(2);
  });

  it('l opens the group picker with the same two scopes, default Only these', async () => {
    await renderInbox();
    await selectAll();
    press('l');
    const dialog = await screen.findByRole('dialog', { name: 'Move to group' });
    expect(scopes()).toEqual([expect.stringContaining('Only these 6 emails'), expect.stringContaining('All from the 6 senders')]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dev' }));
    await waitFor(() => expect(api.bulk).toHaveBeenCalledWith({ ids: all.map((t) => t.id), action: 'move', groupId: 'dev' }));
  });

  it('l can teach the senders a group', async () => {
    await renderInbox();
    await selectAll();
    press('l');
    const dialog = await screen.findByRole('dialog', { name: 'Move to group' });
    fireEvent.click(within(dialog).getByRole('radio', { name: /All from the 6 senders/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dev' }));
    await waitFor(() => expect(api.teachBulk).toHaveBeenCalledWith({ ids: all.map((t) => t.id), action: 'always_group', groupId: 'dev' }));
  });

  it('never fetches a teach preview for a selection', async () => {
    await renderInbox();
    await selectAll();
    press('+', { shiftKey: true });
    await screen.findByRole('dialog');
    expect(api.teachPreview).not.toHaveBeenCalled();
  });
});

describe('the right-click menu', () => {
  const menuOn = async (n: number) => {
    fireEvent.contextMenu(row(n));
    return within(await screen.findByRole('menu'));
  };

  it('on a selected row offers the bulk versions', async () => {
    await renderInbox();
    press('x');
    press('x');
    const menu = await menuOn(1);
    expect(screen.getByRole('menu', { name: 'Actions for 2 selected' })).toBeInTheDocument();
    expect(menu.queryByRole('menuitem', { name: /^Reply/ })).not.toBeInTheDocument();
    fireEvent.click(menu.getByRole('menuitem', { name: /Done 2 emails/ }));
    await waitFor(() => expect(api.bulk).toHaveBeenCalledWith({ ids: ['a:0', 'a:1'], action: 'done' }));
  });

  it('has every bulk action, and a way to clear', async () => {
    await renderInbox();
    press('x');
    press('x');
    const menu = await menuOn(0);
    for (const name of [/Done 2/, /Snooze 2/, /2 emails as unread/, /Report 2/, /Important to me/, /Not important/, /Move 2/, /Clear selection/]) expect(menu.getByRole('menuitem', { name })).toBeInTheDocument();
    fireEvent.click(menu.getByRole('menuitem', { name: /Clear selection/ }));
    expect(checkedRows()).toEqual([]);
  });

  it('on an unselected row acts on that row alone', async () => {
    await renderInbox();
    press('x');
    press('x');
    const menu = await menuOn(4);
    fireEvent.click(menu.getByRole('menuitem', { name: /^Done/ }));
    await waitFor(() => expect(api.done).toHaveBeenCalledWith('a:4'));
    expect(api.bulk).not.toHaveBeenCalled();
    expect(checkedRows()).toEqual(['a:0', 'a:1']);
  });
});

describe('after the action', () => {
  it('z undoes all of it in one go', async () => {
    await renderInbox();
    press('x');
    press('x');
    press('e');
    await screen.findByText('2 done');
    press('z');
    await waitFor(() => expect(api.undo).toHaveBeenCalledTimes(1));
    expect(api.undo).toHaveBeenCalledWith('u-bulk');
    expect(await screen.findByText('2 undone')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Subject 0')).toBeInTheDocument());
  });

  it('a partial failure is reported, with the rows back on screen and Undo still there', async () => {
    all = threads(300);
    const qc = await renderInbox();
    const { applyServerEvent } = await import('../src/api/events');
    ctrlA();
    await waitFor(() => expect(screen.getByTestId('bulk-bar')).toHaveTextContent('300 selected'));
    press('e');
    await screen.findByText('300 done');
    const back = all.slice(0, 3);
    act(() => {
      for (const t of back) applyServerEvent(qc, { type: 'thread.updated', thread: t });
      applyServerEvent(qc, { type: 'bulk.settled', undoId: 'u-bulk', affected: 297, failed: back.map((t) => t.id), skipped: [] });
    });
    expect(await screen.findByText('297 done · 3 failed')).toBeInTheDocument();
    expect(await screen.findByText('Subject 0')).toBeInTheDocument();
    press('z');
    await waitFor(() => expect(api.undo).toHaveBeenCalledWith('u-bulk'));
  });

  it('copes with the settled event beating the answer', async () => {
    const qc = await renderInbox();
    const { applyServerEvent } = await import('../src/api/events');
    api.bulk.mockImplementation(async (r: BulkRequest) => {
      applyServerEvent(qc, { type: 'bulk.settled', undoId: 'u-bulk', affected: 1, failed: ['a:1'], skipped: [] });
      return { undoId: 'u-bulk', affected: r.ids.length, failed: [] };
    });
    press('x');
    press('x');
    press('e');
    expect(await screen.findByText('1 done · 1 failed')).toBeInTheDocument();
  });

  it('after an undo, says nothing more about the action it took back', async () => {
    const qc = await renderInbox();
    const { applyServerEvent } = await import('../src/api/events');
    press('x');
    press('e');
    await screen.findByText('1 done');
    press('z');
    await screen.findByText('2 undone');
    act(() => applyServerEvent(qc, { type: 'bulk.settled', undoId: 'u-bulk', affected: 0, failed: ['a:0'], skipped: [] }));
    expect(screen.queryByText(/failed/)).not.toBeInTheDocument();
  });

  it('a failed undo is reported too', async () => {
    const qc = await renderInbox();
    const { applyServerEvent } = await import('../src/api/events');
    press('x');
    press('e');
    await screen.findByText('1 done');
    press('z');
    await screen.findByText('2 undone');
    act(() => applyServerEvent(qc, { type: 'bulk.settled', undoId: 'u-redo', affected: 1, failed: ['a:0'], skipped: [] }));
    expect(await screen.findByText('1 undone · 1 failed')).toBeInTheDocument();
  });

  it('says nothing more when every write landed', async () => {
    const qc = await renderInbox();
    const { applyServerEvent } = await import('../src/api/events');
    press('x');
    press('x');
    press('e');
    await screen.findByText('2 done');
    act(() => applyServerEvent(qc, { type: 'bulk.settled', undoId: 'u-bulk', affected: 2, failed: [], skipped: [] }));
    expect(screen.getByText('2 done')).toBeInTheDocument();
  });

  it('names threads the server no longer had', async () => {
    api.bulk.mockResolvedValue({ undoId: 'u-bulk', affected: 1, failed: ['a:1'] });
    await renderInbox();
    press('x');
    press('x');
    press('e');
    expect(await screen.findByText('1 done · 1 failed')).toBeInTheDocument();
  });

  it('puts every row back and says so when the request itself fails', async () => {
    api.bulk.mockRejectedValue(new Error('offline'));
    await renderInbox();
    press('x');
    press('x');
    press('e');
    expect(await screen.findByText(/Couldn't mark done: offline/)).toBeInTheDocument();
    expect(await screen.findByText('Subject 0')).toBeInTheDocument();
    expect(screen.getByText('Subject 1')).toBeInTheDocument();
  });

  it('clears the selection, even when the rows stay in the list', async () => {
    await renderInbox();
    press('x');
    press('u');
    await screen.findByText('1 marked unread');
    expect(screen.queryByTestId('bulk-bar')).not.toBeInTheDocument();
    expect(checkedRows()).toEqual([]);
  });
});
