import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountDTO, GroupDTO } from '@supermail/shared';

const api = vi.hoisted(() => ({ groups: vi.fn() }));
vi.mock('../src/api/client', async (importOriginal) => ({ ...(await importOriginal<object>()), api }));

const { AccountSwitcher } = await import('../src/components/AccountSwitcher');
const { useShortcuts } = await import('../src/keys/useShortcuts');

const accounts: AccountDTO[] = [
  { id: 'a', email: 'you@example.com', color: '#2563eb', status: 'ok' },
  { id: 'b', email: 'work@example.com', color: '#16a34a', status: 'ok' },
];

function group(id: string, unreadCount: number): GroupDTO {
  return { id, name: id, position: 0, color: '#64748b', notify: false, kind: 'builtin', inboxCount: unreadCount + 1, unreadCount };
}

/** What the server returns: the counts of each group, for one account. */
const UNREAD: Record<string, GroupDTO[]> = { a: [group('important', 3), group('dev', 4)], b: [group('important', 5)] };

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

function Harness({ list = accounts, initial = null, pageKeys = {} }: { list?: AccountDTO[]; initial?: string | null; pageKeys?: Record<string, () => void> }) {
  const [value, setValue] = useState<string | null>(initial);
  useShortcuts('list', pageKeys);
  return (
    <>
      <header data-testid="header" style={{ height: 48, overflow: 'hidden' }}>
        <AccountSwitcher accounts={list} value={value} onChange={setValue} />
      </header>
      <span data-testid="value">{value ?? 'all'}</span>
      <button type="button">elsewhere</button>
      <Where />
    </>
  );
}

