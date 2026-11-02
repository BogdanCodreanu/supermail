import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { Check } from 'lucide-react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { ThreadSummaryDTO } from '@supermail/shared';
import { Layout } from '../src/components/Layout';
import { ThreadRow, type ThreadRowProps } from '../src/components/ThreadRow';
import type { KeyContext } from '../src/keys/keymap';

const thread: ThreadSummaryDTO = {
  id: 'a:1', accountId: 'a', subject: 'Invoice', snippet: 'see attached', fromName: 'Bolt', fromEmail: 'receipts@bolt.eu',
  lastMessageAt: 100, unread: true, inInbox: true, groupId: 'purchases', groupName: 'Purchases',
  reason: { source: 'heuristic', text: 'In Purchases (automatic guess)', at: null }, snoozedUntil: null, hasAttachments: true, suggestRule: false,
};

function row(over: Partial<ThreadRowProps> = {}) {
  const props: ThreadRowProps = { thread, accountColor: '#2563eb', selected: false, onSelect: vi.fn(), onOpen: vi.fn(), ...over };
  render(<ThreadRow {...props} />);
  return { props, el: screen.getByTestId('thread-row') };
}

describe('ThreadRow', () => {
  it('is a real link to the thread, and a plain click opens it in the app', () => {
    const { props, el } = row();
    expect(el.tagName).toBe('A');
    expect(el).toHaveAttribute('href', '/t/a%3A1');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    el.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(props.onSelect).toHaveBeenCalledTimes(1);
    expect(props.onOpen).toHaveBeenCalledTimes(1);
  });

  describe('in a narrow window', () => {
    const chip = { label: 'Purchases', color: '#ea580c', title: 'In Purchases (automatic guess)' };

    it('hides the snippet under 900px', () => {
      row();
      expect(screen.getByText('see attached').className).toContain('max-[899px]:hidden');
    });

    it('shrinks the group chip to a colour dot with a title under 900px', () => {
      const { el } = row({ chip });
      expect(screen.getByText('Purchases').className).toContain('max-[899px]:hidden');
      const dot = within(el).getByTestId('chip-dot');
      expect(dot.className).toContain('hidden');
      expect(dot.className).toContain('max-[899px]:inline-block');
      expect(dot).toHaveAttribute('title', 'Purchases · In Purchases (automatic guess)');
      expect(dot).toHaveStyle({ backgroundColor: '#ea580c' });
    });

    it('lets the subject shrink, so nothing runs over the paperclip or the date', () => {
      row({ chip });
      const subject = screen.getByText('Invoice');
      expect(subject.className).toContain('min-w-0');
      expect(subject.className).not.toContain('shrink-0');
    });

    it('keeps the account tag, the date and the one-line height', () => {
      const { el } = row({ account: { label: 'work', email: 'me@work.com' } });
      expect(el.className).toContain('h-9');
      expect(within(el).getByTestId('account-tag').className).toContain('shrink-0');
      expect(el.querySelector('time')!.className).toContain('shrink-0');
    });
  });

  it('without a selection to join, Ctrl and Shift clicks stay with the browser', () => {
    const { props, el } = row();
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: false, button: 0, shiftKey: true }));
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it('with a selection to join, Ctrl and Shift clicks go to it instead of opening', () => {
    const onToggle = vi.fn();
    const onExtend = vi.fn();
    const { props, el } = row({ onToggle, onExtend });
    fireEvent.click(el, { ctrlKey: true });
    expect(onToggle).toHaveBeenCalledTimes(1);
    fireEvent.click(el, { shiftKey: true });
    expect(onExtend).toHaveBeenCalledTimes(1);
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it('a Shift+press does not start a text selection', () => {
    const { el } = row({ onToggle: vi.fn(), onExtend: vi.fn() });
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true, shiftKey: true });
    el.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
  });

  it('links where the screen says when given an href', () => {
    const { el } = row({ href: '/spam/a%3A1' });
    expect(el).toHaveAttribute('href', '/spam/a%3A1');
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }])('leaves %o clicks to the browser (new tab or window)', (mods) => {
    const { props, el } = row();
    // Record what the row did, then stop jsdom from trying to load the page.
    let prevented: boolean | undefined;
    const stop = (e: Event) => {
      prevented = e.defaultPrevented;
      e.preventDefault();
    };
    document.addEventListener('click', stop);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...mods }));
    document.removeEventListener('click', stop);
    expect(prevented).toBe(false);
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it('marks unread with a 2px accent bar on the left edge and bold text, with one dot (the account)', () => {
    row();
    expect(screen.queryByTestId('unread-dot')).toBeNull();
    expect(screen.getAllByTestId('account-dot')).toHaveLength(1);
    expect(screen.getByRole('option')).toHaveClass('border-l-2', 'border-l-accent');
    expect(screen.getByText('Bolt')).toHaveClass('font-semibold', 'text-fg');
    expect(screen.getByText('Invoice')).toHaveClass('font-semibold');
    expect(screen.getByRole('option')).toHaveAccessibleName(/^Unread,/);
  });

  it('read rows have no bar, regular weight and a muted sender', () => {
    row({ thread: { ...thread, unread: false } });
    expect(screen.getByRole('option')).toHaveClass('border-l-transparent');
    expect(screen.getByText('Bolt')).toHaveClass('text-muted');
    expect(screen.getByText('Bolt')).not.toHaveClass('font-semibold');
    expect(screen.getByText('Invoice')).not.toHaveClass('font-semibold');
  });

  it('shows selection with the selection background, apart from the unread bar', () => {
    row({ thread: { ...thread, unread: false }, selected: true });
    expect(screen.getByRole('option')).toHaveClass('bg-sel', 'border-l-transparent');
  });

  it('shows attachments with a Paperclip icon, never the emoji', () => {
    const { el } = row();
    expect(el).not.toHaveTextContent('📎');
    expect(within(el).getByTestId('attachment-icon').tagName.toLowerCase()).toBe('svg');
  });

  it('keeps the reason in the chip tooltip and never adds a second line when selected', () => {
    const { el } = row({ selected: true, chip: { label: 'Purchases', title: thread.reason.text } });
    expect(within(el).getByText('Purchases')).toHaveAttribute('title', 'In Purchases (automatic guess)');
    expect(el).toHaveClass('h-9');
    expect(screen.queryByText('In Purchases (automatic guess)')).not.toBeInTheDocument();
  });

  it('a hover action runs without opening the thread, and is not a nested control of the option', () => {
    const run = vi.fn();
    const { props, el } = row({ selected: true, actions: [{ label: 'Done', keyHint: 'e', icon: Check, run }] });
    const done = screen.getByRole('button', { name: 'Done', hidden: true });
    expect(el.contains(done)).toBe(false);
    expect(done).toHaveAttribute('tabindex', '-1');
    expect(done).toHaveAttribute('title', 'Done (e)');
    fireEvent.click(done);
    expect(run).toHaveBeenCalledTimes(1);
    expect(props.onOpen).not.toHaveBeenCalled();
  });
});

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}

