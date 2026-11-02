import { useEffect, type ReactNode, type Ref, type UIEvent } from 'react';
import { useIsPhone } from '../lib/useIsPhone';

export interface ThreadListboxProps {
  label: string;
  /** DOM id of the selected row (see `rowDomId`). */
  activeId: string | undefined;
  /** Arrow keys while the list has focus; j/k work everywhere through the keymap. */
  onMove(delta: 1 | -1): void;
  onMoveTo(edge: 'first' | 'last'): void;
  listRef?: Ref<HTMLDivElement>;
  onScroll?(e: UIEvent<HTMLDivElement>): void;
  className?: string;
  children: ReactNode;
}

/**
 * The focusable list of threads: one tab stop, rows as options, the selection announced through
 * `aria-activedescendant` and kept in view. The selected row draws the focus ring while the list
 * has keyboard focus (ThreadRow's `group-focus-visible/list`). A phone has no cursor to follow: there the list stays
 * where the finger left it.
 */
export function ThreadListbox({ label, activeId, onMove, onMoveTo, listRef, onScroll, className = '', children }: ThreadListboxProps) {
  const phone = useIsPhone();
  useEffect(() => {
    if (activeId && !phone) document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId, phone]);

  return (
    <div
      ref={listRef}
      role="listbox"
      tabIndex={0}
      aria-label={label}
      aria-activedescendant={activeId}
      onScroll={onScroll}
      onKeyDown={(e) => {
        const step = { ArrowDown: 1, ArrowUp: -1 }[e.key] as 1 | -1 | undefined;
        if (step) onMove(step);
        else if (e.key === 'Home') onMoveTo('first');
        else if (e.key === 'End') onMoveTo('last');
        else return;
        e.preventDefault();
      }}
      // The selected row shows the ring instead (it is where the keyboard is).
      className={`group/list outline-none ${className}`}
    >
      {children}
    </div>
  );
}
