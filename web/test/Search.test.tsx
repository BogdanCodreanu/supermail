import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountDTO, ThreadSummaryDTO } from '@supermail/shared';
import { api } from '../src/api/client';
import { formatRowDate } from '../src/components/ThreadRow';
import { AppToasts, resetToasts } from '../src/state/toasts';
import { Search } from '../src/views/Search';

vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  return { ...actual, api: { search: vi.fn(), accounts: vi.fn(), groups: vi.fn(), done: vi.fn(), restore: vi.fn(), snooze: vi.fn(), read: vi.fn(), teach: vi.fn(), undo: vi.fn(), reportSpam: vi.fn() } };
});
const mocked = vi.mocked(api);

const accounts: AccountDTO[] = [{ id: 'a', email: 'me@a.com', color: '#2563eb', status: 'ok' }];
function thread(id: string, over: Partial<ThreadSummaryDTO> = {}): ThreadSummaryDTO {
  return {
    id, accountId: 'a', subject: `Subject ${id}`, snippet: 'snippet', fromName: `Sender ${id}`, fromEmail: 'x@example.com',
    lastMessageAt: Date.UTC(2025, 2, 3, 9), unread: false, inInbox: true, groupId: 'dev', groupName: 'Dev',
    reason: { source: 'heuristic', text: 'In Dev (automatic guess)', at: null }, snoozedUntil: null, hasAttachments: false, suggestRule: false, ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.accounts.mockResolvedValue(accounts);
  mocked.search.mockResolvedValue({ threads: [thread('a:1'), thread('a:2', { inInbox: false })], nextCursor: null });
  resetToasts();
});

function ThreadPage() {
  const { ids, compose } = (useLocation().state ?? {}) as { ids?: string[]; compose?: string };
  return (
    <div>
      thread page {useParams().id} ids={ids?.join(',')}
      {compose && ` compose=${compose}`}
    </div>
  );
}

function renderSearch(path = '/search?q=invoice') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/', path]} initialIndex={1}>
        <Routes>
          <Route path="/" element={<div>inbox page</div>} />
          <Route path="/search" element={<Search />} />
          <Route path="/t/:id" element={<ThreadPage />} />
        </Routes>
        <AppToasts />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const press = (key: string) =>
  act(() => {
    fireEvent.keyDown(document.body, { key });
  });
const rowOf = (subject: string) => screen.getByText(subject).closest('[role="option"]') as HTMLElement;