describe('Layout', () => {
  const app = (path: string, context: KeyContext = 'thread') =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={<Layout context="list">inbox page</Layout>} />
          <Route path="/search" element={<Where />} />
          <Route path="/compose" element={<Where />} />
          <Route path="*" element={<Layout context={context}>other page</Layout>} />
        </Routes>
      </MemoryRouter>,
    );
  const press = (key: string) =>
    act(() => {
      fireEvent.keyDown(document.body, { key });
    });

  it('puts the view\'s sub-header (group tabs) on its own full-width row under the header', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Layout context="list" top={<span>switcher</span>} sub={<span>tabs here</span>}>
          inbox page
        </Layout>
      </MemoryRouter>,
    );
    const row = screen.getByText('tabs here').parentElement!;
    expect(row).toHaveAttribute('data-testid', 'subheader');
    expect(row).toHaveClass('md:h-9', 'border-b');
    expect(row.closest('header')).toBeNull();
    expect(screen.getByText('switcher').closest('header')).not.toBeNull();
  });

  it('has no Back on the inbox', () => {
    app('/');
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  });

  it('shows Back with an arrow icon elsewhere, which returns to the inbox when there is no history', () => {
    app('/t/a%3A1');
    const back = screen.getByRole('button', { name: 'Back' });
    expect(back.querySelector('svg')).not.toBeNull();
    expect(back).not.toHaveTextContent('←');
    fireEvent.click(back);
    expect(screen.getByText('inbox page')).toBeInTheDocument();
  });

  it('has a primary Compose button with a pencil icon and the c hint', () => {
    app('/');
    const compose = screen.getByRole('link', { name: /compose/i });
    expect(compose).toHaveClass('bg-accent', 'text-on-accent');
    expect(compose.querySelector('svg')).not.toBeNull();
    expect(compose.querySelector('[data-key="c"]')).not.toBeNull();
    fireEvent.click(compose);
    expect(screen.getByTestId('where')).toHaveTextContent('/compose');
  });

  it('c composes from any page', () => {
    app('/settings', 'settings');
    press('c');
    expect(screen.getByTestId('where')).toHaveTextContent('/compose');
  });

  it('/ focuses the header search; Enter goes to /search?q=', () => {
    app('/');
    const field = screen.getByRole('textbox', { name: 'Search mail' });
    expect(within(screen.getByRole('search')).getByText('/')).toBeInTheDocument();
    press('/');
    expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: 'from:bolt invoice' } });
    fireEvent.submit(field);
    expect(screen.getByTestId('where')).toHaveTextContent('/search?q=from%3Abolt%20invoice');
  });

  it('Escape in the search field leaves the field, not the page', () => {
    app('/settings', 'settings');
    const field = screen.getByRole('textbox', { name: 'Search mail' });
    field.focus();
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(field).not.toHaveFocus();
    expect(screen.getByText('other page')).toBeInTheDocument();
  });

  it.each(['settings', 'skipped', 'spam'] as const)('Escape goes back in the %s context', (ctx) => {
    app('/elsewhere', ctx);
    press('Escape');
    expect(screen.getByText('inbox page')).toBeInTheDocument();
  });

  it('Escape is left to the thread view in the thread context', () => {
    app('/t/a%3A1', 'thread');
    press('Escape');
    expect(screen.getByText('other page')).toBeInTheDocument();
  });

  it('Spam is marked current on its screen and on a spam email', () => {
    app('/spam/a%3A1', 'spamReader');
    expect(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Spam' })).toHaveAttribute('aria-current', 'page');
  });

  it('a screen with its own Back has no second one in the header', () => {
    render(
      <MemoryRouter initialEntries={['/spam/a%3A1']}>
        <Routes>
          <Route path="*" element={<Layout context="spamReader" noBack><p>body</p></Layout>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.queryByRole('button', { name: /Back/ })).not.toBeInTheDocument();
  });

  it('the main pages have icons, labels and mark the current one', () => {
    app('/');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getAllByRole('link').map((l) => l.getAttribute('aria-label'))).toEqual(['Inbox', 'Skipped', 'Spam', 'Settings']);
    for (const name of ['Inbox', 'Skipped', 'Spam', 'Settings']) {
      expect(within(nav).getByRole('link', { name }).querySelector('svg')).not.toBeNull();
    }
    expect(within(nav).getByRole('link', { name: 'Inbox' })).toHaveAttribute('aria-current', 'page');
  });
});
