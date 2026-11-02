import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupDTO } from '@supermail/shared';
import { GroupTabs } from '../src/components/GroupTabs';

const group = (id: string, name: string, inboxCount: number, position: number): GroupDTO => ({
  id, name, position, color: '#64748b', notify: false, kind: 'builtin', inboxCount, unreadCount: 0,
});
const GROUPS = [group('important', 'Important', 4, 1), group('money', 'Money & Security', 2, 2), group('low', 'Low priority', 7, 3), group('unsorted', 'Unsorted', 1, 4)];

/** jsdom has no layout: this observer reports the tabs named in `clipped` as not fitting the row. */
let clipped = new Set<string>();
const observers: FakeIO[] = [];
class FakeIO {
  targets: Element[] = [];
  constructor(private cb: IntersectionObserverCallback) {
    observers.push(this);
  }
  observe(el: Element) {
    this.targets.push(el);
  }
  disconnect() {}
  unobserve() {}
  report() {
    const entries = this.targets.map((target) => {
      const fits = !clipped.has(target.textContent ?? '');
      return { target, isIntersecting: fits, intersectionRatio: fits ? 1 : 0 } as unknown as IntersectionObserverEntry;
    });
    act(() => this.cb(entries, this as unknown as IntersectionObserver));
  }
}

beforeEach(() => {
  observers.length = 0;
  clipped = new Set();
  vi.stubGlobal('IntersectionObserver', FakeIO);
});
afterEach(() => vi.unstubAllGlobals());

const report = () => observers.forEach((o) => o.report());

describe('GroupTabs', () => {
  it('shows All and every group with its count in small faint type, and never scrolls', () => {
    render(<GroupTabs groups={GROUPS} selected={null} onSelect={vi.fn()} />);
    report();
    const list = screen.getByRole('tablist', { name: 'Groups' });
    expect(within(list).getAllByRole('tab').map((t) => t.textContent)).toEqual(['All14', 'Important4', 'Money & Security2', 'Low priority7', 'Unsorted1']);
    expect(within(list).getByText('7')).toHaveClass('text-2xs', 'text-faint');
    expect(list.className).not.toMatch(/overflow-(x-)?(auto|scroll)/);
    expect(screen.queryByRole('button', { name: /More/ })).toBeNull();
  });

  it('collapses the tabs that do not fit into a More menu', () => {
    const onSelect = vi.fn();
    render(<GroupTabs groups={GROUPS} selected={null} onSelect={onSelect} />);
    clipped = new Set(['Low priority7', 'Unsorted1']);
    report();
    // The clipped tabs leave the tab order; More offers them.
    expect(screen.queryByRole('tab', { name: /Low priority/ })).toBeNull();
    const more = screen.getByRole('button', { name: /More/ });
    expect(more).toHaveAttribute('aria-haspopup', 'menu');
    fireEvent.click(more);
    const menu = screen.getByRole('menu', { name: 'More groups' });
    expect(within(menu).getAllByRole('menuitemradio').map((i) => i.textContent)).toEqual(['Low priority7', 'Unsorted1']);
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /Unsorted/ }));
    expect(onSelect).toHaveBeenCalledWith('unsorted');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('names the selected group on More when it is one of the collapsed ones', () => {
    render(<GroupTabs groups={GROUPS} selected="low" onSelect={vi.fn()} />);
    clipped = new Set(['Low priority7', 'Unsorted1']);
    report();
    const more = screen.getByRole('button', { name: /Low priority/ });
    expect(more).toHaveClass('border-accent');
  });
});

describe('New group', () => {
  const onCreate = vi.fn();
  const openPopover = () => {
    render(<GroupTabs groups={GROUPS} selected={null} onSelect={() => {}} onCreate={onCreate} />);
    fireEvent.click(screen.getByRole('button', { name: 'New group' }));
    return screen.getByRole('textbox', { name: 'Group name' });
  };

  beforeEach(() => {
    onCreate.mockReset();
    onCreate.mockResolvedValue(undefined);
  });

  it('has no button without somewhere to create', () => {
    render(<GroupTabs groups={GROUPS} selected={null} onSelect={() => {}} />);
    expect(screen.queryByRole('button', { name: 'New group' })).toBeNull();
  });

  it('sits outside the tab list', () => {
    render(<GroupTabs groups={GROUPS} selected={null} onSelect={() => {}} onCreate={onCreate} />);
    expect(within(screen.getByRole('tablist')).queryByRole('button', { name: 'New group' })).toBeNull();
  });

  it('Enter creates the group and closes', async () => {
    const input = openPopover();
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: ' Travel ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('Travel'));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Group name' })).toBeNull());
  });

  it('Esc cancels and gives the focus back', () => {
    const input = openPopover();
    fireEvent.change(input, { target: { value: 'Travel' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Group name' })).toBeNull();
    expect(screen.getByRole('button', { name: 'New group' })).toHaveFocus();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('an empty name creates nothing', () => {
    const input = openPopover();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('a failure stays open and says why', async () => {
    onCreate.mockRejectedValue(new Error('A group named "Dev" already exists'));
    const input = openPopover();
    fireEvent.change(input, { target: { value: 'Dev' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists');
    expect(screen.getByRole('textbox', { name: 'Group name' })).toBeInTheDocument();
  });
});