describe('Search', () => {
  it('shows results as a listbox with aria-selected and the inbox date format', async () => {
    renderSearch();
    await screen.findByText('Subject a:1');
    const list = screen.getByRole('listbox', { name: 'Search results' });
    expect(rowOf('Subject a:1')).toHaveAttribute('aria-selected', 'true');
    expect(rowOf('Subject a:2')).toHaveAttribute('aria-selected', 'false');
    expect(list).toHaveAttribute('aria-activedescendant', rowOf('Subject a:1').id);
    expect(list.querySelector('[aria-current]')).toBeNull();
    expect(within(rowOf('Subject a:1')).getByText(formatRowDate(Date.UTC(2025, 2, 3, 9)))).toBeInTheDocument();
    expect(within(rowOf('Subject a:2')).getByText('Archived')).toBeInTheDocument();
  });

  it('j scrolls the selection into view; Enter opens it with the result order', async () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    renderSearch();
    await screen.findByText('Subject a:1');
    press('j');
    expect(rowOf('Subject a:2')).toHaveAttribute('aria-selected', 'true');
    expect(scrolled.at(-1)).toBe(rowOf('Subject a:2'));
    press('Enter');
    expect(await screen.findByText('thread page a:2 ids=a:1,a:2')).toBeInTheDocument();
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('rows are links, and a click opens the thread', async () => {
    renderSearch();
    await screen.findByText('Subject a:1');
    expect(rowOf('Subject a:1')).toHaveAttribute('href', '/t/a%3A1');
    fireEvent.click(rowOf('Subject a:1'));
    expect(await screen.findByText('thread page a:1 ids=a:1,a:2')).toBeInTheDocument();
  });

  it('Escape in the field leaves the field; Escape again goes back', async () => {
    renderSearch();
    await screen.findByText('Subject a:1');
    const field = screen.getByRole('textbox', { name: 'Search mail' });
    press('/');
    expect(field).toHaveFocus();
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(field).not.toHaveFocus();
    expect(screen.getByText('Subject a:1')).toBeInTheDocument();
    press('Escape');
    expect(await screen.findByText('inbox page')).toBeInTheDocument();
  });

  it('uses the search panel context and has only its own search field', async () => {
    renderSearch();
    await screen.findByText('Subject a:1');
    const panel = screen.getByRole('complementary', { name: 'Keyboard shortcuts' });
    expect(within(panel).getByText('Back')).toBeInTheDocument();
    expect(within(panel).queryByText('Done')).not.toBeInTheDocument();
    expect(screen.getAllByRole('textbox', { name: 'Search mail' })).toHaveLength(1);
  });

  it('a new query from the field updates the URL and runs the search', async () => {
    renderSearch('/search');
    const field = screen.getByRole('textbox', { name: 'Search mail' });
    fireEvent.change(field, { target: { value: 'from:bolt' } });
    fireEvent.submit(field);
    await waitFor(() => expect(mocked.search).toHaveBeenCalledWith('from:bolt'));
  });
});

describe('Search context menu', () => {
  const openMenu = async (subject: string) => {
    await screen.findByText(subject);
    fireEvent.contextMenu(rowOf(subject), { clientX: 10, clientY: 10 });
    return screen.getByRole('menu', { name: /actions/i });
  };

  it('right-click opens the menu and selects the row', async () => {
    renderSearch();
    const menu = await openMenu('Subject a:2');
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(13);
    expect(rowOf('Subject a:2')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('Report spam drops the result and offers Undo; it shows no key, since ! does not work here', async () => {
    mocked.reportSpam.mockResolvedValue({ undoId: 'u-spam', thread: null });
    renderSearch();
    await openMenu('Subject a:1');
    const item = screen.getByRole('menuitem', { name: /^Report spam/ });
    expect(item.textContent).toBe('Report spam');
    fireEvent.click(item);
    await waitFor(() => expect(mocked.reportSpam).toHaveBeenCalledWith('a:1'));
    expect(await screen.findByText('Reported as spam')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Subject a:1')).not.toBeInTheDocument());
  });

  it('only shows keys that work on this screen', async () => {
    renderSearch();
    await openMenu('Subject a:1');
    expect(within(screen.getByRole('menuitem', { name: /^Open(?! in new)/ })).getByText('↵')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /^Done/ }).textContent).toBe('Done');
    expect(screen.getByRole('menuitem', { name: /^Reply$/ }).textContent).toBe('Reply');
  });

  it('Done marks a thread in the inbox done, updates the row and offers Undo', async () => {
    mocked.done.mockResolvedValue({ undoId: 'u1', thread: thread('a:1', { inInbox: false, doneAt: 5 }) });
    renderSearch();
    await openMenu('Subject a:1');
    fireEvent.click(screen.getByRole('menuitem', { name: /^Done/ }));
    await waitFor(() => expect(mocked.done).toHaveBeenCalledWith('a:1'));
    const toast = await screen.findByRole('status');
    expect(toast).toHaveTextContent('Marked done');
    expect(within(toast).getByRole('button', { name: /Undo/ })).toBeInTheDocument();
    expect(within(rowOf('Subject a:1')).getByText('Archived')).toBeInTheDocument();
  });

  it('a thread outside the inbox offers Move to inbox', async () => {
    mocked.restore.mockResolvedValue({ undoId: 'u2', thread: thread('a:2', { inInbox: true }) });
    renderSearch();
    await openMenu('Subject a:2');
    expect(screen.queryByRole('menuitem', { name: /^Done/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: /^Move to inbox/ }));
    await waitFor(() => expect(mocked.restore).toHaveBeenCalledWith('a:2'));
    expect(await screen.findByText('Moved to inbox')).toBeInTheDocument();
    await waitFor(() => expect(within(rowOf('Subject a:2')).getByText('Dev')).toBeInTheDocument());
  });

  it('a failed action shows an error', async () => {
    mocked.read.mockRejectedValue(new Error('offline'));
    renderSearch();
    await openMenu('Subject a:1');
    fireEvent.click(screen.getByRole('menuitem', { name: /^Mark as unread/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't mark unread: offline");
  });

  it('teaches the sender and picks a group, fetching the groups it needs', async () => {
    mocked.groups.mockResolvedValue([{ id: 'dev', name: 'Dev', position: 0, color: '#000000', notify: false, kind: 'builtin', inboxCount: 0, unreadCount: 0 }]);
    mocked.teach.mockResolvedValue({ undoId: 'u3', thread: thread('a:1') });
    renderSearch();
    await openMenu('Subject a:1');
    fireEvent.click(screen.getByRole('menuitem', { name: /^Always group/ }));
    const dialog = await screen.findByRole('dialog', { name: /group/i });
    fireEvent.click(await within(dialog).findByRole('button', { name: /Dev/ }));
    await waitFor(() => expect(mocked.teach).toHaveBeenCalledWith({ threadId: 'a:1', action: 'always_group', scope: 'sender', groupId: 'dev' }));
    expect(await screen.findByText('Sender a:1 → Dev')).toBeInTheDocument();
  });

  it('Snooze… picks a time and snoozes', async () => {
    mocked.snooze.mockResolvedValue({ undoId: 'u4', thread: thread('a:1', { inInbox: false }) });
    renderSearch();
    await openMenu('Subject a:1');
    fireEvent.click(screen.getByRole('menuitem', { name: /^Snooze/ }));
    const dialog = await screen.findByRole('dialog', { name: /snooze/i });
    fireEvent.click(within(dialog).getByRole('button', { name: /Tomorrow morning/ }));
    await waitFor(() => expect(mocked.snooze).toHaveBeenCalledWith('a:1', expect.any(Number)));
  });

  it('Reply goes to the thread and asks for its composer', async () => {
    renderSearch();
    await openMenu('Subject a:1');
    fireEvent.click(screen.getByRole('menuitem', { name: /^Reply$/ }));
    expect(await screen.findByText(/thread page a:1 ids=a:1,a:2 compose=reply/)).toBeInTheDocument();
  });

  it('the ContextMenu key opens it on the selected row', async () => {
    renderSearch();
    await screen.findByText('Subject a:1');
    press('j');
    press('ContextMenu');
    expect(screen.getByRole('menuitem', { name: /^Open(?! in new)/ })).toHaveFocus();
    expect(screen.getByRole('menuitem', { name: /^Move to inbox/ })).toBeInTheDocument();
  });
});
