import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ui.ts keeps the collapsed flag in a module-level store, so each test gets fresh modules.
async function load() {
  const { ShortcutPanel } = await import('../src/components/ShortcutPanel');
  return ShortcutPanel;
}

function row(label: string) {
  return screen.getByText(label, { selector: 'li > span' }).closest('li') as HTMLElement;
}

/** The keys drawn inside `el`, in reading order (a key's `data-key` is its keymap name). */
function keysIn(el: HTMLElement) {
  return [...el.querySelectorAll('[data-key]')].map((k) => k.getAttribute('data-key'));
}

function pressQuestionMark() {
  act(() => {
    fireEvent.keyDown(document.body, { key: '?', shiftKey: true });
  });
}

describe('ShortcutPanel', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('shows Done with e in the list context, grouped under Triage', async () => {
    const ShortcutPanel = await load();
    render(<ShortcutPanel context="list" />);
    expect(within(row('Done')).getByText(/^e$/i)).toBeInTheDocument();
    const triage = screen.getByRole('heading', { name: 'Triage' }).parentElement as HTMLElement;
    expect(within(triage).getByText('Done')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Teach' })).toBeInTheDocument();
    expect(screen.queryByText('Next message')).not.toBeInTheDocument();
  });

  it.each([
    ['list', 'Inbox'],
    ['thread', 'Reading'],
    ['compose', 'Writing'],
    ['skipped', 'Skipped'],
    ['settings', 'Settings'],
    ['search', 'Search'],
    ['spam', 'Spam'],
    ['spamReader', 'Spam'],
  ] as const)('titles the %s panel %s', async (context, title) => {
    const ShortcutPanel = await load();
    render(<ShortcutPanel context={context} />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(new RegExp(`^${title}$`));
  });

  it.each([
    ['list', ['Navigate', 'Triage', 'Write', 'Teach', 'Find', 'View']],
    ['thread', ['Navigate', 'Triage', 'Write', 'Teach', 'Find', 'View']],
    ['compose', ['Navigate', 'Write', 'View']],
    ['skipped', ['Navigate', 'Triage', 'Write', 'Find', 'View']],
    ['settings', ['Navigate', 'Write', 'Find', 'View']],
    ['search', ['Navigate', 'Write', 'Find', 'View']],
    ['spam', ['Navigate', 'Triage', 'Write', 'Find', 'View']],
    ['spamReader', ['Navigate', 'Triage', 'Write', 'Find', 'View']],
  ] as const)('orders the %s sections, leaving out the empty ones', async (context, titles) => {
    const ShortcutPanel = await load();
    render(<ShortcutPanel context={context} />);
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(titles);
  });

  it.each([
    ['Navigate', ['j', 'k', 'Enter', ']', '[', '1–9', '`']],
    ['Triage', ['e', 'h', '!', 'u', 'z', 'x', 'Ctrl+a', 'Shift+j', 'Shift+k', 'Escape']],
    ['Write', ['r', 'a', 'f', 'c']],
    ['Teach', ['+', '-', 'l']],
    ['Find', ['/', 'Ctrl+k']],
    ['View', ['?', 'd']],
  ])('the inbox lists its %s keys', async (title, keys) => {
    const ShortcutPanel = await load();
    render(<ShortcutPanel context="list" />);
    expect(keysIn(screen.getByRole('heading', { name: title }).parentElement as HTMLElement)).toEqual(keys);
  });

  it.each([
    ['Navigate', ['j', 'k', 'n', 'p', 'Escape']],
    ['Triage', ['e', 'h', '!', 'u', 'z']],
    ['Write', ['r', 'a', 'f', 'c']],
    ['Teach', ['+', '-', 'l']],
    ['Find', ['/', 'Ctrl+k']],
    ['View', ['?']],
  ])('the thread lists its %s keys', async (title, keys) => {
    const ShortcutPanel = await load();
    render(<ShortcutPanel context="thread" />);
    expect(keysIn(screen.getByRole('heading', { name: title }).parentElement as HTMLElement)).toEqual(keys);
  });

  // Hand-checked against the handlers each view registers: these are the keys that really work there.
  it.each([
    ['list', ['j', 'k', 'Enter', ']', '[', '1–9', '`', 'e', 'h', '!', 'u', 'z', 'x', 'Ctrl+a', 'Shift+j', 'Shift+k', 'Escape', 'r', 'a', 'f', 'c', '+', '-', 'l', '/', 'Ctrl+k', '?', 'd']],
    ['thread', ['j', 'k', 'n', 'p', 'Escape', 'e', 'h', '!', 'u', 'z', 'r', 'a', 'f', 'c', '+', '-', 'l', '/', 'Ctrl+k', '?']],
    ['compose', ['Escape', 'Ctrl+Enter', '?']],
    ['skipped', ['j', 'k', 'Enter', 'Escape', 'i', 'z', 'c', '/', 'Ctrl+k', '?']],
    ['settings', ['Escape', 'c', '/', 'Ctrl+k', '?']],
    ['search', ['j', 'k', 'Enter', 'Escape', 'c', '/', 'Ctrl+k', '?']],
    ['spam', ['j', 'k', 'Enter', 'Escape', 'i', 'z', 'c', '/', 'Ctrl+k', '?']],
    ['spamReader', ['Escape', 'i', 'z', 'c', '/', 'Ctrl+k', '?']],
  ] as const)('the %s panel lists exactly its working keys, each once', async (context, keys) => {
    const ShortcutPanel = await load();
    render(<ShortcutPanel context={context} />);
    expect(keysIn(screen.getByRole('complementary', { name: 'Keyboard shortcuts' }))).toEqual(keys);
  });

  it('never repeats a row within a context', async () => {
    const ShortcutPanel = await load();
    for (const context of ['list', 'thread', 'compose', 'skipped', 'settings', 'search', 'spam', 'spamReader'] as const) {
      const { unmount } = render(<ShortcutPanel context={context} />);
      const rows = screen.getAllByRole('listitem').map((li) => li.textContent);
      expect(new Set(rows).size).toBe(rows.length);
      unmount();
    }
  });

  it('folds n and p into one row in the thread', async () => {
    const ShortcutPanel = await load();
    render(<ShortcutPanel context="thread" />);
    expect(row('Next / previous message')).toHaveTextContent(/n.*p/i);
    expect(screen.queryByText('Next message')).not.toBeInTheDocument();
  });

  it('shows Reply in the thread context', async () => {
    const ShortcutPanel = await load();
    render(<ShortcutPanel context="thread" />);
    expect(within(row('Reply')).getByText(/^r$/i)).toBeInTheDocument();
    expect(screen.queryByText('Open')).not.toBeInTheDocument();
  });

  it('shows Restore to inbox with i in the skipped context', async () => {
    const ShortcutPanel = await load();
    render(<ShortcutPanel context="skipped" />);
    expect(within(row('Restore to inbox')).getByText(/^i$/i)).toBeInTheDocument();
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
  });

  it('shows ] and [ for next / previous group, and never Tab', async () => {
    const ShortcutPanel = await load();
    render(<ShortcutPanel context="list" />);
    const groups = row('Next / previous group');
    expect(groups.querySelector('[data-key="]"]')).not.toBeNull();
    expect(groups.querySelector('[data-key="["]')).not.toBeNull();
    expect(screen.queryByText('Tab')).not.toBeInTheDocument();
  });

  it('shows Back (Esc) and no mail actions in the settings context', async () => {
    const ShortcutPanel = await load();
    render(<ShortcutPanel context="settings" />);
    expect(within(row('Back')).getByText('Esc')).toBeInTheDocument();
    expect(row('Search')).toBeInTheDocument();
    for (const label of ['Done', 'Next / previous', 'Open', 'Restore to inbox']) expect(screen.queryByText(label)).not.toBeInTheDocument();
  });

  it('shows moving, opening and Back in the search context, without inbox actions', async () => {
    const ShortcutPanel = await load();
    render(<ShortcutPanel context="search" />);
    for (const label of ['Next / previous', 'Open', 'Back', 'Search']) expect(row(label)).toBeInTheDocument();
    for (const label of ['Done', 'Snooze', 'Next / previous group']) expect(screen.queryByText(label)).not.toBeInTheDocument();
  });

  it('merges next/previous and the group number keys into single rows', async () => {
    const ShortcutPanel = await load();
    render(<ShortcutPanel context="list" />);
    expect(row('Next / previous')).toHaveTextContent(/j.*k/i);
    expect(row('Go to group')).toHaveTextContent('1–9');
    expect(screen.queryByText('Go to group 3')).not.toBeInTheDocument();
  });

  it('collapses on ? and stays collapsed across a re-render (localStorage)', async () => {
    const ShortcutPanel = await load();
    const { unmount } = render(<ShortcutPanel context="list" />);
    expect(screen.getByText('Done')).toBeInTheDocument();
    pressQuestionMark();
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
    expect(localStorage.getItem('sm.panelCollapsed')).toBe('1');
    unmount();

    vi.resetModules();
    const Fresh = await load();
    render(<Fresh context="list" />);
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
    pressQuestionMark();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(localStorage.getItem('sm.panelCollapsed')).toBe('0');
  });

  it('still collapses and survives a re-render when localStorage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const ShortcutPanel = await load();
    const { unmount } = render(<ShortcutPanel context="list" />);
    pressQuestionMark();
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
    unmount();
    render(<ShortcutPanel context="list" />);
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
  });

  it('can be reopened with the Keyboard button on the collapsed rail', async () => {
    const ShortcutPanel = await load();
    render(<ShortcutPanel context="list" />);
    pressQuestionMark();
    const reopen = screen.getByRole('button', { name: /show shortcuts/i });
    expect(reopen.querySelector('.lucide-keyboard')).not.toBeNull();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    fireEvent.click(reopen);
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it('collapses with the button next to the title', async () => {
    const ShortcutPanel = await load();
    render(<ShortcutPanel context="list" />);
    fireEvent.click(screen.getByRole('button', { name: /hide shortcuts/i }));
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
    expect(localStorage.getItem('sm.panelCollapsed')).toBe('1');
  });

  describe('in a narrow window', () => {
    const stubWidth = (width: number) => {
      vi.stubGlobal('matchMedia', (q: string) => ({
        matches: width <= Number(/max-width: (\d+)px/.exec(q)?.[1] ?? 0),
        addEventListener: () => {},
        removeEventListener: () => {},
      }));
    };

    it('collapses to its rail under 1100px, leaving the saved preference alone', async () => {
      stubWidth(1099);
      const ShortcutPanel = await load();
      render(<ShortcutPanel context="list" />);
      expect(screen.getByRole('button', { name: 'Show shortcuts' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Inbox' })).not.toBeInTheDocument();
      expect(localStorage.getItem('sm.panelCollapsed')).toBeNull();
    });

    it('stays open from 1100px', async () => {
      stubWidth(1100);
      const ShortcutPanel = await load();
      render(<ShortcutPanel context="list" />);
      expect(screen.getByRole('heading', { name: 'Inbox' })).toBeInTheDocument();
    });

    it('? opens it over the page for now, without saving anything', async () => {
      stubWidth(900);
      const ShortcutPanel = await load();
      render(<ShortcutPanel context="list" />);
      fireEvent.keyDown(document.body, { key: '?', shiftKey: true });
      const panel = await screen.findByRole('heading', { name: 'Inbox' });
      expect(panel.closest('aside')!.className).toContain('absolute');
      expect(localStorage.getItem('sm.panelCollapsed')).toBeNull();
      fireEvent.keyDown(document.body, { key: '?', shiftKey: true });
      expect(await screen.findByRole('button', { name: 'Show shortcuts' })).toBeInTheDocument();
      expect(localStorage.getItem('sm.panelCollapsed')).toBeNull();
    });

    it('the rail button opens it too', async () => {
      stubWidth(900);
      const ShortcutPanel = await load();
      render(<ShortcutPanel context="list" />);
      fireEvent.click(screen.getByRole('button', { name: 'Show shortcuts' }));
      expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeInTheDocument();
    });
  });
});
