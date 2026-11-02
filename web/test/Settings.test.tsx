import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { act } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { AccountDTO, GmailLabelDTO, GroupDTO, StorageUsageDTO, TeachingDTO } from '@supermail/shared';
import { api, qk } from '../src/api/client';
import { Login } from '../src/views/Login';
import { Settings } from '../src/views/Settings';
import { stubPhone } from './phoneEnv';

vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  return {
    ...actual,
    api: {
      accounts: vi.fn(),
      groups: vi.fn(),
      storage: vi.fn(),
      labels: vi.fn(),
      removeAccount: vi.fn(),
      createGroup: vi.fn(),
      patchGroup: vi.fn(),
      deleteGroup: vi.fn(),
      logout: vi.fn(),
      teaching: vi.fn(),
      deleteTeaching: vi.fn(),
    },
  };
});

const mocked = vi.mocked(api);

const accounts: AccountDTO[] = [
  { id: 'acc1', email: 'me@gmail.com', color: '#2563eb', status: 'ok' },
  { id: 'acc2', email: 'work@example.org', color: '#16a34a', status: 'reconnect_needed' },
];

function group(id: string, name: string, position: number, over: Partial<GroupDTO> = {}): GroupDTO {
  return { id, name, position, color: '#64748b', notify: true, kind: 'builtin', inboxCount: 0, unreadCount: 0, ...over };
}

const groups: GroupDTO[] = [
  group('dev', 'Dev', 2),
  group('important', 'Important', 0),
  group('money_security', 'Money & Security', 1),
  group('g-legal', 'Legal', 3, { kind: 'custom' }),
];

const storage: StorageUsageDTO = {
  bodyCacheMB: 12.4,
  indexMB: 3,
  logsMB: 0.5,
  totalMB: 16,
  diskFreeGB: 80,
  limits: { bodyCacheMB: 1024, indexMB: 1024, logsMB: 50, totalMB: 3072, minFreeDiskGB: 20 },
  degraded: false,
};

const labels: GmailLabelDTO[] = [
  { name: 'Legal - Example Studio SRL', accountIds: ['acc1'] },
  { name: 'Receipts', accountIds: ['acc1', 'acc2'] },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocked.accounts.mockResolvedValue(accounts);
  mocked.groups.mockResolvedValue(groups);
  mocked.storage.mockResolvedValue(storage);
  mocked.labels.mockResolvedValue(labels);
  mocked.removeAccount.mockResolvedValue(undefined);
  mocked.deleteGroup.mockResolvedValue(undefined);
  mocked.createGroup.mockImplementation(async (r) => group('g-new', r.name, 9, { kind: r.existingLabelName ? 'existing_label' : 'custom' }));
  mocked.patchGroup.mockImplementation(async (id, p) => ({ ...groups.find((g) => g.id === id)!, ...p }));
  mocked.teaching.mockResolvedValue([]);
  mocked.deleteTeaching.mockResolvedValue(undefined);
});

function renderSettings(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/', '/settings']} initialIndex={1}>
        <Routes>
          <Route path="/" element={<div>inbox page</div>} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const section = (name: string) => screen.getByRole('region', { name });

describe('Login', () => {
  it('has one Sign in with Google button pointing to /auth/login', () => {
    render(<Login />);
    expect(screen.getByRole('link', { name: /sign in with google/i })).toHaveAttribute('href', '/auth/login');
  });
});

describe('Settings — accounts', () => {
  it('shows each account with its status, and Reconnect (to /auth/connect) only when reconnect_needed', async () => {
    renderSettings();
    const accountsSection = section('Accounts');
    const work = (await within(accountsSection).findByText('work@example.org')).closest('li') as HTMLElement;
    expect(within(work).getByText(/reconnect needed/i)).toBeInTheDocument();
    expect(within(work).getByRole('link', { name: 'Reconnect' })).toHaveAttribute('href', '/auth/connect');
    const me = within(accountsSection).getByText('me@gmail.com').closest('li') as HTMLElement;
    expect(within(me).queryByRole('link', { name: 'Reconnect' })).not.toBeInTheDocument();
    expect(within(accountsSection).getByRole('link', { name: 'Connect Gmail' })).toHaveAttribute('href', '/auth/connect');
  });

  it('removes an account only after confirming', async () => {
    renderSettings();
    const me = (await screen.findByText('me@gmail.com')).closest('li') as HTMLElement;
    fireEvent.click(within(me).getByRole('button', { name: 'Remove' }));
    expect(mocked.removeAccount).not.toHaveBeenCalled();
    fireEvent.click(within(me).getByRole('button', { name: 'Cancel' }));
    expect(within(me).queryByRole('button', { name: 'Confirm remove' })).not.toBeInTheDocument();

    fireEvent.click(within(me).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(me).getByRole('button', { name: 'Confirm remove' }));
    await waitFor(() => expect(mocked.removeAccount).toHaveBeenCalledWith('acc1'));
  });
});

describe('Settings — keys', () => {
  it('Ctrl+K opens the command palette, as the shortcut panel promises', () => {
    renderSettings();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
  });

  it('uses the settings panel context and Escape goes back', async () => {
    renderSettings();
    const panel = screen.getByRole('complementary', { name: 'Keyboard shortcuts' });
    expect(within(panel).getByText('Back')).toBeInTheDocument();
    expect(within(panel).queryByText('Done')).not.toBeInTheDocument();
    expect(within(panel).queryByText('Next / previous')).not.toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(document.body, { key: 'Escape' });
    });
    expect(await screen.findByText('inbox page')).toBeInTheDocument();
  });
});

