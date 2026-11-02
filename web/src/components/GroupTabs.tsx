import { Check, ChevronDown, Plus } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { GroupDTO } from '@supermail/shared';
import { useIsPhone } from '../lib/useIsPhone';
import { PhoneGroupTabs, type PhoneGroupTabsProps } from './phone/PhoneGroupTabs';

interface Tab { id: string | null; name: string; count: number }

const keyOf = (t: Tab) => t.id ?? '';
const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((k) => b.has(k));

/** The group tabs: a row that folds into More on a computer, sideways-scrolling pills on a phone. */
export function GroupTabs(props: PhoneGroupTabsProps) {
  return useIsPhone() ? <PhoneGroupTabs {...props} /> : <ComputerTabs {...props} />;
}

/**
 * "All" plus one tab per group, in position order, each with its inbox count (counts follow the
 * account filter: the caller passes groups fetched for it). `selected` null means All. One tab stop;
 * the arrow keys, Home and End move between tabs once it has focus (`[`/`]` work from anywhere).
 *
 * The tabs wrap inside a one-line row that clips the rest, so it never scrolls: the ones that land
 * past the first line (an IntersectionObserver tells) leave the tab order and are offered under More.
 */
function ComputerTabs({ groups, selected, onSelect, onCreate }: PhoneGroupTabsProps) {
  const total = groups.reduce((n, g) => n + g.inboxCount, 0);
  const tabs: Tab[] = [{ id: null, name: 'All', count: total }, ...groups.map((g) => ({ id: g.id, name: g.name, count: g.inboxCount }))];
  const list = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const current = Math.max(0, tabs.findIndex((t) => t.id === selected));
  const [clipped, setClipped] = useState<ReadonlySet<string>>(() => new Set());
  const tabKeys = tabs.map(keyOf).join('\n');

  useEffect(() => {
    const box = list.current;
    if (!box || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) =>
        setClipped((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const k = (e.target as HTMLElement).dataset.tabKey ?? '';
            if (e.isIntersecting && e.intersectionRatio > 0.99) next.delete(k);
            else next.add(k);
          }
          return sameSet(prev, next) ? prev : next;
        }),
      { root: box, threshold: [0, 1] },
    );
    box.querySelectorAll('[data-tab-key]').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [tabKeys]);

  const hidden = tabs.filter((t) => clipped.has(keyOf(t)));

  const onKeyDown = (e: KeyboardEvent) => {
    const to = { ArrowRight: current + 1, ArrowLeft: current - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const i = (to + tabs.length) % tabs.length;
    onSelect(tabs[i]!.id);
    if (clipped.has(keyOf(tabs[i]!))) moreRef.current?.focus();
    else list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[i]?.focus();
  };

  return (
    <div className="flex h-full min-w-0 flex-1 items-stretch gap-4">
      <div
        ref={list}
        role="tablist"
        aria-label="Groups"
        className="flex h-full min-w-0 flex-initial flex-wrap items-stretch gap-x-4 overflow-hidden"
        onKeyDown={onKeyDown}
      >
        {tabs.map((t, i) => {
          const on = t.id === selected;
          const away = clipped.has(keyOf(t));
          return (
            <button
              key={keyOf(t)}
              type="button"
              role="tab"
              data-tab-key={keyOf(t)}
              aria-selected={on}
              aria-hidden={away || undefined}
              tabIndex={i === current && !away ? 0 : -1}
              onClick={() => onSelect(t.id)}
              className={`flex h-full cursor-pointer items-center gap-1 whitespace-nowrap border-b-2 transition-colors duration-150 ease-out ${away ? 'invisible' : ''} ${
                on ? 'border-accent font-semibold text-fg' : 'border-transparent text-muted hover:text-fg'
              }`}
            >
              {t.name}
              <span className="text-2xs font-normal tabular-nums text-faint">{t.count}</span>
            </button>
          );
        })}
      </div>
      {hidden.length > 0 && <MoreGroups tabs={hidden} selected={selected} onSelect={onSelect} trigger={moreRef} />}
      {onCreate && <NewGroup onCreate={onCreate} />}
    </div>
  );
}

/** The + after the tabs: a small popover with a name field. Enter creates, Esc or a click outside cancels. */
function NewGroup({ onCreate }: { onCreate(name: string): Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const show = () => {
    setName('');
    setError(null);
    setOpen(true);
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy.current) return;
    busy.current = true;
    setError(null);
    try {
      await onCreate(trimmed);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busy.current = false;
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    }
  };

  return (
    <div ref={ref} className="relative flex shrink-0 items-center">
      <button
        ref={trigger}
        type="button"
        aria-label="New group"
        title="New group"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : show())}
        className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted transition-colors duration-150 ease-out hover:bg-hover hover:text-fg"
      >
        <Plus size={16} strokeWidth={1.75} aria-hidden />
      </button>
      {open && (
        <div role="dialog" aria-label="New group" className="absolute right-0 top-full z-30 mt-1 w-56 rounded-md border border-line bg-bg p-2 shadow-lg">
          <input
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={onKeyDown}
            placeholder="Group name"
            aria-label="Group name"
            className="h-8 w-full rounded border border-line bg-bg px-2 focus:border-accent"
          />
          {error && <p role="alert" className="pt-1.5 text-xs text-danger">{error}</p>}
        </div>
      )}
    </div>
  );
}

/** The tabs that don't fit, as a menu; it names the selected group when that is one of them. */
function MoreGroups({ tabs, selected, onSelect, trigger }: { tabs: Tab[]; selected: string | null; onSelect(id: string | null): void; trigger: RefObject<HTMLButtonElement> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  const chosen = tabs.find((t) => t.id === selected);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    const items = menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
    items?.[Math.max(0, tabs.findIndex((t) => t.id === selected))]?.focus();
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const pick = (id: string | null) => {
    onSelect(id);
    setOpen(false);
    trigger.current?.focus();
  };

  const onMenuKeyDown = (e: KeyboardEvent) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[e.key];
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    } else if (to !== undefined && items.length > 0) {
      e.preventDefault();
      items[(to + items.length) % items.length]?.focus();
    }
  };

  return (
    <div ref={ref} className="relative flex shrink-0 items-stretch">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={chosen ? `More groups, ${chosen.name} selected` : 'More groups'}
        onClick={() => setOpen(!open)}
        className={`flex h-full cursor-pointer items-center gap-1 whitespace-nowrap border-b-2 transition-colors duration-150 ease-out ${
          chosen ? 'border-accent font-semibold text-fg' : 'border-transparent text-muted hover:text-fg'
        }`}
      >
        {chosen?.name ?? 'More'}
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden />
      </button>
      {open && (
        <ul
          ref={menu}
          role="menu"
          aria-label="More groups"
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 top-full z-30 mt-1 min-w-48 rounded-md border border-line bg-bg py-1 shadow-lg"
        >
          {tabs.map((t) => {
            const on = t.id === selected;
            return (
              <li key={keyOf(t)} role="none">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  onClick={() => pick(t.id)}
                  className="flex h-8 w-full cursor-pointer items-center gap-2 px-3 text-left text-sm hover:bg-hover focus-visible:bg-hover"
                >
                  <span className="flex-1 truncate">{t.name}</span>
                  <span className="text-2xs tabular-nums text-faint">{t.count}</span>
                  <Check size={14} strokeWidth={1.75} aria-hidden className={on ? 'text-accent' : 'invisible'} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
