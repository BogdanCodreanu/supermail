import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountDTO, FilterDTO, GroupReasonDTO, ThreadSummaryDTO } from '@supermail/shared';
import { api } from '../src/api/client';
import { Skipped } from '../src/views/Skipped';

vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  return {
    ...actual,
    api: {
      accounts: vi.fn(),
      skipped: vi.fn(),
      restore: vi.fn(),
      undo: vi.fn(),
      filters: vi.fn(),
      snooze: vi.fn(),
      read: vi.fn(),
      teach: vi.fn(),
      groups: vi.fn(),
    },
  };
});

const mocked = vi.mocked(api);

const reason: GroupReasonDTO = { source: 'default', text: 'Unsorted', at: null };
function thread(id: string, subject: string, over: Partial<ThreadSummaryDTO> = {}): ThreadSummaryDTO {
  return {
    id, accountId: 'acc1', subject, snippet: 'snippet', fromName: 'Sender', fromEmail: 'x@shop.com',
    lastMessageAt: Date.now() - 3 * 86_400_000, unread: false, inInbox: false, groupId: 'unsorted', groupName: 'Unsorted',
    reason, snoozedUntil: null, hasAttachments: false, suggestRule: false, ...over,
  };
}

const accounts: AccountDTO[] = [{ id: 'acc1', email: 'me@gmail.com', color: '#2563eb', status: 'ok' }];
const filters: FilterDTO[] = [
  {
    accountId: 'acc1',
    filterId: 'f1',
    criteria: 'from:news@shop.com',
    hides: ['skip_inbox', 'mark_read'],
    gmailSettingsUrl: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#settings/filters',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocked.accounts.mockResolvedValue(accounts);
  mocked.skipped.mockResolvedValue({ threads: [thread('acc1:1', 'Order shipped'), thread('acc1:2', 'Your receipt')], nextCursor: null });
  mocked.restore.mockImplementation(async (id) => ({ undoId: `u-${id}`, thread: thread(id, 'restored', { inInbox: true }) }));
  mocked.undo.mockResolvedValue({ undoId: 'u-undo', thread: null });
  mocked.filters.mockResolvedValue(filters);
});

function ThreadPage() {
  return <div>thread page {useParams().id}</div>;
}

