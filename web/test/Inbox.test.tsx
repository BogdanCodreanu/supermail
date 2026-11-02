import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountDTO, ActionResult, GroupDTO, TeachRequest, ThreadPage, ThreadSummaryDTO } from '@supermail/shared';

// The server routes are built in parallel, so the API is mocked against the shared contract.
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
  createGroup: vi.fn(),
  undo: vi.fn(),
  restore: vi.fn(),
  reportSpam: vi.fn(),
}));
vi.mock('../src/api/client', async (importOriginal) => ({ ...(await importOriginal<object>()), api }));

const accounts: AccountDTO[] = [
  { id: 'a', email: 'me@a.com', color: '#2563eb', status: 'ok' },
  { id: 'b', email: 'me@b.com', color: '#16a34a', status: 'ok' },
];

function group(id: string, name: string, position: number, inboxCount: number): GroupDTO {
  return { id, name, position, color: '#64748b', notify: false, kind: 'builtin', inboxCount, unreadCount: 0 };
}
/** Counts follow the account filter, so each account gets different numbers. */
function groupsFor(accountId?: string | null): GroupDTO[] {
  const n = accountId === 'a' ? 10 : accountId === 'b' ? 20 : 30;
  return [group('important', 'Important', 0, n + 1), group('dev', 'Dev', 1, n + 2), group('low_priority', 'Low priority', 2, n + 3)];
}

function thread(id: string, over: Partial<ThreadSummaryDTO> = {}): ThreadSummaryDTO {
  return {
    id, accountId: id.split(':')[0]!, subject: `Subject ${id}`, snippet: `snippet ${id}`, fromName: `Sender ${id}`,
    fromEmail: `sender-${id.replace(':', '')}@example.com`, lastMessageAt: Date.UTC(2026, 9, 28, 9), unread: true, inInbox: true,
    groupId: 'important', groupName: 'Important', reason: { source: 'mark', text: `Reason for ${id}`, at: null },
    snoozedUntil: null, hasAttachments: false, suggestRule: false, ...over,
  };
}

let all: ThreadSummaryDTO[];
const result = (undoId: string, t: ThreadSummaryDTO | null = null): ActionResult => ({ undoId, thread: t });

beforeEach(() => {
  // jsdom has no layout: give the virtualized list a viewport so rows render (setup.ts restores spies).
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
  Element.prototype.scrollTo ??= () => {};
  vi.resetModules(); // fresh account-filter store per test
  all = [
    thread('a:1', { lastMessageAt: 300 }),
    thread('a:2', { lastMessageAt: 200, groupId: 'dev', groupName: 'Dev', reason: { source: 'heuristic', text: 'In Dev: github.com (automatic guess)', at: null } }),
    thread('b:1', { lastMessageAt: 100 }),
  ];
  for (const fn of Object.values(api)) fn.mockReset();
  api.accounts.mockResolvedValue(accounts);
  api.groups.mockImplementation(async (accountId?: string | null) => groupsFor(accountId));
  api.threads.mockImplementation(async (q: { accountId?: string | null; groupId?: string | null; includeDone?: boolean } = {}): Promise<ThreadPage> => ({
    threads: all.filter((t) => (t.inInbox || q.includeDone) && (!q.accountId || t.accountId === q.accountId) && (!q.groupId || t.groupId === q.groupId)),
    nextCursor: null,
  }));
  api.done.mockImplementation(async (id: string) => result('u-done', { ...all.find((t) => t.id === id)!, inInbox: false }));
  api.snooze.mockImplementation(async (id: string) => result('u-snooze', { ...all.find((t) => t.id === id)!, inInbox: false }));
  api.read.mockImplementation(async (id: string, read: boolean) => result('u-read', { ...all.find((t) => t.id === id)!, unread: !read }));
  api.undo.mockImplementation(async () => result('u-undo', all[1]!));
  api.teach.mockImplementation(async (r: TeachRequest) => {
    const groupId = r.action === 'important' ? 'important' : r.action === 'not_important' ? 'low_priority' : r.groupId!;
    const groupName = groupsFor(null).find((g) => g.id === groupId)!.name;
    return result('u-teach', { ...all.find((t) => t.id === r.threadId)!, groupId, groupName });
  });
  api.teachPreview.mockImplementation(async (id: string) => {
    const t = all.find((x) => x.id === id)!;
    return { subject: t.subject, senderName: t.fromName, sender: { value: t.fromEmail!, count: 3 }, domain: { value: 'example.com', count: 9 }, list: null };
  });
  api.move.mockImplementation(async (id: string, groupId: string) => {
    const groupName = groupsFor(null).find((g) => g.id === groupId)!.name;
    return { ...result('u-move', { ...all.find((t) => t.id === id)!, groupId, groupName }), affected: 1 };
  });
  api.restore.mockImplementation(async (id: string) => result('u-restore', { ...all.find((t) => t.id === id)!, inInbox: true, doneAt: null }));
  api.reportSpam.mockImplementation(async () => result('u-spam'));
});

