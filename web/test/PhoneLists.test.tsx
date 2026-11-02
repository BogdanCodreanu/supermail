import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountDTO, ThreadSummaryDTO } from '@supermail/shared';
import { liftAfterLongPress, pressDown, stubPhone, stubRowWidth, swipe } from './phone';

const api = vi.hoisted(() => ({
  accounts: vi.fn(), search: vi.fn(), skipped: vi.fn(), spam: vi.fn(), filters: vi.fn(), restore: vi.fn(), notSpam: vi.fn(), done: vi.fn(), snooze: vi.fn(), undo: vi.fn(), groups: vi.fn(), read: vi.fn(), reportSpam: vi.fn(), teachPreview: vi.fn(),
}));
vi.mock('../src/api/client', async (importOriginal) => ({ ...(await importOriginal<object>()), api }));

const accounts: AccountDTO[] = [{ id: 'a', email: 'me@a.com', color: '#2563eb', status: 'ok' }];
const thread = (n: number, over: Partial<ThreadSummaryDTO> = {}): ThreadSummaryDTO => ({
  id: `a:${n}`, accountId: 'a', subject: `Subject ${n}`, snippet: `snippet ${n}`, fromName: `Sender ${n}`, fromEmail: `s${n}@example.com`, lastMessageAt: 100_000 - n, unread: false, inInbox: false,
  groupId: 'important', groupName: 'Important', reason: { source: 'mark', text: `Reason ${n}`, at: null }, snoozedUntil: null, hasAttachments: false, suggestRule: false, ...over,
});
const page = (threads: ThreadSummaryDTO[]) => ({ threads, nextCursor: null });

beforeEach(() => {
  stubPhone();
  stubRowWidth();
  vi.resetModules();
  for (const fn of Object.values(api)) fn.mockReset();
  api.accounts.mockResolvedValue(accounts);
  api.filters.mockResolvedValue([]);
  api.groups.mockResolvedValue([]);
  api.search.mockResolvedValue(page([thread(0, { inInbox: true }), thread(1)]));
  api.skipped.mockResolvedValue(page([thread(0), thread(1)]));
  api.spam.mockResolvedValue(page([thread(0), thread(1)]));
  api.restore.mockImplementation(async (id: string) => ({ undoId: 'u', thread: { ...thread(0, { id }), inInbox: true } }));
  api.notSpam.mockImplementation(async (id: string) => ({ undoId: 'u', thread: { ...thread(0, { id }), inInbox: true } }));
  api.done.mockImplementation(async (id: string) => ({ undoId: 'u', thread: { ...thread(0, { id }), inInbox: false, doneAt: 5 } }));
});
afterEach(() => vi.useRealTimers());

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search}</output>;
}