describe('Settings — storage', () => {
  it('shows each value as used / limit, with 1024 MB for the body cache limit', async () => {
    renderSettings();
    const cache = (await within(section('Storage')).findByText('Body cache')).closest('li') as HTMLElement;
    expect(cache).toHaveTextContent('12.4 MB / 1024 MB');
    const total = within(section('Storage')).getByText(/everything in \/data/i).closest('li') as HTMLElement;
    expect(total).toHaveTextContent('16 MB / 3072 MB');
    expect(within(section('Storage')).getByText(/80 GB free/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a degraded banner when a hard limit is reached', async () => {
    mocked.storage.mockResolvedValue({ ...storage, degraded: true });
    renderSettings();
    expect(await screen.findByRole('alert')).toHaveTextContent(/caching and history indexing are paused/i);
  });
});

describe('Settings — groups', () => {
  async function groupRow(name: string) {
    const input = await within(section('Groups')).findByRole('textbox', { name: `Name of ${name}` });
    return input.closest('li') as HTMLElement;
  }

  it('lists groups by position', async () => {
    renderSettings();
    await groupRow('Dev');
    const names = within(section('Groups'))
      .getAllByRole('textbox', { name: /^Name of / })
      .map((i) => (i as HTMLInputElement).value);
    expect(names).toEqual(['Important', 'Money & Security', 'Dev', 'Legal']);
  });

  it('renames on Enter', async () => {
    renderSettings();
    const input = within(await groupRow('Dev')).getByRole('textbox', { name: 'Name of Dev' });
    fireEvent.change(input, { target: { value: 'Code' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(mocked.patchGroup).toHaveBeenCalledWith('dev', { name: 'Code' }));
  });

  it('reorders by swapping positions with the neighbour', async () => {
    renderSettings();
    fireEvent.click(within(await groupRow('Dev')).getByRole('button', { name: 'Move Dev up' }));
    await waitFor(() => expect(mocked.patchGroup).toHaveBeenCalledTimes(2));
    expect(mocked.patchGroup).toHaveBeenCalledWith('dev', { position: 1 });
    expect(mocked.patchGroup).toHaveBeenCalledWith('money_security', { position: 2 });
    expect(within(await groupRow('Important')).getByRole('button', { name: 'Move Important up' })).toBeDisabled();
  });

  it('saves a color once it is picked, not on every step of a drag', async () => {
    renderSettings();
    const color = within(await groupRow('Dev')).getByLabelText('Color of Dev');
    for (const v of ['#110000', '#220000', '#330000']) fireEvent.input(color, { target: { value: v } });
    expect(color).toHaveValue('#330000');
    expect(mocked.patchGroup).not.toHaveBeenCalled();
    fireEvent.blur(color);
    await waitFor(() => expect(mocked.patchGroup).toHaveBeenCalledWith('dev', { color: '#330000' }));
    expect(mocked.patchGroup).toHaveBeenCalledTimes(1);
  });

  it('reorder buttons are chevron icons: 24 px on a computer, 44 px on the phone', async () => {
    renderSettings();
    const up = within(await groupRow('Dev')).getByRole('button', { name: 'Move Dev up' });
    expect(up).toHaveClass('h-11', 'w-11', 'md:h-6', 'md:w-6');
    expect(up.querySelector('svg')).not.toBeNull();
    expect(up).not.toHaveTextContent('▲');
  });

  it('a failed change is announced as an alert', async () => {
    mocked.patchGroup.mockRejectedValueOnce(new Error('Gmail is down'));
    renderSettings();
    fireEvent.click(within(await groupRow('Dev')).getByRole('button', { name: 'Notify for Dev' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Gmail is down');
  });

  it('changes color and toggles the notify bell', async () => {
    renderSettings();
    const row = await groupRow('Dev');
    fireEvent.change(within(row).getByLabelText('Color of Dev'), { target: { value: '#ff0000' } });
    await waitFor(() => expect(mocked.patchGroup).toHaveBeenCalledWith('dev', { color: '#ff0000' }));
    const bell = within(row).getByRole('button', { name: 'Notify for Dev' });
    expect(bell).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(bell);
    await waitFor(() => expect(mocked.patchGroup).toHaveBeenCalledWith('dev', { notify: false }));
  });

  it('creates a custom group and deletes custom groups only (after confirming)', async () => {
    renderSettings();
    expect(within(await groupRow('Dev')).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    const legal = await groupRow('Legal');
    fireEvent.click(within(legal).getByRole('button', { name: 'Delete' }));
    expect(mocked.deleteGroup).not.toHaveBeenCalled();
    fireEvent.click(within(legal).getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(mocked.deleteGroup).toHaveBeenCalledWith('g-legal'));

    fireEvent.change(within(section('Groups')).getByRole('textbox', { name: 'New group name' }), { target: { value: 'Travel' } });
    fireEvent.click(within(section('Groups')).getByRole('button', { name: 'Add group' }));
    await waitFor(() => expect(mocked.createGroup).toHaveBeenCalledWith(expect.objectContaining({ name: 'Travel' })));
  });

  it('uses a Gmail label as a group, picked from api.labels()', async () => {
    renderSettings();
    const select = await within(section('Groups')).findByRole('combobox', { name: 'Gmail label' });
    await within(select).findByRole('option', { name: 'Receipts' });
    fireEvent.change(select, { target: { value: 'Receipts' } });
    fireEvent.click(within(section('Groups')).getByRole('button', { name: 'Use as group' }));
    await waitFor(() => expect(mocked.createGroup).toHaveBeenCalledWith({ name: 'Receipts', existingLabelName: 'Receipts' }));
  });
});

describe('Settings — rules', () => {
  const OCT_28 = new Date(2026, 9, 28, 12).getTime();

  function teaching(over: Partial<TeachingDTO>): TeachingDTO {
    return { id: 't1', kind: 'rule', matchType: 'domain', matchValue: 'alibaba.com', groupId: 'low_priority', groupName: 'Low priority', mark: null, createdAt: OCT_28, threadCount: 3, ...over };
  }

  const rules = () => section("What you've taught SuperMail");
  const rows = () => within(rules()).queryAllByRole('listitem').filter((li) => li.closest('ul'));
  const many = (n: number) => Array.from({ length: n }, (_, i) => teaching({ id: `t${i}`, matchValue: `sender${i}.com` }));

  it('sits between Groups and Storage', () => {
    renderSettings();
    expect(screen.getAllByRole('region').map((r) => within(r).getByRole('heading', { level: 2 }).textContent)).toEqual(['Notifications', 'Accounts', 'Groups', "What you've taught SuperMail", 'Storage']);
  });

  it.each<[Partial<TeachingDTO>, string]>([
    [{ kind: 'rule', matchType: 'domain', matchValue: 'alibaba.com' }, 'Always group alibaba.com to Low priority'],
    [{ kind: 'rule', matchType: 'sender', matchValue: 'newsletter@x.com' }, 'Always group newsletter@x.com to Low priority'],
    [{ kind: 'rule', matchType: 'list', matchValue: 'news.x.com' }, 'Always group the list news.x.com to Low priority'],
    [{ kind: 'mark', matchType: 'sender', matchValue: 'newsletter@x.com', groupId: null, groupName: null, mark: 'important' }, 'newsletter@x.com is Important'],
    [{ kind: 'mark', matchType: 'domain', matchValue: 'alibaba.com', groupId: null, groupName: null, mark: 'not_important' }, '*@alibaba.com is Not important'],
    [{ kind: 'mark', matchType: 'list', matchValue: 'news.x.com', groupId: null, groupName: null, mark: 'important' }, 'The list news.x.com is Important'],
  ])('reads in plain language: %j', async (over, text) => {
    mocked.teaching.mockResolvedValue([teaching(over)]);
    renderSettings();
    await within(rules()).findByRole('button', { name: `Remove: ${text}` });
    expect(rows()[0]).toHaveTextContent(text);
  });

  it('draws the rule arrow as an icon, not a text glyph', async () => {
    mocked.teaching.mockResolvedValue([teaching({})]);
    renderSettings();
    await within(rules()).findByRole('button', { name: /^Remove: / });
    expect(rows()[0]!.querySelector('.lucide-arrow-right')).not.toBeNull();
    expect(rows()[0]).not.toHaveTextContent('→');
  });

  it('shows the date and how many emails it holds, singular for one', async () => {
    mocked.teaching.mockResolvedValue([teaching({ id: 'a', threadCount: 3 }), teaching({ id: 'b', matchValue: 'b.com', threadCount: 1 })]);
    renderSettings();
    await within(rules()).findByText(/alibaba\.com/);
    const [first, second] = rows();
    expect(first).toHaveTextContent(new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(OCT_28));
    expect(first).toHaveTextContent('3 emails in inbox');
    expect(second).toHaveTextContent('1 email in inbox');
  });

  it('delete calls the api with the kind and id, removes the row and refreshes the mail lists', async () => {
    mocked.teaching.mockResolvedValueOnce([teaching({ kind: 'mark', id: 'm1', matchValue: 'alibaba.com', groupId: null, groupName: null, mark: 'not_important' })]).mockResolvedValue([]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    renderSettings(qc);
    fireEvent.click(await within(rules()).findByRole('button', { name: 'Remove: *@alibaba.com is Not important' }));
    await waitFor(() => expect(mocked.deleteTeaching).toHaveBeenCalledWith('mark', 'm1'));
    await waitFor(() => expect(within(rules()).queryByText('*@alibaba.com is Not important')).not.toBeInTheDocument());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['groups'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['threads'] });
  });

  it('confirms honestly: emails moved back only when there were some, and no Undo', async () => {
    mocked.teaching.mockResolvedValue([teaching({ id: 'a', threadCount: 2 }), teaching({ id: 'b', matchValue: 'b.com', threadCount: 0 })]);
    renderSettings();
    fireEvent.click(await within(rules()).findByRole('button', { name: /^Remove: .*alibaba\.com/ }));
    expect(await screen.findByRole('status')).toHaveTextContent('Removed. Emails moved back.');
    expect(screen.queryByRole('button', { name: /undo/i })).not.toBeInTheDocument();
    fireEvent.click(await within(rules()).findByRole('button', { name: /^Remove: .*b\.com/ }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/^Removed\.(?! Emails)/));
  });

  it('keeps the row and announces the failure when removing fails', async () => {
    mocked.teaching.mockResolvedValue([teaching({})]);
    mocked.deleteTeaching.mockRejectedValueOnce(new Error('Nothing to remove'));
    renderSettings();
    fireEvent.click(await within(rules()).findByRole('button', { name: /^Remove: / }));
    expect(await within(rules()).findByRole('alert')).toHaveTextContent('Nothing to remove');
    expect(rows()).toHaveLength(1);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('the empty state explains + - and L with key caps', async () => {
    renderSettings();
    const empty = (await within(rules()).findByText(/on an email to teach/i)) as HTMLElement;
    expect([...empty.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['+', '-', 'L']);
    expect(within(rules()).queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('shows a filter only above 10 rows', async () => {
    mocked.teaching.mockResolvedValue(many(10));
    const { unmount } = renderSettings();
    await within(rules()).findByText(/sender0\.com/);
    expect(within(rules()).queryByRole('textbox', { name: 'Filter rules' })).not.toBeInTheDocument();
    unmount();

    mocked.teaching.mockResolvedValue(many(11));
    renderSettings();
    expect(await within(rules()).findByRole('textbox', { name: 'Filter rules' })).toBeInTheDocument();
  });

  it('filters on the plain text, including the group name, and says when nothing matches', async () => {
    mocked.teaching.mockResolvedValue([...many(10), teaching({ id: 'z', matchValue: 'zebra.com', groupId: 'dev', groupName: 'Dev' })]);
    renderSettings();
    const filter = await within(rules()).findByRole('textbox', { name: 'Filter rules' });
    fireEvent.change(filter, { target: { value: 'ZEBRA' } });
    expect(rows()).toHaveLength(1);
    fireEvent.change(filter, { target: { value: 'to dev' } });
    expect(rows()).toHaveLength(1);
    fireEvent.change(filter, { target: { value: 'nothing like this' } });
    expect(rows()).toHaveLength(0);
    expect(within(rules()).getByText(/no rules match/i)).toHaveTextContent('nothing like this');
  });

  it('shows every row again once removals take it back to 10, when the filter box is gone', async () => {
    const all = many(11);
    mocked.teaching.mockResolvedValueOnce(all).mockResolvedValue(all.slice(1));
    renderSettings();
    fireEvent.change(await within(rules()).findByRole('textbox', { name: 'Filter rules' }), { target: { value: 'sender0.com' } });
    expect(rows()).toHaveLength(1);
    fireEvent.click(within(rules()).getByRole('button', { name: /^Remove: / }));
    await waitFor(() => expect(within(rules()).queryByRole('textbox', { name: 'Filter rules' })).not.toBeInTheDocument());
    expect(rows()).toHaveLength(10);
  });

  it('Escape in the filter clears it instead of leaving Settings', async () => {
    mocked.teaching.mockResolvedValue(many(11));
    renderSettings();
    const filter = await within(rules()).findByRole('textbox', { name: 'Filter rules' });
    fireEvent.change(filter, { target: { value: 'sender0.com' } });
    fireEvent.keyDown(filter, { key: 'Escape' });
    expect(filter).toHaveValue('');
    expect(rows()).toHaveLength(11);
    expect(screen.queryByText('inbox page')).not.toBeInTheDocument();
  });

  it('fetches again on every visit, so a rule just taught is there even with a fresh cache', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    qc.setQueryData(qk.teaching(), []);
    mocked.teaching.mockResolvedValue([teaching({})]);
    renderSettings(qc);
    expect(await within(rules()).findByRole('button', { name: 'Remove: Always group alibaba.com to Low priority' })).toBeInTheDocument();
  });
});

describe('Settings on the phone', () => {
  beforeEach(stubPhone);

  async function groupRow(name: string) {
    const input = await within(section('Groups')).findByRole('textbox', { name: `Name of ${name}` });
    return input.closest('li') as HTMLElement;
  }

  it('shows each section as a card, in one column', async () => {
    renderSettings();
    expect(section('Accounts')).toHaveClass('rounded-lg', 'bg-panel', 'border', 'md:bg-transparent', 'md:border-b');
    expect(section('Accounts').parentElement).toHaveClass('flex-col', 'gap-3', 'md:block');
  });

  it('reorders groups with 44px up and down buttons', async () => {
    mocked.patchGroup.mockImplementation(async (id, p) => ({ ...groups.find((g) => g.id === id)!, ...p }));
    renderSettings();
    const row = await groupRow('Dev');
    const down = within(row).getByRole('button', { name: 'Move Dev down' });
    expect(down).toHaveClass('h-11', 'w-11');
    fireEvent.click(down);
    await waitFor(() => expect(mocked.patchGroup).toHaveBeenCalled());
  });

  it('wraps a group onto two lines, its name at 16px', async () => {
    renderSettings();
    const row = await groupRow('Dev');
    expect(row).toHaveClass('flex-wrap', 'md:flex-nowrap');
    expect(within(row).getByRole('textbox', { name: 'Name of Dev' })).toHaveClass('text-[16px]', 'h-11');
    expect(within(row).getByRole('button', { name: 'Notify for Dev' })).toHaveClass('h-11', 'w-11');
  });

  it('every input is at least 16px, and the color swatches 44px', async () => {
    renderSettings();
    await groupRow('Dev');
    expect(screen.getByRole('textbox', { name: 'New group name' })).toHaveClass('text-[16px]');
    expect(screen.getByRole('combobox', { name: 'Gmail label' })).toHaveClass('text-[16px]');
    expect(screen.getByLabelText('New group color')).toHaveClass('h-11', 'w-11');
    expect(screen.getByLabelText('Color of Dev')).toHaveClass('h-11', 'w-11');
  });

  it('wraps the rules, and teaches by touch rather than by key when there are none', async () => {
    renderSettings();
    const rules = section("What you've taught SuperMail");
    expect(await within(rules).findByText(/Use More on an email/)).toBeInTheDocument();
    expect(rules.querySelector('kbd')).toBeNull();
  });

  it('offline, a section that never loaded says so instead of "Loading…"', async () => {
    onlineManager.setOnline(false);
    onTestFinished(() => onlineManager.setOnline(true));
    renderSettings();
    expect(await within(section('Storage')).findByRole('alert')).toHaveTextContent("You're offline, so storage usage couldn't load.");
    expect(within(section('Groups')).getByRole('alert')).toHaveTextContent("You're offline, so your groups couldn't load.");
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('a section that failed to load offers Retry', async () => {
    mocked.storage.mockRejectedValueOnce(new Error('Failed to fetch'));
    renderSettings();
    const storageSection = section('Storage');
    await within(storageSection).findByRole('alert');
    fireEvent.click(within(storageSection).getByRole('button', { name: 'Retry' }));
    await within(storageSection).findByText('Body cache');
  });
});
