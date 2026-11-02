import { fireEvent, render, screen, within } from '@testing-library/react';
import { Check, Clock } from 'lucide-react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ContextMenu, placeMenu, type MenuEntry } from '../src/components/ContextMenu';

const VIEW = { width: 1000, height: 800 };
const SIZE = { width: 224, height: 400 };

describe('placeMenu', () => {
  it('opens at the cursor when it fits', () => {
    expect(placeMenu({ x: 100, y: 200 }, SIZE, VIEW)).toEqual({ left: 100, top: 200 });
  });

  it('flips left and up when it would run past the right and bottom edges', () => {
    expect(placeMenu({ x: 900, y: 700 }, SIZE, VIEW)).toEqual({ left: 676, top: 300 });
  });

  it('stays inside a viewport too small to flip into', () => {
    expect(placeMenu({ x: 100, y: 390 }, SIZE, { width: 300, height: 420 })).toEqual({ left: 68, top: 12 });
  });
});

function Harness({ items, focusFirst, onSelect }: { items?: MenuEntry[]; focusFirst?: boolean; onSelect?: (id: string) => void }) {
  const [open, setOpen] = useState(true);
  const select = (id: string) => () => onSelect?.(id);
  const entries: MenuEntry[] = items ?? [
    { id: 'done', label: 'Done', icon: Check, keyHint: 'e', onSelect: select('done') },
    'separator',
    { id: 'snooze', label: 'Snooze…', icon: Clock, onSelect: select('snooze') },
    { id: 'copy', label: 'Copy link', onSelect: select('copy') },
  ];
  return (
    <div>
      <button type="button">outside</button>
      {open && <ContextMenu label="Actions" x={10} y={20} items={entries} focusFirst={focusFirst} onClose={() => setOpen(false)} />}
    </div>
  );
}

const items = () => screen.getAllByRole('menuitem');

describe('ContextMenu', () => {
  it('renders in a portal on body as a menu with items, key hints and separators', () => {
    const { container } = render(<Harness />);
    const menu = screen.getByRole('menu', { name: 'Actions' });
    expect(container.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
    expect(items().map((i) => i.textContent)).toEqual(['DoneE', 'Snooze…', 'Copy link']);
    expect(within(menu).getAllByRole('separator')).toHaveLength(1);
  });

  it('flips to stay in the viewport', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ ...SIZE, x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, toJSON: () => ({}) });
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1000);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
    render(<ContextMenu label="Actions" x={900} y={700} items={[]} onClose={() => {}} />);
    expect(screen.getByRole('menu')).toHaveStyle({ left: '676px', top: '300px' });
  });

  it('opened by keyboard, focus starts on the first item; opened by mouse, on no item', () => {
    const { unmount } = render(<Harness focusFirst />);
    expect(items()[0]).toHaveFocus();
    unmount();
    render(<Harness />);
    expect(screen.getByRole('menu')).toHaveFocus();
  });

  it('arrow keys move through the items, skip separators and wrap; Home and End jump', () => {
    render(<Harness />);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(items()[0]).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(items()[1]).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(items()[2]).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(items()[0]).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(items()[2]).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(items()[0]).toHaveFocus();
  });

  it('ArrowUp from no item lands on the last one', () => {
    render(<Harness />);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(items()[2]).toHaveFocus();
  });

  it('Enter runs the focused item and closes', () => {
    const onSelect = vi.fn();
    render(<Harness focusFirst onSelect={onSelect} />);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('snooze');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('a click runs the item and closes', () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('menuitem', { name: /Copy link/ }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('copy');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Escape closes and gives focus back', () => {
    render(<button type="button">before</button>);
    screen.getByText('before').focus();
    render(<Harness />);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByText('before')).toHaveFocus();
  });

  it('keeps every key from the shortcuts behind it while open', () => {
    const shortcut = vi.fn();
    window.addEventListener('keydown', shortcut);
    render(<Harness />);
    fireEvent.keyDown(document.activeElement!, { key: 'e' });
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    window.removeEventListener('keydown', shortcut);
    expect(shortcut).not.toHaveBeenCalled();
  });

  it('closes on a press outside, and that click does not reach what is under it', () => {
    const under = vi.fn();
    render(
      <button type="button" onClick={under}>
        under
      </button>,
    );
    render(<Harness />);
    const target = screen.getByText('under');
    fireEvent.mouseDown(target, { button: 0 });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.mouseUp(target, { button: 0 });
    fireEvent.click(target);
    expect(under).not.toHaveBeenCalled();
  });

  it('a press that never became a click does not eat the next one', async () => {
    const under = vi.fn();
    render(
      <button type="button" onClick={under}>
        under
      </button>,
    );
    render(<Harness />);
    const target = screen.getByText('under');
    fireEvent.mouseDown(target, { button: 0 });
    fireEvent.mouseUp(document.body, { button: 0 });
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(target);
    expect(under).toHaveBeenCalledOnce();
  });

  it('closes on a right press outside without swallowing anything', () => {
    const under = vi.fn();
    render(
      <button type="button" onClick={under}>
        under
      </button>,
    );
    render(<Harness />);
    fireEvent.mouseDown(screen.getByText('under'), { button: 2 });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByText('under'));
    expect(under).toHaveBeenCalledOnce();
  });

  it('a press inside does not close it', () => {
    render(<Harness />);
    fireEvent.mouseDown(items()[0]!, { button: 0 });
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('closes when the page is scrolled, but not when the menu itself is', () => {
    render(<Harness />);
    fireEvent.wheel(screen.getByRole('menu'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.wheel(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes when the window is resized or loses focus', () => {
    const { unmount } = render(<Harness />);
    fireEvent(window, new Event('resize'));
    expect(screen.queryByRole('menu')).toBeNull();
    unmount();
    render(<Harness />);
    fireEvent(window, new Event('blur'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps the browser menu away while open', () => {
    render(<Harness />);
    expect(fireEvent.contextMenu(screen.getByRole('menu'))).toBe(false);
  });
});