function ThreadPageStub() {
  const { ids, compose } = (useLocation().state ?? {}) as { ids?: string[]; compose?: string };
  const navigate = useNavigate();
  return (
    <div>
      thread page {useParams().id} ids={ids?.join(',')}
      {compose && ` compose=${compose}`}
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
          <Route path="/t/:id" element={<ThreadPageStub />} />
          <Route path="/compose" element={<div>compose page</div>} />
        </Routes>
        <AppToasts />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByText('Subject a:1');
  return qc;
}

function press(key: string, init: KeyboardEventInit = {}) {
  act(() => {
    fireEvent.keyDown(document.body, { key, ...init });
  });
}

const rowOf = (subject: string) => screen.getByText(subject).closest('[data-thread-id]') as HTMLElement;
const tabs = () => screen.getByRole('tablist', { name: 'Groups' });

describe('Inbox', () => {
  it('shows the merged inbox newest first with account dots, senders and group chips', async () => {
    await renderInbox();
    const rows = screen.getAllByTestId('thread-row');
    expect(rows.map((r) => r.dataset.threadId)).toEqual(['a:1', 'a:2', 'b:1']);
    expect(within(rows[0]!).getByText('Sender a:1')).toBeInTheDocument();
    expect(within(rows[0]!).getByTestId('account-dot')).toHaveStyle({ backgroundColor: '#2563eb' });
    expect(within(rows[2]!).getByTestId('account-dot')).toHaveStyle({ backgroundColor: '#16a34a' });
    expect(within(rows[1]!).getByText('Dev')).toBeInTheDocument();
    expect(api.threads).toHaveBeenCalledWith(expect.objectContaining({ accountId: null, groupId: null }));
  });

  it('j e marks the 2nd thread done, the row disappears, and z undoes it', async () => {
    await renderInbox();
    press('j');
    expect(rowOf('Subject a:2')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('In Dev: github.com (automatic guess)')).toBeInTheDocument();
    press('e');
    await waitFor(() => expect(api.done).toHaveBeenCalledWith('a:2'));
    expect(api.done).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText('Subject a:2')).not.toBeInTheDocument());
    expect(await screen.findByRole('status')).toHaveTextContent(/done/i);

    press('z');
    await waitFor(() => expect(api.undo).toHaveBeenCalledWith('u-done'));
    expect(await screen.findByText('Subject a:2')).toBeInTheDocument();
    expect(screen.getAllByTestId('thread-row').map((r) => r.dataset.threadId)).toEqual(['a:1', 'a:2', 'b:1']);
  });

  it('rolls the row back when the action fails', async () => {
    api.done.mockRejectedValueOnce(new Error('Gmail said no'));
    await renderInbox();
    press('e');
    await waitFor(() => expect(api.done).toHaveBeenCalledWith('a:1'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Gmail said no/);
    expect(screen.getByText('Subject a:1')).toBeInTheDocument();
  });

  it('` cycles the account filter All → A → B → All and the tabs re-fetch counts', async () => {
    await renderInbox();
    const switcher = screen.getByRole('button', { name: /account/i });
    expect(switcher).toHaveTextContent('All accounts');
    await waitFor(() => expect(within(tabs()).getByRole('tab', { name: /Important/ })).toHaveTextContent('31'));

    press('`');
    expect(switcher).toHaveTextContent('me@a');
    await waitFor(() => expect(api.groups).toHaveBeenCalledWith('a'));
    await waitFor(() => expect(within(tabs()).getByRole('tab', { name: /Important/ })).toHaveTextContent('11'));
    await waitFor(() => expect(screen.queryByText('Subject b:1')).not.toBeInTheDocument());
    expect(api.threads).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'a' }));

    press('`');
    expect(switcher).toHaveTextContent('me@b');
    await waitFor(() => expect(api.groups).toHaveBeenCalledWith('b'));
    await waitFor(() => expect(within(tabs()).getByRole('tab', { name: /Important/ })).toHaveTextContent('21'));
    expect(await screen.findByText('Subject b:1')).toBeInTheDocument();
    expect(screen.queryByText('Subject a:1')).not.toBeInTheDocument();

    press('`');
    expect(switcher).toHaveTextContent('All accounts');
    await waitFor(() => expect(within(tabs()).getByRole('tab', { name: /Important/ })).toHaveTextContent('31'));
  });

  it('number keys, ] and [ switch groups; the group chip hides inside its own group', async () => {
    await renderInbox();
    press('2'); // Dev
    await waitFor(() => expect(within(tabs()).getByRole('tab', { name: /Dev/ })).toHaveAttribute('aria-selected', 'true'));
    expect(api.threads).toHaveBeenCalledWith(expect.objectContaining({ groupId: 'dev' }));
    await waitFor(() => expect(screen.queryByText('Subject a:1')).not.toBeInTheDocument());
    expect(within(rowOf('Subject a:2')).queryByText('Dev')).not.toBeInTheDocument();
    press(']');
    await waitFor(() => expect(within(tabs()).getByRole('tab', { name: /Low priority/ })).toHaveAttribute('aria-selected', 'true'));
    press(']');
    await waitFor(() => expect(within(tabs()).getByRole('tab', { name: /All/ })).toHaveAttribute('aria-selected', 'true'));
    press('[');
    await waitFor(() => expect(within(tabs()).getByRole('tab', { name: /Low priority/ })).toHaveAttribute('aria-selected', 'true'));
  });

  it('leaves Tab to the browser', async () => {
    await renderInbox();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => {
      document.body.dispatchEvent(tab);
    });
    expect(tab.defaultPrevented).toBe(false);
    expect(within(tabs()).getByRole('tab', { name: /All/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('Enter opens the selected thread and passes the list order for j/k in the thread', async () => {
    await renderInbox();
    press('Enter');
    expect(await screen.findByText('thread page a:1 ids=a:1,a:2,b:1')).toBeInTheDocument();
  });

  it('u toggles read, optimistically', async () => {
    await renderInbox();
    expect(rowOf('Subject a:1')).toHaveAttribute('data-unread', 'true');
    press('u');
    await waitFor(() => expect(api.read).toHaveBeenCalledWith('a:1', true));
    await waitFor(() => expect(rowOf('Subject a:1')).toHaveAttribute('data-unread', 'false'));
  });

  it('h opens the snooze picker; a preset snoozes and removes the row', async () => {
    await renderInbox();
    press('h');
    const dialog = await screen.findByRole('dialog', { name: /snooze/i });
    fireEvent.click(within(dialog).getByRole('button', { name: /Tomorrow morning/ }));
    await waitFor(() => expect(api.snooze).toHaveBeenCalledWith('a:1', expect.any(Number)));
    const until = new Date(api.snooze.mock.calls[0]![1] as number);
    expect([until.getHours(), until.getMinutes()]).toEqual([8, 0]);
    await waitFor(() => expect(screen.queryByText('Subject a:1')).not.toBeInTheDocument());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('the snooze picker takes typed times and refuses past ones', async () => {
    await renderInbox();
    press('h');
    const input = within(await screen.findByRole('dialog', { name: /snooze/i })).getByRole('textbox');
    fireEvent.change(input, { target: { value: 'yesterday' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(api.snooze).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'in 3 days' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.snooze).toHaveBeenCalledWith('a:1', expect.any(Number)));
    expect(api.snooze.mock.calls[0]![1]).toBeGreaterThan(Date.now() + 2 * 86_400_000);
  });

  /** The scope prompt has the focus; its keys land there, and a second + or - reaches it alone. */
  const inPrompt = (key: string) =>
    act(() => {
      fireEvent.keyDown(document.activeElement!, { key });
    });

  it('+ asks what to mark, and teaches nothing until the owner answers', async () => {
    await renderInbox();
    press('j');
    press('+');
    const dialog = await screen.findByRole('dialog', { name: 'Mark as important' });
    expect(within(dialog).getByText('Subject a:2')).toBeInTheDocument();
    expect(await within(dialog).findByRole('radio', { name: /Everyone at example\.com · 9/ })).toBeInTheDocument();
    expect(api.teach).not.toHaveBeenCalled();
  });

  it('+ then + marks the sender as important', async () => {
    await renderInbox();
    press('j');
    press('+');
    await screen.findByRole('dialog', { name: 'Mark as important' });
    inPrompt('+');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(api.teach).toHaveBeenCalledWith({ threadId: 'a:2', action: 'important', scope: 'sender' }));
  });

  it('- asks too; a number picks the scope, and the row moves right away', async () => {
    await renderInbox();
    press('-');
    await screen.findByRole('radio', { name: /Everyone at/ });
    expect(screen.getByRole('dialog', { name: 'Mark as not important' })).toBeInTheDocument();
    inPrompt('3');
    expect(await within(rowOf('Subject a:1')).findByText('Low priority')).toBeInTheDocument();
    await waitFor(() => expect(api.teach).toHaveBeenCalledWith({ threadId: 'a:1', action: 'not_important', scope: 'domain' }));
  });

  it('"only this email" moves it with no teaching', async () => {
    await renderInbox();
    press('-');
    await screen.findByRole('dialog', { name: 'Mark as not important' });
    inPrompt('1');
    await waitFor(() => expect(api.move).toHaveBeenCalledWith('a:1', 'low_priority'));
    expect(api.teach).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent('Subject a:1 → Low priority');
  });

  it('Esc leaves everything as it was', async () => {
    await renderInbox();
    press('+');
    await screen.findByRole('dialog', { name: 'Mark as important' });
    inPrompt('Escape');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.teach).not.toHaveBeenCalled();
    expect(api.move).not.toHaveBeenCalled();
  });

  it('the toast says what moved and offers no whole domain', async () => {
    api.teach.mockImplementation(async (r: TeachRequest) => ({ ...result('u-teach', { ...all.find((t) => t.id === r.threadId)!, groupId: 'low_priority', groupName: 'Low priority' }), affected: 31 }));
    await renderInbox();
    press('-');
    await screen.findByRole('dialog', { name: 'Mark as not important' });
    inPrompt('-');
    const toast = await screen.findByRole('status');
    expect(toast).toHaveTextContent('Sender a:1 → Low priority · 31 emails');
    expect(within(toast).queryByRole('button', { name: /whole domain/i })).toBeNull();
  });

  it('teaching moves every listed thread from the sender at once, not only the selected one', async () => {
    all[1] = { ...all[1]!, fromEmail: all[0]!.fromEmail, groupId: 'important', groupName: 'Important' };
    let finish!: (r: ActionResult) => void;
    api.teach.mockReturnValue(new Promise((r) => (finish = r)));
    await renderInbox();
    press('-');
    await screen.findByRole('dialog', { name: 'Mark as not important' });
    inPrompt('-');
    expect(await within(rowOf('Subject a:1')).findByText('Low priority')).toBeInTheDocument();
    expect(within(rowOf('Subject a:2')).getByText('Low priority')).toBeInTheDocument();
    expect(within(rowOf('Subject b:1')).queryByText('Low priority')).toBeNull();
    finish(result('u-teach', { ...all[0]!, groupId: 'low_priority', groupName: 'Low priority' }));
    await screen.findByRole('status');
  });

  it('a failed teaching puts every row back', async () => {
    all[1] = { ...all[1]!, fromEmail: all[0]!.fromEmail, groupId: 'dev', groupName: 'Dev' };
    api.teach.mockRejectedValue(new Error('Server down'));
    await renderInbox();
    press('-');
    await screen.findByRole('dialog', { name: 'Mark as not important' });
    inPrompt('-');
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't teach: Server down");
    await waitFor(() => expect(within(rowOf('Subject a:2')).getByText('Dev')).toBeInTheDocument());
    expect(within(rowOf('Subject a:1')).queryByText('Low priority')).toBeNull();
  });

  it('the right-click items ask as well', async () => {
    await renderInbox();
    fireEvent.contextMenu(rowOf('Subject a:1'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Not important/ }));
    expect(await screen.findByRole('dialog', { name: 'Mark as not important' })).toBeInTheDocument();
    expect(api.teach).not.toHaveBeenCalled();
  });

  it('every thread action names the email in its toast', async () => {
    await renderInbox();
    press('e');
    expect(await screen.findByRole('status')).toHaveTextContent('Subject a:1 · Done');
  });

  it('the new-group button creates a group and selects its tab', async () => {
    const created = { ...group('g-new', 'Travel', 9, 0), kind: 'custom' as const };
    api.createGroup.mockResolvedValue(created);
    api.groups.mockImplementation(async (accountId?: string | null) => [...groupsFor(accountId), created]);
    await renderInbox();
    fireEvent.click(screen.getByRole('button', { name: 'New group' }));
    const input = screen.getByRole('textbox', { name: 'Group name' });
    fireEvent.change(input, { target: { value: 'Travel' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(within(tabs()).getByRole('tab', { name: /Travel/ })).toHaveAttribute('aria-selected', 'true'));
    expect(api.createGroup).toHaveBeenCalledWith({ name: 'Travel', color: expect.stringMatching(/^#[0-9a-f]{6}$/) });
  });

  it('l opens the group picker and teaches "always group to" the chosen group', async () => {
    await renderInbox();
    press('l');
    const dialog = await screen.findByRole('dialog', { name: /group/i });
    const input = within(dialog).getByRole('textbox');
    fireEvent.change(input, { target: { value: 'dev' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.teach).toHaveBeenCalledWith({ threadId: 'a:1', action: 'always_group', scope: 'sender', groupId: 'dev' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('the group picker applies the chosen scope, and "only this email" moves just the one', async () => {
    await renderInbox();
    press('l');
    let dialog = await screen.findByRole('dialog', { name: /group/i });
    await within(dialog).findByRole('radio', { name: /Everyone at example\.com · 9/ });
    let input = within(dialog).getByRole('textbox');
    fireEvent.keyDown(input, { key: 'ArrowRight' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.teach).toHaveBeenCalledWith({ threadId: 'a:1', action: 'always_group', scope: 'domain', groupId: 'low_priority' }));

    press('l');
    dialog = await screen.findByRole('dialog', { name: /group/i });
    input = within(dialog).getByRole('textbox');
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.move).toHaveBeenCalledWith('a:1', 'dev'));
    expect(api.teach).toHaveBeenCalledTimes(1);
  });

  it('the group picker closes on Escape without teaching', async () => {
    await renderInbox();
    press('l');
    const dialog = await screen.findByRole('dialog', { name: /group/i });
    fireEvent.keyDown(within(dialog).getByRole('textbox'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.teach).not.toHaveBeenCalled();
  });

  it('the status strip says why the selected thread is here and offers "Make this a rule?"', async () => {
    all[1] = { ...all[1]!, suggestRule: true, fromName: 'Bolt', fromEmail: 'news@bolt.eu' };
    await renderInbox();
    const strip = screen.getByTestId('reason-strip');
    expect(strip).toHaveTextContent('Reason for a:1');
    expect(within(strip).queryByRole('button', { name: /make this a rule/i })).not.toBeInTheDocument();
    press('j');
    expect(strip).toHaveTextContent('In Dev: github.com (automatic guess)');
    const rule = within(strip).getByRole('button', { name: /make this a rule/i });
    expect(rule).toHaveAttribute('title', 'Always group Bolt to Dev');
    fireEvent.click(rule);
    await screen.findByRole('dialog', { name: 'Always group to Dev' });
    expect(api.teach).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    await waitFor(() => expect(api.teach).toHaveBeenCalledWith({ threadId: 'a:2', action: 'always_group', scope: 'sender', groupId: 'dev' }));
  });

  it('rows keep one height: the reason is a chip tooltip and the strip, never a line in the row', async () => {
    await renderInbox();
    const row = rowOf('Subject a:2');
    expect(within(row).getByText('Dev')).toHaveAttribute('title', 'In Dev: github.com (automatic guess)');
    press('j');
    expect(row).toHaveAttribute('aria-selected', 'true');
    expect(row).toHaveClass('h-9');
    expect(within(row).queryByText('In Dev: github.com (automatic guess)')).not.toBeInTheDocument();
  });

  it('shortcuts are ignored while a picker input has focus', async () => {
    await renderInbox();
    press('h');
    const input = within(await screen.findByRole('dialog', { name: /snooze/i })).getByRole('textbox');
    act(() => {
      fireEvent.keyDown(input, { key: 'e' });
    });
    expect(api.done).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('selects the first row on load and announces it through aria-activedescendant', async () => {
    await renderInbox();
    const list = screen.getByRole('listbox', { name: 'Threads' });
    expect(rowOf('Subject a:1')).toHaveAttribute('aria-selected', 'true');
    expect(list).toHaveAttribute('tabindex', '0');
    expect(list).toHaveAttribute('aria-activedescendant', rowOf('Subject a:1').id);
    press('j');
    expect(list).toHaveAttribute('aria-activedescendant', rowOf('Subject a:2').id);
    press('e');
    await waitFor(() => expect(api.done).toHaveBeenCalledWith('a:2'));
  });

  it('several j presses in one tick each move a row', async () => {
    await renderInbox();
    act(() => {
      fireEvent.keyDown(document.body, { key: 'j' });
      fireEvent.keyDown(document.body, { key: 'j' });
    });
    expect(rowOf('Subject b:1')).toHaveAttribute('aria-selected', 'true');
  });

  it('the arrow keys move the selection while the list has focus', async () => {
    await renderInbox();
    const list = screen.getByRole('listbox', { name: 'Threads' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(rowOf('Subject a:2')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(list, { key: 'End' });
    expect(rowOf('Subject b:1')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(rowOf('Subject a:2')).toHaveAttribute('aria-selected', 'true');
  });

  it('selects the first row again when the filter changes', async () => {
    await renderInbox();
    press('j');
    press('j');
    expect(rowOf('Subject b:1')).toHaveAttribute('aria-selected', 'true');
    press('1'); // Important: a:1, b:1
    await waitFor(() => expect(screen.queryByText('Subject a:2')).not.toBeInTheDocument());
    await waitFor(() => expect(rowOf('Subject a:1')).toHaveAttribute('aria-selected', 'true'));
    expect(rowOf('Subject b:1')).toHaveAttribute('aria-selected', 'false');
  });

  it('rows are links to the thread; a click opens it in the app with the list order', async () => {
    await renderInbox();
    const row = rowOf('Subject a:2');
    expect(row).toHaveAttribute('href', '/t/a%3A2');
    fireEvent.click(row);
    expect(await screen.findByText('thread page a:2 ids=a:1,a:2,b:1')).toBeInTheDocument();
  });

  it('comes back from a thread on the same row and scroll offset', async () => {
    // jsdom has no layout or scrolling: give the list a scroll height, and let scrollTo move
    // scrollTop and tell the virtualizer.
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(60 * 36);
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(600);
    vi.spyOn(Element.prototype, 'scrollTo').mockImplementation(function (this: Element, opts?: ScrollToOptions | number) {
      if (typeof opts === 'object' && opts.top !== undefined) {
        this.scrollTop = opts.top;
        this.dispatchEvent(new Event('scroll'));
      }
    });
    all = Array.from({ length: 60 }, (_, i) => thread(`a:${i + 1}`, { lastMessageAt: 10_000 - i }));
    await renderInbox();
    for (let i = 0; i < 39; i++) press('j');
    // the virtualizer scrolls the selection into view (asynchronously)
    await waitFor(() => expect(rowOf('Subject a:40')).toHaveAttribute('aria-selected', 'true'));
    const list = screen.getByRole('listbox', { name: 'Threads' });
    fireEvent.scroll(list, { target: { scrollTop: 1000 } });
    press('Enter');
    fireEvent.click(await screen.findByRole('button', { name: 'stub back' }));

    await waitFor(() => expect(rowOf('Subject a:40')).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByRole('listbox', { name: 'Threads' }).scrollTop).toBe(1000);
  });

  it('comes back on the thread last read when the thread view moved on to another one', async () => {
    const { noteOpenedThread } = await import('../src/state/listMemory');
    await renderInbox();
    press('Enter');
    await screen.findByText(/thread page a:1/);
    noteOpenedThread('b:1'); // what the app records as the thread view moves with j
    fireEvent.click(screen.getByRole('button', { name: 'stub back' }));
    await screen.findByText('Subject b:1');
    expect(rowOf('Subject b:1')).toHaveAttribute('aria-selected', 'true');
  });

  it('c goes to compose', async () => {
    await renderInbox();
    press('c');
    expect(await screen.findByText('compose page')).toBeInTheDocument();
  });
});

describe('Show done', () => {
  const toggle = () => screen.getByRole('button', { name: /Show done/ });
  const doneThread = (over: Partial<ThreadSummaryDTO> = {}) => thread('a:9', { lastMessageAt: 250, inInbox: false, doneAt: 1000, unread: false, ...over });

  it('is off by default: done threads are not asked for or listed', async () => {
    all.push(doneThread());
    await renderInbox();
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(api.threads.mock.calls.every(([q]) => !q.includeDone)).toBe(true);
    expect(screen.queryByText('Subject a:9')).not.toBeInTheDocument();
  });

  it('sits in the group-tabs row with its key hint', async () => {
    await renderInbox();
    const sub = screen.getByTestId('subheader');
    expect(within(sub).getByRole('button', { name: /Show done/ })).toBe(toggle());
    expect(within(toggle()).getByText('D')).toBeInTheDocument();
  });

  it('turning it on lists done threads dimmed, with a Done chip in place of the group chip', async () => {
    all.push(doneThread());
    await renderInbox();
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    const row = rowOf(await screen.findByText('Subject a:9').then((e) => e.textContent!));
    expect(row).toHaveAttribute('data-done', 'true');
    expect(row).toHaveClass('[&>*]:opacity-60');
    expect(within(row).getByText('Done')).toBeInTheDocument();
    expect(within(row).getByTestId('chip-icon')).toBeInTheDocument();
    expect(within(row).queryByText('Important')).not.toBeInTheDocument();
    expect(rowOf('Subject a:1')).not.toHaveAttribute('data-done', 'true');
  });

  it('d toggles it, and the choice is remembered in this browser', async () => {
    await renderInbox();
    press('d');
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('sm.showDone')).toBe('1');
    press('d');
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(localStorage.getItem('sm.showDone')).toBe('0');
  });

  it('starts on when it was left on', async () => {
    localStorage.setItem('sm.showDone', '1');
    all.push(doneThread());
    await renderInbox();
    expect(await screen.findByText('Subject a:9')).toBeInTheDocument();
    expect(api.threads.mock.calls[0]?.[0]).toMatchObject({ includeDone: true });
  });

  it('e on a done row moves it to the inbox, with Undo, and leaves it listed and undimmed', async () => {
    localStorage.setItem('sm.showDone', '1');
    all = [doneThread(), thread('a:1')];
    await renderInbox();
    expect(rowOf('Subject a:9')).toHaveAttribute('aria-selected', 'true');
    press('e');
    await waitFor(() => expect(api.restore).toHaveBeenCalledExactlyOnceWith('a:9'));
    expect(api.done).not.toHaveBeenCalled();
    const toast = await screen.findByRole('status');
    expect(toast).toHaveTextContent('· Moved to inbox');
    expect(within(toast).getByRole('button', { name: /Undo/ })).toBeInTheDocument();
    expect(rowOf('Subject a:9')).not.toHaveAttribute('data-done', 'true');
  });

  it('z after Move to inbox marks it done again', async () => {
    localStorage.setItem('sm.showDone', '1');
    all = [doneThread(), thread('a:1')];
    api.undo.mockResolvedValue(result('u-redo', doneThread()));
    await renderInbox();
    press('e');
    await screen.findByText(/· Moved to inbox$/);
    press('z');
    await waitFor(() => expect(api.undo).toHaveBeenCalledWith('u-restore'));
    await waitFor(() => expect(rowOf('Subject a:9')).toHaveAttribute('data-done', 'true'));
  });

  it('the hover action on a done row is Move to inbox', async () => {
    localStorage.setItem('sm.showDone', '1');
    all = [doneThread(), thread('a:1')];
    await renderInbox();
    const wrap = rowOf('Subject a:9').parentElement!;
    expect(within(wrap).queryByRole('button', { name: 'Done', hidden: true })).not.toBeInTheDocument();
    fireEvent.click(within(wrap).getByRole('button', { name: 'Move to inbox', hidden: true }));
    await waitFor(() => expect(api.restore).toHaveBeenCalledWith('a:9'));
  });

  it('with it on, Done dims the row where it is and moves on to the next open row, so a second e cannot undo it', async () => {
    localStorage.setItem('sm.showDone', '1');
    all = [thread('a:1', { lastMessageAt: 300 }), doneThread({ id: 'a:8', subject: 'Subject a:8', lastMessageAt: 250 }), thread('a:2', { lastMessageAt: 200 })];
    api.done.mockImplementation(async (id: string) => result('u-done', { ...all.find((t) => t.id === id)!, inInbox: false, doneAt: 2000 }));
    await renderInbox();
    press('e');
    await waitFor(() => expect(rowOf('Subject a:1')).toHaveAttribute('data-done', 'true'));
    expect(rowOf('Subject a:2')).toHaveAttribute('aria-selected', 'true');
    press('e');
    await waitFor(() => expect(api.done).toHaveBeenCalledTimes(2));
    expect(api.done).toHaveBeenLastCalledWith('a:2');
    expect(api.restore).not.toHaveBeenCalled();
  });

  it('a thread back in the inbox that still has a done time is an ordinary row', async () => {
    all = [thread('a:1', { inInbox: true, doneAt: 1000 })];
    await renderInbox();
    expect(rowOf('Subject a:1')).not.toHaveAttribute('data-done', 'true');
    press('e');
    await waitFor(() => expect(api.done).toHaveBeenCalledWith('a:1'));
    expect(api.restore).not.toHaveBeenCalled();
  });
});

describe('Report spam', () => {
  it('! reports the selected thread, asks for no confirmation, and the next row takes its place', async () => {
    await renderInbox();
    press('!', { shiftKey: true });
    await waitFor(() => expect(api.reportSpam).toHaveBeenCalledWith('a:1'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Subject a:1')).not.toBeInTheDocument();
    expect(await screen.findByText(/Reported as spam$/)).toBeInTheDocument();
    expect(rowOf('Subject a:2')).toHaveAttribute('aria-selected', 'true');
  });

  it('works on the row under the mouse', async () => {
    await renderInbox();
    fireEvent.mouseMove(rowOf('Subject b:1'));
    press('!');
    await waitFor(() => expect(api.reportSpam).toHaveBeenCalledWith('b:1'));
  });

  it('works on a Done row shown by Show done', async () => {
    all.push(thread('a:9', { lastMessageAt: 250, inInbox: false, doneAt: 1000, unread: false }));
    await renderInbox();
    fireEvent.click(screen.getByRole('button', { name: /Show done/ }));
    const row = await screen.findByText('Subject a:9');
    fireEvent.mouseMove(row.closest('[data-thread-id]')!);
    press('!');
    await waitFor(() => expect(api.reportSpam).toHaveBeenCalledWith('a:9'));
    await waitFor(() => expect(screen.queryByText('Subject a:9')).not.toBeInTheDocument());
  });

  it('z undoes it and selects the thread again', async () => {
    api.undo.mockImplementation(async () => result('u-undo', all[0]!));
    await renderInbox();
    press('!');
    await screen.findByText(/Reported as spam$/);
    press('z');
    await waitFor(() => expect(api.undo).toHaveBeenCalledWith('u-spam'));
    expect(await screen.findByText('Undone')).toBeInTheDocument();
    await waitFor(() => expect(rowOf('Subject a:1')).toHaveAttribute('aria-selected', 'true'));
  });

  it('puts the row back when Gmail refuses', async () => {
    api.reportSpam.mockRejectedValue(new Error('Gmail is down'));
    await renderInbox();
    press('!');
    expect(await screen.findByText("Couldn't report spam: Gmail is down")).toBeInTheDocument();
    expect(screen.getByText('Subject a:1')).toBeInTheDocument();
  });
});

describe('context menu', () => {
  const openMenu = (subject = 'Subject a:2') => {
    fireEvent.contextMenu(rowOf(subject), { clientX: 120, clientY: 240 });
    return screen.getByRole('menu', { name: /actions/i });
  };
  const item = (name: string | RegExp) => screen.getByRole('menuitem', { name });

  it('right-click opens the menu at the cursor with every item, and selects the row', async () => {
    await renderInbox();
    const menu = openMenu();
    expect(menu).toHaveStyle({ left: '120px', top: '240px' });
    expect(rowOf('Subject a:2')).toHaveAttribute('aria-selected', 'true');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.querySelector('.truncate')?.textContent)).toEqual([
      'Open', 'Open in new tab', 'Reply', 'Reply all', 'Forward', 'Done', 'Snooze…', 'Report spam', 'Mark as read', 'Important to me', 'Not important', 'Always group to…', 'Copy link',
    ]);
    expect(within(menu).getAllByRole('separator')).toHaveLength(4);
  });

  it('shows the keys that work here', async () => {
    await renderInbox();
    openMenu();
    expect(within(item(/^Done/)).getByText('E')).toBeInTheDocument();
    expect(within(item(/^Reply all/)).getByText('A')).toBeInTheDocument();
    expect(within(item(/^Snooze/)).getByText('H')).toBeInTheDocument();
    expect(within(item(/^Always group/)).getByText('L')).toBeInTheDocument();
    expect(within(item(/^Report spam/)).getByText('!')).toBeInTheDocument();
  });

  it('Report spam takes the row out at once and offers Undo', async () => {
    await renderInbox();
    openMenu();
    fireEvent.click(item(/^Report spam/));
    await waitFor(() => expect(api.reportSpam).toHaveBeenCalledWith('a:2'));
    expect(screen.queryByText('Subject a:2')).not.toBeInTheDocument();
    const toast = await screen.findByRole('status');
    expect(toast).toHaveTextContent('Reported as spam');
    expect(within(toast).getByRole('button', { name: /^Undo/ })).toBeInTheDocument();
  });

  it('prevents the browser menu', async () => {
    await renderInbox();
    expect(fireEvent.contextMenu(rowOf('Subject a:1'))).toBe(false);
  });

  it('Escape closes it, and the row stays selected', async () => {
    await renderInbox();
    openMenu();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(rowOf('Subject a:2')).toHaveAttribute('aria-selected', 'true');
    // Escape was the menu's: the page behind did not act on it.
    expect(screen.getByRole('listbox', { name: 'Threads' })).toBeInTheDocument();
  });

  it('the list keys do nothing while it is open', async () => {
    await renderInbox();
    openMenu();
    press('e');
    expect(api.done).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('Done', async () => {
    await renderInbox();
    openMenu();
    fireEvent.click(item(/^Done/));
    await waitFor(() => expect(api.done).toHaveBeenCalledWith('a:2'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(await screen.findByText(/· Done$/)).toBeInTheDocument();
  });

  it('a picker opened from the menu keeps the focus', async () => {
    await renderInbox();
    rowOf('Subject a:2').focus();
    openMenu();
    fireEvent.click(item(/^Always group/));
    const dialog = await screen.findByRole('dialog', { name: /group/i });
    expect(within(dialog).getByRole('textbox')).toHaveFocus();
  });

  it('the rows behind it do not follow the mouse', async () => {
    await renderInbox();
    openMenu();
    fireEvent.mouseMove(rowOf('Subject a:1'));
    expect(rowOf('Subject a:2')).toHaveAttribute('aria-selected', 'true');
  });

  it('Snooze… opens the snooze picker for that row', async () => {
    await renderInbox();
    openMenu();
    fireEvent.click(item(/^Snooze/));
    const dialog = await screen.findByRole('dialog', { name: /snooze/i });
    fireEvent.click(within(dialog).getByRole('button', { name: /Tomorrow morning/ }));
    await waitFor(() => expect(api.snooze).toHaveBeenCalledWith('a:2', expect.any(Number)));
  });

  it('offers Mark as read on an unread row', async () => {
    await renderInbox();
    openMenu();
    fireEvent.click(item(/^Mark as read/));
    await waitFor(() => expect(api.read).toHaveBeenCalledWith('a:2', true));
  });

  it('offers Mark as unread on a read row', async () => {
    all[1] = thread('a:2', { unread: false });
    await renderInbox();
    openMenu();
    fireEvent.click(item(/^Mark as unread/));
    await waitFor(() => expect(api.read).toHaveBeenCalledWith('a:2', false));
  });

  it('Important to me and Not important ask first, then teach what was chosen', async () => {
    await renderInbox();
    openMenu();
    fireEvent.click(item(/^Important to me/));
    await screen.findByRole('dialog', { name: 'Mark as important' });
    expect(api.teach).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    await waitFor(() => expect(api.teach).toHaveBeenCalledWith({ threadId: 'a:2', action: 'important', scope: 'sender' }));
    openMenu();
    fireEvent.click(item(/^Not important/));
    await screen.findByRole('dialog', { name: 'Mark as not important' });
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    await waitFor(() => expect(api.teach).toHaveBeenCalledWith({ threadId: 'a:2', action: 'not_important', scope: 'sender' }));
  });

  it('Always group to… opens the group picker for that row', async () => {
    await renderInbox();
    openMenu();
    fireEvent.click(item(/^Always group/));
    const dialog = await screen.findByRole('dialog', { name: /group/i });
    const input = within(dialog).getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Dev' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.teach).toHaveBeenCalledWith({ threadId: 'a:2', action: 'always_group', scope: 'sender', groupId: 'dev' }));
  });

  it('Open goes to the thread with the list', async () => {
    await renderInbox();
    openMenu();
    fireEvent.click(item(/^Open(?! in new)/));
    expect(await screen.findByText(/thread page a:2 ids=a:1,a:2,b:1/)).toBeInTheDocument();
  });

  it('Open in new tab opens the thread link', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await renderInbox();
    openMenu();
    fireEvent.click(item('Open in new tab'));
    expect(open).toHaveBeenCalledWith('/t/a%3A2', '_blank', 'noopener');
  });

  it.each([
    ['Reply', 'reply'],
    ['Reply all', 'replyAll'],
    ['Forward', 'forward'],
  ])('%s goes to the thread and asks for its composer', async (label, mode) => {
    await renderInbox();
    openMenu();
    fireEvent.click(item(new RegExp(`^${label}(?! all)`)));
    expect(await screen.findByText(new RegExp(`thread page a:2 ids=a:1,a:2,b:1 compose=${mode}`))).toBeInTheDocument();
  });

  it.each([
    ['r', 'reply'],
    ['a', 'replyAll'],
    ['f', 'forward'],
  ])('%s on a row does the same', async (key, mode) => {
    await renderInbox();
    press(key);
    expect(await screen.findByText(new RegExp(`thread page a:1 ids=a:1,a:2,b:1 compose=${mode}`))).toBeInTheDocument();
  });

  it('Copy link puts the full thread link on the clipboard and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { clipboard: { writeText } }));
    await renderInbox();
    openMenu();
    fireEvent.click(item('Copy link'));
    expect(await screen.findByText('Link copied')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(`${location.origin}/t/a%3A2`);
  });

  it('says so when the clipboard is out of reach', async () => {
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { clipboard: undefined }));
    await renderInbox();
    openMenu();
    fireEvent.click(item('Copy link'));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't copy the link");
  });

  it('on a done row, Done becomes Move to inbox', async () => {
    localStorage.setItem('sm.showDone', '1');
    all.push(thread('a:9', { lastMessageAt: 50, inInbox: false, doneAt: 1000 }));
    await renderInbox();
    await screen.findByText('Subject a:9');
    openMenu('Subject a:9');
    expect(screen.queryByRole('menuitem', { name: /^Done/ })).not.toBeInTheDocument();
    fireEvent.click(item(/^Move to inbox/));
    await waitFor(() => expect(api.restore).toHaveBeenCalledWith('a:9'));
    expect(await screen.findByText(/· Moved to inbox$/)).toBeInTheDocument();
  });

  it.each([
    ['the ContextMenu key', { key: 'ContextMenu' }],
    ['Shift+F10', { key: 'F10', shiftKey: true }],
  ])('%s opens it on the selected row, with focus on the first item', async (_, init) => {
    await renderInbox();
    press('j');
    await waitFor(() => expect(rowOf('Subject a:2')).toHaveAttribute('aria-selected', 'true'));
    press(init.key, init);
    expect(item(/^Open(?! in new)/)).toHaveFocus();
    fireEvent.click(item(/^Done/));
    await waitFor(() => expect(api.done).toHaveBeenCalledWith('a:2'));
  });

  it('F10 alone does nothing', async () => {
    await renderInbox();
    press('F10');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('the keys leave a text field alone', async () => {
    await renderInbox();
    const input = screen.getByRole('textbox', { name: 'Search mail' });
    input.focus();
    fireEvent.keyDown(input, { key: 'ContextMenu' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('the keys do nothing while a picker is open', async () => {
    await renderInbox();
    press('h');
    await screen.findByRole('dialog', { name: /snooze/i });
    press('ContextMenu');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