async function show(name: 'Search' | 'Skipped' | 'Spam', path: string) {
  const views = { Search: () => import('../src/views/Search'), Skipped: () => import('../src/views/Skipped'), Spam: () => import('../src/views/Spam') };
  const View = ((await views[name]()) as unknown as Record<string, () => JSX.Element>)[name]!;
  const { AppToasts } = await import('../src/state/toasts');
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/', path]} initialIndex={1}>
        <View />
        <Where />
        <AppToasts />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const rows = () => screen.findAllByTestId('thread-row');
const rowOf = (n: number) => document.querySelector(`[data-thread-id="a:${n}"]`)!;
const reveal = (row: Element) => row.parentElement!.querySelector('[data-testid="swipe-reveal"]');
const longPress = async (n: number) => {
  vi.useFakeTimers();
  pressDown(rowOf(n));
  await act(async () => void vi.advanceTimersByTime(450));
  vi.useRealTimers();
  liftAfterLongPress(rowOf(n));
};

describe('Search on the phone', () => {
  it('turns the app bar into a full-width field of at least 16px, with Back', async () => {
    await show('Search', '/search');
    const bar = screen.getByRole('banner');
    const field = within(bar).getByRole('searchbox', { name: 'Search mail' });
    expect(field.className).toContain('text-[16px]');
    expect(within(bar).getByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(screen.getAllByRole('searchbox', { name: 'Search mail' })).toHaveLength(1);
  });

  it('draws no focus box inside the bar, where it is the only thing to type in', async () => {
    await show('Search', '/search');
    expect(screen.getByRole('searchbox', { name: 'Search mail' }).className).toContain('focus-visible:outline-none');
  });

  it('has no key hints', async () => {
    await show('Search', '/search?q=x');
    await rows();
    expect(document.querySelector('kbd')).toBeNull();
  });

  it('runs the search from the keyboard', async () => {
    await show('Search', '/search');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search mail' }), { target: { value: 'hello' } });
    fireEvent.submit(screen.getByRole('search'));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/search?q=hello'));
  });

  it('clears the field with a named 44px button', async () => {
    await show('Search', '/search?q=hello');
    await rows();
    const clear = screen.getByRole('button', { name: 'Clear search' });
    expect(clear.className).toContain('h-11');
    fireEvent.click(clear);
    expect(screen.getByRole('searchbox', { name: 'Search mail' })).toHaveValue('');
  });

  it('uses the phone rows, with Done on the right and Snooze on the left', async () => {
    await show('Search', '/search?q=x');
    const [first] = await rows();
    expect(first!.className).toContain('h-[72px]');
    const r = reveal(first!)!;
    expect(within(r as HTMLElement).getByTestId('reveal-right')).toHaveTextContent('Done');
    expect(within(r as HTMLElement).getByTestId('reveal-left')).toHaveTextContent('Snooze');
  });

  it('moves an archived result to the inbox on a right swipe', async () => {
    await show('Search', '/search?q=x');
    await rows();
    expect(within(reveal(rowOf(1))! as HTMLElement).getByTestId('reveal-right')).toHaveTextContent('Inbox');
    swipe(rowOf(1), 50, 250);
    await waitFor(() => expect(api.restore).toHaveBeenCalledWith('a:1'));
  });

  it('offers the row sheet on a long-press', async () => {
    await show('Search', '/search?q=x');
    await rows();
    await longPress(0);
    expect(screen.getByRole('dialog', { name: 'Actions for Subject 0' })).toBeInTheDocument();
  });

  it('shows Retry when the search fails', async () => {
    api.search.mockRejectedValueOnce(new Error('offline'));
    await show('Search', '/search?q=x');
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await rows();
  });
});

describe('Skipped on the phone', () => {
  it('uses the phone rows and the app bar with Back and a title', async () => {
    await show('Skipped', '/skipped');
    const [first] = await rows();
    expect(first!.className).toContain('h-[72px]');
    expect(within(screen.getByRole('banner')).getByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(within(screen.getByRole('banner')).getByText('Skipped')).toBeInTheDocument();
  });

  it('restores on a right swipe, and has no left swipe', async () => {
    await show('Skipped', '/skipped');
    await rows();
    const r = reveal(rowOf(0))! as HTMLElement;
    expect(within(r).getByTestId('reveal-right')).toHaveTextContent('Restore');
    expect(within(r).queryByTestId('reveal-left')).not.toBeInTheDocument();
    swipe(rowOf(0), 50, 250);
    await waitFor(() => expect(api.restore).toHaveBeenCalledWith('a:0'));
  });

  it('explains itself by touch, with no key hint', async () => {
    await show('Skipped', '/skipped');
    await rows();
    expect(screen.getByText(/Swipe right to put it back/)).toBeInTheDocument();
    expect(document.querySelector('kbd')).toBeNull();
  });

  it('offers the row sheet on a long-press, with Move to inbox', async () => {
    await show('Skipped', '/skipped');
    await rows();
    await longPress(0);
    expect(within(screen.getByRole('dialog', { name: 'Actions for Subject 0' })).getByRole('button', { name: 'Move to inbox' })).toBeInTheDocument();
  });

  it('gives the filter links a 44px target on a phone', async () => {
    api.filters.mockResolvedValue([{ accountId: 'a', filterId: 'f', criteria: 'from:x', hides: ['skip_inbox'], gmailSettingsUrl: 'https://mail.google.com/' }]);
    await show('Skipped', '/skipped');
    const link = await screen.findByRole('link', { name: /Open in Gmail/ });
    expect(link.className).toContain('h-11');
    expect(link.className).toContain('md:h-6');
    expect(link.className).toContain('touch-manipulation');
  });

  it('stacks the filters instead of scrolling a table sideways, and keeps the table on a computer', async () => {
    api.filters.mockResolvedValue([{ accountId: 'a', filterId: 'f', criteria: 'from:(a-very-long-address@example.com)', hides: ['skip_inbox'], gmailSettingsUrl: 'https://mail.google.com/' }]);
    await show('Skipped', '/skipped');
    const table = await screen.findByRole('table');
    expect(table.className).toContain('block');
    expect(table.className).toContain('md:table');
    expect(table.querySelector('thead')!.className).toContain('hidden');
    expect(table.querySelector('thead')!.className).toContain('md:table-header-group');
    const cells = [...table.querySelectorAll('tbody td')];
    for (const cell of cells) {
      expect(cell.className).toContain('block');
      expect(cell.className).toContain('md:table-cell');
    }
    expect(screen.getByText(/a-very-long-address/).className).toContain('break-all');
  });

  it('shows Retry when the list fails', async () => {
    api.skipped.mockRejectedValueOnce(new Error('offline'));
    await show('Skipped', '/skipped');
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await rows();
  });
});

describe('Spam on the phone', () => {
  it('uses the phone rows, linking to the safe reader', async () => {
    await show('Spam', '/spam');
    const [first] = await rows();
    expect(first!.className).toContain('h-[72px]');
    expect(first).toHaveAttribute('href', '/spam/a%3A0');
  });

  it('leaves the title to the app bar on a phone', async () => {
    await show('Spam', '/spam');
    await rows();
    expect(screen.getByRole('heading', { name: 'Spam', hidden: true }).className).toContain('hidden');
    expect(screen.getByRole('heading', { name: 'Spam', hidden: true }).className).toContain('md:block');
  });

  it('is Not spam on a right swipe, with no left swipe', async () => {
    await show('Spam', '/spam');
    await rows();
    const r = reveal(rowOf(0))! as HTMLElement;
    expect(within(r).getByTestId('reveal-right')).toHaveTextContent('Not spam');
    expect(within(r).queryByTestId('reveal-left')).not.toBeInTheDocument();
    swipe(rowOf(0), 50, 250);
    await waitFor(() => expect(api.notSpam).toHaveBeenCalledWith('a:0'));
  });

  it('offers only what spam can do on a long-press', async () => {
    await show('Spam', '/spam');
    await rows();
    await longPress(0);
    const sheet = screen.getByRole('dialog', { name: 'Actions for Subject 0' });
    expect(within(sheet).getAllByRole('button').map((b) => b.textContent)).toEqual(['Open', 'Not spam']);
  });

  it('opens the safe reader from the sheet after it has left history', async () => {
    await show('Spam', '/spam');
    await rows();
    await longPress(0);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/spam/a%3A0'));
  });
});