function renderSkipped() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/', '/skipped']} initialIndex={1}>
        <Routes>
          <Route path="/" element={<div>inbox page</div>} />
          <Route path="/skipped" element={<Skipped />} />
          <Route path="/t/:id" element={<ThreadPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function press(key: string) {
  act(() => {
    fireEvent.keyDown(document.body, { key });
  });
}

describe('Skipped', () => {
  it('lists skipped threads', async () => {
    renderSkipped();
    expect(await screen.findByText('Order shipped')).toBeInTheDocument();
    expect(screen.getByText('Your receipt')).toBeInTheDocument();
  });

  it('j then i restores the second thread to the inbox and removes its row', async () => {
    renderSkipped();
    await screen.findByText('Order shipped');
    press('j');
    press('i');
    await waitFor(() => expect(mocked.restore).toHaveBeenCalledWith('acc1:2'));
    await waitFor(() => expect(screen.queryByText('Your receipt')).not.toBeInTheDocument());
    expect(screen.getByText('Order shipped')).toBeInTheDocument();
    expect(mocked.restore).toHaveBeenCalledTimes(1);
  });

  it('the Restore button restores that row, and Undo calls api.undo with the returned undoId', async () => {
    renderSkipped();
    const row = (await screen.findByText('Order shipped')).closest('[role="option"]') as HTMLElement;
    // the hover button sits beside the row link (mouse only; `i` is the keyboard way)
    fireEvent.click(within(row.parentElement!).getByRole('button', { name: 'Restore to inbox', hidden: true }));
    await waitFor(() => expect(screen.queryByText('Order shipped')).not.toBeInTheDocument());
    expect(mocked.restore).toHaveBeenCalledWith('acc1:1');
    const toast = await screen.findByRole('status');
    expect(toast).toHaveTextContent('Restored "Order shipped" to the inbox');
    fireEvent.click(within(toast).getByRole('button', { name: /^undo/i }));
    await waitFor(() => expect(mocked.undo).toHaveBeenCalledWith('u-acc1:1'));
  });

  it('z undoes the last restore, like the inbox', async () => {
    renderSkipped();
    await screen.findByText('Order shipped');
    press('i');
    await screen.findByRole('status');
    press('z');
    await waitFor(() => expect(mocked.undo).toHaveBeenCalledWith('u-acc1:1'));
  });

  it('one click on a row opens the thread (rows are links)', async () => {
    renderSkipped();
    const row = (await screen.findByText('Your receipt')).closest('[role="option"]') as HTMLElement;
    expect(row).toHaveAttribute('href', '/t/acc1%3A2');
    fireEvent.click(row);
    expect(await screen.findByText('thread page acc1:2')).toBeInTheDocument();
  });

  it('selects the first row in a listbox and shows the i hint as a key cap', async () => {
    renderSkipped();
    const row = (await screen.findByText('Order shipped')).closest('[role="option"]') as HTMLElement;
    expect(row).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('listbox', { name: 'Skipped threads' })).toHaveAttribute('aria-activedescendant', row.id);
    expect(screen.getByText(/to put it back in the inbox/).querySelector('kbd')).toHaveTextContent('I');
  });

  it('Escape goes back', async () => {
    renderSkipped();
    await screen.findByText('Order shipped');
    press('Escape');
    expect(await screen.findByText('inbox page')).toBeInTheDocument();
  });

  it('puts the row back if the restore fails', async () => {
    mocked.restore.mockRejectedValueOnce(new Error('boom'));
    renderSkipped();
    await screen.findByText('Order shipped');
    press('i');
    await waitFor(() => expect(mocked.restore).toHaveBeenCalledWith('acc1:1'));
    expect(await screen.findByText('Order shipped')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't restore/i);
  });

  it('Enter opens the selected thread', async () => {
    renderSkipped();
    await screen.findByText('Order shipped');
    press('j');
    press('Enter');
    expect(await screen.findByText('thread page acc1:2')).toBeInTheDocument();
  });

  it('lists the restore shortcut in the panel', async () => {
    renderSkipped();
    const panel = screen.getByRole('complementary', { name: 'Keyboard shortcuts' });
    expect(within(panel).getByText('Restore to inbox')).toBeInTheDocument();
  });

  it('shows an empty state when nothing skipped the inbox', async () => {
    mocked.skipped.mockResolvedValue({ threads: [], nextCursor: null });
    renderSkipped();
    expect(await screen.findByText(/nothing skipped your inbox/i)).toBeInTheDocument();
  });
});

describe('Skipped — filters that hide mail', () => {
  it('renders a skip_inbox badge and an Open in Gmail link to the filter settings', async () => {
    renderSkipped();
    const table = await screen.findByRole('table', { name: 'Filters that hide mail' });
    const row = (await within(table).findByText('from:news@shop.com')).closest('tr') as HTMLElement;
    const badge = row.querySelector('[data-hides="skip_inbox"]');
    expect(badge).toHaveTextContent('Skips inbox');
    expect(row.querySelector('[data-hides="mark_read"]')).toHaveTextContent('Marks read');
    expect(within(row).getByText('me@gmail.com')).toBeInTheDocument();
    const link = within(row).getByRole('link', { name: 'Open in Gmail' });
    expect(link.getAttribute('href')).toContain('#settings/filters');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('says so when no filter hides mail', async () => {
    mocked.filters.mockResolvedValue([]);
    renderSkipped();
    expect(await screen.findByText(/no gmail filters hide mail/i)).toBeInTheDocument();
  });
});

describe('Skipped context menu', () => {
  const rowOf = (subject: string) => screen.getByText(subject).closest('[role="option"]') as HTMLElement;
  const openMenu = async (subject: string) => {
    await screen.findByText(subject);
    fireEvent.contextMenu(rowOf(subject), { clientX: 10, clientY: 10 });
    return screen.getByRole('menu', { name: /actions/i });
  };

  it('right-click opens the menu and selects the row; Escape closes the menu, not the page', async () => {
    renderSkipped();
    const menu = await openMenu('Your receipt');
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(13);
    expect(rowOf('Your receipt')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Skipped your inbox' })).toBeInTheDocument();
  });

  it('Move to inbox restores the row, with the i hint, and z undoes it', async () => {
    renderSkipped();
    await openMenu('Order shipped');
    const item = screen.getByRole('menuitem', { name: /^Move to inbox/ });
    expect(within(item).getByText('I')).toBeInTheDocument();
    fireEvent.click(item);
    await waitFor(() => expect(mocked.restore).toHaveBeenCalledWith('acc1:1'));
    expect(await screen.findByRole('status')).toHaveTextContent('Restored "Order shipped" to the inbox');
    press('z');
    await waitFor(() => expect(mocked.undo).toHaveBeenCalledWith('u-acc1:1'));
  });

  it('other actions use the same toast, so z undoes them too', async () => {
    mocked.read.mockResolvedValue({ undoId: 'u-read', thread: thread('acc1:1', 'Order shipped', { unread: true }) });
    renderSkipped();
    await openMenu('Order shipped');
    fireEvent.click(screen.getByRole('menuitem', { name: /^Mark as unread/ }));
    expect(await screen.findByRole('status')).toHaveTextContent('Marked unread');
    press('z');
    await waitFor(() => expect(mocked.undo).toHaveBeenCalledWith('u-read'));
  });

  it('a snoozed row leaves the list', async () => {
    mocked.snooze.mockResolvedValue({ undoId: 'u-sn', thread: thread('acc1:1', 'Order shipped', { snoozedUntil: 9 }) });
    renderSkipped();
    await openMenu('Order shipped');
    fireEvent.click(screen.getByRole('menuitem', { name: /^Snooze/ }));
    const dialog = await screen.findByRole('dialog', { name: /snooze/i });
    mocked.skipped.mockResolvedValue({ threads: [thread('acc1:2', 'Your receipt')], nextCursor: null });
    fireEvent.click(within(dialog).getByRole('button', { name: /Tomorrow morning/ }));
    await waitFor(() => expect(screen.queryByText('Order shipped')).not.toBeInTheDocument());
  });
});
