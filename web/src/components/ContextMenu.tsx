import type { LucideIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useIsPhone } from '../lib/useIsPhone';
import { Kbd } from './Kbd';

export interface MenuItem { id: string; label: string; icon?: LucideIcon; keyHint?: string; onSelect(): void }
export type MenuEntry = MenuItem | 'separator';

interface Point { x: number; y: number }
interface Size { width: number; height: number }

/** The gap kept between the menu and the edge of the window. */
const MARGIN = 8;

function fit(at: number, size: number, room: number): number {
  const start = at + size > room - MARGIN && at - size >= MARGIN ? at - size : at;
  return Math.max(MARGIN, Math.min(start, room - size - MARGIN));
}

/** Where to put a menu opened at `at`: there when it fits, else flipped over the cursor, else slid just far enough in. */
export function placeMenu(at: Point, size: Size, viewport: Size): { left: number; top: number } {
  return { left: fit(at.x, size.width, viewport.width), top: fit(at.y, size.height, viewport.height) };
}

/** The left click that dismisses a menu does only that; it must not also open the row under it. */
function swallowNextClick(): void {
  const swallow = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener('click', swallow, { capture: true, once: true });
  // A press that never became a click (a drag) must not eat the next one.
  window.addEventListener('mouseup', () => setTimeout(() => window.removeEventListener('click', swallow, true), 0), { once: true });
}

export interface ContextMenuProps {
  label: string;
  x: number;
  y: number;
  items: MenuEntry[];
  /** Opened from the keyboard: focus starts on the first item, not on the menu. */
  focusFirst?: boolean;
  onClose(): void;
}

/** A menu at the cursor. Not on the phone, where a long press opens a sheet instead: whoever asked for one is told it closed. */
export function ContextMenu(props: ContextMenuProps) {
  const phone = useIsPhone();
  useEffect(() => {
    if (phone) props.onClose();
  }, [phone]);
  return phone ? null : <CursorMenu {...props} />;
}

/**
 * The menu itself, in a portal on body. While it is open it owns the keyboard: arrows, Home and End move,
 * Enter or Space runs an item, Escape or Tab closes it, and no key reaches the shortcuts behind it. A press
 * outside, scrolling, resizing or leaving the window closes it. Scrolling means the wheel or a finger, not the
 * `scroll` event: the list scrolls by itself to keep a row in view when the right-click selects it.
 */
function CursorMenu({ label, x, y, items, focusFirst = false, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  // Before paint, so it never shows in the wrong place.
  useLayoutEffect(() => {
    const el = ref.current!;
    const { width, height } = el.getBoundingClientRect();
    const { left, top } = placeMenu({ x, y }, { width, height }, { width: window.innerWidth, height: window.innerHeight });
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [x, y]);

  // A layout effect: focus goes back before a picker opened by an item takes it (autoFocus), not after.
  useLayoutEffect(() => {
    const before = document.activeElement;
    const el = ref.current!;
    (focusFirst ? (el.querySelector<HTMLElement>('[role="menuitem"]') ?? el) : el).focus({ preventScroll: true });
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      e.stopPropagation();
      const list = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
      const at = list.indexOf(document.activeElement as HTMLElement);
      const to = { ArrowDown: at + 1, ArrowUp: at === -1 ? -1 : at - 1, Home: 0, End: -1 }[e.key];
      if (to !== undefined) {
        e.preventDefault();
        if (list.length > 0) list[(to + list.length) % list.length]?.focus();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        list[at]?.click();
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        close.current();
      }
    };
    const outside = (e: Event) => !ref.current?.contains(e.target as Node);
    const onMouseDown = (e: MouseEvent) => {
      if (!outside(e)) return;
      if (e.button === 0) swallowNextClick();
      close.current();
    };
    const onScroll = (e: Event) => {
      if (outside(e)) close.current();
    };
    const dismiss = () => close.current();
    const noBrowserMenu = (e: Event) => e.preventDefault();
    // Rows select on hover; behind the menu they stay on the one it acts on.
    const holdRows = (e: Event) => {
      if (outside(e)) e.stopPropagation();
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('mousemove', holdRows, true);
    window.addEventListener('wheel', onScroll, { capture: true, passive: true });
    window.addEventListener('touchmove', onScroll, { capture: true, passive: true });
    window.addEventListener('contextmenu', noBrowserMenu, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('mousemove', holdRows, true);
      window.removeEventListener('wheel', onScroll, true);
      window.removeEventListener('touchmove', onScroll, true);
      window.removeEventListener('contextmenu', noBrowserMenu, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
    };
  }, []);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={{ left: x, top: y, maxHeight: `calc(100vh - ${2 * MARGIN}px)` }}
      className="fixed z-50 min-w-56 overflow-y-auto rounded-md border border-line bg-bg py-1 shadow-lg"
    >
      {items.map((item, i) =>
        item === 'separator' ? (
          <div key={`separator-${i}`} role="separator" className="my-1 border-t border-line" />
        ) : (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              item.onSelect();
              close.current();
            }}
            // The mouse and the arrows move the same highlight, so two rows are never lit.
            onMouseEnter={(e) => e.currentTarget.focus({ preventScroll: true })}
            className="flex h-7 w-full cursor-pointer items-center gap-2 px-3 text-left text-sm text-fg focus:bg-hover"
          >
            {item.icon ? <item.icon size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-muted" /> : <span aria-hidden className="w-3.5 shrink-0" />}
            <span className="flex-1 truncate">{item.label}</span>
            {item.keyHint && <Kbd k={item.keyHint} />}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