function renderSwitcher(props: Parameters<typeof Harness>[0] = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Harness {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const trigger = () => screen.getByRole('button', { name: /^Account:/ });
const options = () => screen.getAllByRole('menuitemradio');
const manage = () => screen.getByRole('menuitem', { name: 'Manage accounts…' });

function openMenu() {
  fireEvent.click(trigger());
  return screen.getByRole('menu');
}

/** A real click: the mousedown comes first, and is what closes a menu on outside clicks. */
function click(el: Element) {
  fireEvent.mouseDown(el);
  fireEvent.mouseUp(el);
  fireEvent.click(el);
}

beforeEach(() => {
  api.groups.mockReset();
  api.groups.mockImplementation(async (id: string) => UNREAD[id] ?? []);
});

describe('AccountSwitcher trigger', () => {
  it('says All accounts when no account is chosen', () => {
    renderSwitcher();
    expect(trigger()).toHaveTextContent(/^All accounts$/);
  });

  it('shows the short label of the chosen account, not its address', () => {
    renderSwitcher({ initial: 'a' });
    expect(trigger()).toHaveTextContent(/^you$/);
  });
});

describe('AccountSwitcher menu', () => {
  it('renders outside the header, so the 48px header can never clip it', () => {
    renderSwitcher();
    const menu = openMenu();
    expect(screen.getByTestId('header')).not.toContainElement(menu);
    expect(within(screen.getByTestId('header')).queryByRole('menu')).toBeNull();
  });

  it('sits under the trigger', () => {
    renderSwitcher();
    vi.spyOn(trigger(), 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 8, 120, 32));
    const menu = openMenu();
    expect(menu).toHaveStyle({ top: '44px', left: '100px' });
  });

  it('stays on screen when the trigger is near the right edge', () => {
    vi.stubGlobal('innerWidth', 400);
    renderSwitcher();
    vi.spyOn(trigger(), 'getBoundingClientRect').mockReturnValue(new DOMRect(300, 8, 90, 32));
    const menu = openMenu();
    expect(menu).toHaveStyle({ left: '96px' }); // 400 wide, less the 288 menu and a 16 margin
  });

  it('follows the trigger when the window resizes', () => {
    renderSwitcher();
    const rect = vi.spyOn(trigger(), 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 8, 120, 32));
    const menu = openMenu();
    rect.mockReturnValue(new DOMRect(40, 8, 120, 32));
    fireEvent(window, new Event('resize'));
    expect(menu).toHaveStyle({ left: '40px' });
  });

  it('lists All accounts, then every account with its label and full address', () => {
    renderSwitcher();
    openMenu();
    const rows = options();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('All accounts');
    expect(rows[1]).toHaveTextContent('you');
    expect(rows[1]).toHaveTextContent('you@example.com');
    expect(rows[2]).toHaveTextContent('work');
    expect(rows[2]).toHaveTextContent('work@example.com');
  });

  it('shows the unread count of each account and the combined count on All accounts', async () => {
    renderSwitcher();
    openMenu();
    await waitFor(() => expect(within(options()[1]!).getByTestId('unread')).toHaveTextContent('7'));
    expect(within(options()[2]!).getByTestId('unread')).toHaveTextContent('5');
    expect(within(options()[0]!).getByTestId('unread')).toHaveTextContent('12');
  });

  it('shows no count for an account with nothing unread', async () => {
    api.groups.mockImplementation(async (id: string) => (id === 'a' ? [group('important', 0)] : UNREAD.b));
    renderSwitcher();
    openMenu();
    await waitFor(() => expect(within(options()[2]!).getByTestId('unread')).toHaveTextContent('5'));
    expect(within(options()[1]!).queryByTestId('unread')).toBeNull();
  });

  it('shows no combined count while one account failed to load, rather than a total that is too low', async () => {
    api.groups.mockImplementation(async (id: string) => {
      if (id === 'a') throw new Error('offline');
      return UNREAD.b;
    });
    renderSwitcher();
    openMenu();
    await waitFor(() => expect(within(options()[2]!).getByTestId('unread')).toHaveTextContent('5'));
    expect(within(options()[0]!).queryByTestId('unread')).toBeNull();
  });

  it('asks for the counts only once the menu opens', async () => {
    renderSwitcher();
    expect(api.groups).not.toHaveBeenCalled();
    openMenu();
    await waitFor(() => expect(api.groups).toHaveBeenCalledWith('b'));
    expect(api.groups).toHaveBeenCalledWith('a');
  });

  it('marks the current choice with a check, and only that one', () => {
    renderSwitcher({ initial: 'b' });
    openMenu();
    expect(options().map((o) => o.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true']);
    const checks = options().map((o) => o.querySelector('.lucide-check'));
    expect(checks[2]).not.toHaveClass('invisible');
    expect(checks[1]).toHaveClass('invisible');
  });

  it('keeps saying which accounts need attention', () => {
    renderSwitcher({ list: [accounts[0]!, { ...accounts[1]!, status: 'reconnect_needed' }] });
    openMenu();
    expect(options()[2]).toHaveTextContent('reconnect');
  });

  it('choosing an account sets the filter and closes the menu (the click survives its mousedown)', () => {
    renderSwitcher();
    openMenu();
    click(options()[2]!);
    expect(screen.getByTestId('value')).toHaveTextContent('b');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it('choosing All accounts clears the filter', () => {
    renderSwitcher({ initial: 'a' });
    openMenu();
    click(options()[0]!);
    expect(screen.getByTestId('value')).toHaveTextContent('all');
  });

  it('Manage accounts… comes last, after a separator, and goes to Settings', () => {
    renderSwitcher();
    const menu = openMenu();
    expect(within(menu).getByRole('separator')).toBeInTheDocument();
    const all = [...menu.querySelectorAll('[role^="menuitem"]')];
    expect(all[all.length - 1]).toBe(manage());
    click(manage());
    expect(screen.getByTestId('where')).toHaveTextContent('/settings');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on a click elsewhere', () => {
    renderSwitcher();
    openMenu();
    click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('a click on the trigger closes the open menu instead of reopening it', () => {
    renderSwitcher();
    openMenu();
    click(trigger());
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('AccountSwitcher keyboard', () => {
  it('starts on the current choice', () => {
    renderSwitcher({ initial: 'a' });
    openMenu();
    expect(options()[1]).toHaveFocus();
  });

  it('ArrowDown opens it from the trigger', () => {
    renderSwitcher();
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    expect(options()[0]).toHaveFocus();
  });

  it('arrow keys move through every row, Manage accounts… included, and wrap around', () => {
    renderSwitcher();
    const menu = openMenu();
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(manage()).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(options()[0]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'End' });
    expect(manage()).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(options()[0]).toHaveFocus();
  });

  it('Escape closes it, back on the trigger, without reaching the page (where it would go back)', () => {
    const back = vi.fn();
    renderSwitcher({ pageKeys: { back } });
    const menu = openMenu();
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger()).toHaveFocus();
    expect(back).not.toHaveBeenCalled();
  });

  it('Tab closes it and continues from the trigger, not from the end of the page', () => {
    renderSwitcher();
    const menu = openMenu();
    fireEvent.keyDown(menu, { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it('mail shortcuts do not fire behind the open menu', () => {
    const done = vi.fn();
    renderSwitcher({ pageKeys: { done } });
    fireEvent.keyDown(options_focused(), { key: 'e' });
    expect(done).not.toHaveBeenCalled();
  });

  it('` still cycles accounts with the menu open', () => {
    const cycleAccount = vi.fn();
    renderSwitcher({ pageKeys: { cycleAccount } });
    fireEvent.keyDown(options_focused(), { key: '`' });
    expect(cycleAccount).toHaveBeenCalledTimes(1);
  });

  it('focus follows the choice when ` cycles it with the menu open', () => {
    function Cycling() {
      const [value, setValue] = useState<string | null>(null);
      useShortcuts('list', { cycleAccount: () => setValue('a') });
      return <AccountSwitcher accounts={accounts} value={value} onChange={setValue} />;
    }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <Cycling />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    openMenu();
    expect(options()[0]).toHaveFocus();
    act(() => {
      fireEvent.keyDown(options()[0]!, { key: '`' });
    });
    expect(options()[1]).toHaveFocus();
  });
});

function options_focused() {
  openMenu();
  return document.activeElement as HTMLElement;
}
