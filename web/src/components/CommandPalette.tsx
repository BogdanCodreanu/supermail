import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, qk } from '../api/client';
import { BINDINGS, type Binding, type KeyContext } from '../keys/keymap';
import { useShortcuts } from '../keys/useShortcuts';
import { useIsPhone } from '../lib/useIsPhone';
import { useAccountFilter } from '../state/ui';
import { Kbd } from './Kbd';

interface Command { id: string; label: string; keys: string[]; section: string; available: boolean; run: () => void }

/** Bindings the palette offers; the numbered group keys are covered by the named groups below. */
const PALETTE_BINDINGS = BINDINGS.filter((b) => b.id !== 'palette' && !/^group\d$/.test(b.id));

/**
 * Runs a binding exactly as if its key had been pressed, so the palette always does what the key does
 * in the current view and never needs its own copy of the handlers.
 */
function replayKey(b: Binding): void {
  const key = b.keys[0]!;
  const ctrl = key.startsWith('Ctrl+');
  const shift = key.startsWith('Shift+');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: ctrl ? key.slice(5) : shift ? key.slice(6) : key, ctrlKey: ctrl, shiftKey: shift, bubbles: true, cancelable: true }));
}

function matches(label: string, query: string): boolean {
  const l = label.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => l.includes(w));
}

/**
 * `Ctrl+K` command palette: every shortcut binding (those that work here first), the Inbox, Skipped,
 * Spam and Settings pages, and each group. `onGroup` decides how a group is opened; by default `/?group=<id>`.
 * Not on the phone: it is a keyboard tool.
 */
export function CommandPalette({ context, onGroup }: { context: KeyContext; onGroup?: (groupId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const [accountId] = useAccountFilter();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const phone = useIsPhone();

  useShortcuts(context, {
    palette: () => {
      setQuery('');
      setActive(0);
      setOpen(true);
    },
  });

  const groups = useQuery({ queryKey: qk.groups(accountId), queryFn: () => api.groups(accountId), enabled: open });

  const commands = useMemo<Command[]>(() => {
    const close = () => setOpen(false);
    const go = (to: string) => () => {
      close();
      navigate(to);
    };
    const bindings = PALETTE_BINDINGS.map((b) => {
      const available = b.contexts.includes(context);
      return {
        id: b.id,
        label: b.label,
        keys: b.keys,
        section: b.section,
        available,
        run: () => {
          close();
          // after the palette unmounts and focus leaves its input
          setTimeout(() => replayKey(b), 0);
        },
      };
    });
    const pages: Command[] = [
      { id: 'page:inbox', label: 'Inbox', keys: [], section: 'Go', available: true, run: go('/') },
      { id: 'page:skipped', label: 'Skipped your inbox', keys: [], section: 'Go', available: true, run: go('/skipped') },
      { id: 'page:spam', label: 'Spam', keys: [], section: 'Go', available: true, run: go('/spam') },
      { id: 'page:settings', label: 'Settings', keys: [], section: 'Go', available: true, run: go('/settings') },
    ];
    const groupCommands: Command[] = [...(groups.data ?? [])]
      .sort((a, b) => a.position - b.position)
      .map((g) => ({
        id: `group:${g.id}`,
        label: `Go to ${g.name}`,
        keys: [],
        section: 'Group',
        available: true,
        run: () => {
          close();
          if (onGroup) onGroup(g.id);
          else navigate(`/?group=${encodeURIComponent(g.id)}`);
        },
      }));
    const all = [...bindings, ...pages, ...groupCommands];
    // stable: what works in this view first, the rest after (dimmed)
    return [...all.filter((c) => c.available), ...all.filter((c) => !c.available)];
  }, [context, groups.data, navigate, onGroup]);

  const visible = useMemo(() => commands.filter((c) => matches(c.label, query)), [commands, query]);
  const current = Math.min(active, Math.max(visible.length - 1, 0));

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [current, open]);

  if (!open || phone) return null;

  const runAt = (i: number) => {
    const c = visible[i];
    if (c?.available) c.run();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    // preventDefault keeps the view's own shortcuts (Escape = back) from seeing these keys
    if (e.key === 'Escape' || (e.key === 'k' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault();
      setActive(Math.min(current + 1, visible.length - 1));
    } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault();
      setActive(Math.max(current - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runAt(current);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[15vh]" onMouseDown={() => setOpen(false)}>
      <div aria-hidden className="absolute inset-0 bg-bg opacity-60" />
      <div
        role="dialog"
        aria-label="Command palette"
        aria-modal="true"
        className="relative w-[520px] max-w-full overflow-hidden rounded-lg border border-line bg-bg shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={visible[current] ? `palette-${visible[current].id}` : undefined}
          aria-label="Type a command"
          placeholder="Type a command…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className="h-12 w-full border-b border-line bg-transparent px-4 text-base outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        />
        <ul ref={listRef} id="palette-list" role="listbox" aria-label="Commands" className="max-h-[50vh] overflow-y-auto py-1">
          {visible.length === 0 && <li className="px-4 py-2 text-muted">No matching command</li>}
          {visible.map((c, i) => (
            <li
              key={c.id}
              id={`palette-${c.id}`}
              role="option"
              aria-selected={i === current}
              aria-disabled={!c.available}
              onMouseMove={() => i !== current && setActive(i)}
              onClick={() => runAt(i)}
              className={`flex h-8 items-center justify-between gap-3 px-4 ${i === current ? 'bg-sel' : ''} ${c.available ? 'cursor-pointer' : 'cursor-not-allowed text-faint'}`}
            >
              <span className="truncate">{c.label}</span>
              <span className="flex shrink-0 items-center gap-2">
                {!c.available && <span className="text-2xs">not here</span>}
                <span className="text-2xs text-faint">{c.section}</span>
                {c.keys.map((k) => (
                  <Kbd key={k} k={k} />
                ))}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
