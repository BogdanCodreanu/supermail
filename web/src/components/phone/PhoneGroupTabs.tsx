import { Plus } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { GroupDTO } from '@supermail/shared';
import { BottomSheet } from '../BottomSheet';
import { barButton } from './AppBar';

export interface PhoneGroupTabsProps {
  groups: GroupDTO[];
  selected: string | null;
  onSelect(id: string | null): void;
  onCreate?(name: string): Promise<void>;
}

function NewGroupSheet({ onCreate, onClose }: { onCreate(name: string): Promise<void>; onClose(): void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy.current) return;
    busy.current = true;
    setError(null);
    try {
      await onCreate(trimmed);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      busy.current = false;
    }
  };
  return (
    <BottomSheet label="New group" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3 px-4 pb-4 pt-2">
        <input
          autoFocus
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          placeholder="Group name"
          aria-label="Group name"
          enterKeyHint="done"
          className="h-12 w-full rounded border border-line bg-bg px-3 text-[16px] focus:border-accent"
        />
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <button type="submit" className="h-12 touch-manipulation rounded bg-accent text-base font-medium text-on-accent active:opacity-80">
          Create
        </button>
      </form>
    </BottomSheet>
  );
}

/** How long a scroll must be quiet to count as settled, where the browser has no `scrollend`. */
const SETTLE_MS = 120;
/** Where it has, how long to wait for it before settling anyway. */
const SCROLLEND_LATE_MS = 400;
/** The opacity of a pill half the slider away from the centre. */
const FARTHEST = 0.35;

const centreOf = (tab: HTMLElement) => tab.offsetLeft + tab.offsetWidth / 2;

/**
 * The groups as one snap slider: swipe it and the group that settles in the centre becomes the active one, tap a pill to
 * go straight there. Swipes on the list belong to the rows, so this is the way between groups. An accent line under the
 * centre follows the finger, and the neighbours fade. New group is the stop after the last pill, by tap only.
 *
 * There is a whole screen of empty scroll beyond the first and last pill. Snapping still stops at those pills, but the
 * end of the scroll is further than one finger can drag: reaching it mid-drag would turn into the browser's back
 * navigation and leave the app, and by then neither overscroll-behavior nor a cancelled touchmove can stop it. That room
 * is on the row inside the scroller: a flex item can't be narrower than its own padding, so on the scroller it would
 * widen it, and the wider scroller would ask for more.
 */
export function PhoneGroupTabs({ groups, selected, onSelect, onCreate }: PhoneGroupTabsProps) {
  const total = groups.reduce((n, g) => n + g.inboxCount, 0);
  const tabs = [{ id: null as string | null, name: 'All', count: total }, ...groups.map((g) => ({ id: g.id as string | null, name: g.name, count: g.inboxCount }))];
  const tabKeys = tabs.map((t) => t.id ?? '').join('\n');
  const track = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const line = useRef<HTMLDivElement>(null);
  const active = useRef<HTMLButtonElement>(null);
  const [creating, setCreating] = useState(false);
  const latest = useRef({ selected, onSelect });
  latest.current = { selected, onSelect };
  const placed = useRef(false);
  /** A tapped group's scroll is on its way there: what passes under the centre until then means nothing. */
  const aiming = useRef(false);

  const pills = () => [...(track.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];

  /** Fades the pills by their distance from the centre, and fits the line to what is there: between two pills, some of each. */
  const paint = () => {
    const el = track.current;
    const all = pills();
    if (!el || all.length === 0) return;
    const mid = el.scrollLeft + el.clientWidth / 2;
    const reach = el.clientWidth / 2 || 1;
    for (const tab of all) tab.style.opacity = String(Math.max(FARTHEST, 1 - (Math.abs(centreOf(tab) - mid) / reach) * (1 - FARTHEST)));
    const after = all.findIndex((tab) => centreOf(tab) >= mid);
    const right = all[after === -1 ? all.length - 1 : after]!;
    const left = all[Math.max(0, (after === -1 ? all.length : after) - 1)]!;
    const span = centreOf(right) - centreOf(left);
    const share = span > 0 ? (mid - centreOf(left)) / span : 0;
    if (line.current) line.current.style.transform = `translateX(-50%) scaleX(${left.offsetWidth + (right.offsetWidth - left.offsetWidth) * share})`;
  };

  // The plus uses up part of the room at the end.
  useLayoutEffect(() => {
    const el = track.current;
    const inner = row.current;
    if (!el || !inner) return;
    const fit = () => {
      const all = pills();
      if (all.length === 0) return;
      const room = (tab: HTMLElement) => el.clientWidth + Math.max(0, (el.clientWidth - tab.offsetWidth) / 2);
      const plus = el.querySelector<HTMLElement>('[data-plus]');
      inner.style.paddingLeft = `${room(all[0]!)}px`;
      inner.style.paddingRight = `${room(all.at(-1)!) - (plus?.offsetWidth ?? 0)}px`;
      active.current?.scrollIntoView?.({ inline: 'center', block: 'nearest', behavior: 'auto' });
      paint();
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => watch.disconnect();
  }, [tabKeys]);

  useEffect(() => {
    if (!placed.current) {
      placed.current = true;
      return;
    }
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    aiming.current = true;
    active.current?.scrollIntoView?.({ inline: 'center', block: 'nearest', behavior: still ? 'auto' : 'smooth' });
  }, [selected]);

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    let quiet: ReturnType<typeof setTimeout>;
    let down = false;
    const quietMs = window.onscrollend === undefined ? SETTLE_MS : SCROLLEND_LATE_MS;

    const settle = () => {
      clearTimeout(quiet);
      if (down) return;
      if (aiming.current) {
        aiming.current = false;
        return;
      }
      const mid = el.scrollLeft + el.clientWidth / 2;
      const nearest = pills().reduce<HTMLElement | null>((best, tab) => (!best || Math.abs(centreOf(tab) - mid) < Math.abs(centreOf(best) - mid) ? tab : best), null);
      const key = nearest?.dataset.tabKey;
      if (key === undefined) return;
      const id = key === '' ? null : key;
      if (id !== latest.current.selected) latest.current.onSelect(id);
    };
    /** A pause in a tapped group's scroll: it is still on its way, so nothing is decided. */
    const aimed = () => {
      if (!aiming.current) settle();
    };
    const onScrollEnd = () => settle();
    const onScroll = () => {
      paint();
      clearTimeout(quiet);
      quiet = setTimeout(aimed, quietMs);
    };
    const onTouchStart = () => {
      down = true;
      aiming.current = false;
    };
    const onTouchEnd = () => {
      down = false;
      clearTimeout(quiet);
      quiet = setTimeout(settle, quietMs);
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('scrollend', onScrollEnd);
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchEnd);
    return () => {
      clearTimeout(quiet);
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('scrollend', onScrollEnd);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, []);

  return (
    <div className="relative flex h-full min-w-0 flex-1 items-stretch">
      <div ref={track} data-testid="group-slider" className="relative min-w-0 flex-1 snap-x snap-mandatory overflow-x-auto overscroll-x-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div ref={row} data-testid="slider-row" className="flex h-full w-max items-center">
        <div role="tablist" aria-label="Groups" className="contents">
          {tabs.map((t) => {
            const on = t.id === selected;
            return (
              <button
                key={t.id ?? ''}
                ref={on ? active : undefined}
                type="button"
                role="tab"
                data-tab-key={t.id ?? ''}
                aria-selected={on}
                tabIndex={on ? 0 : -1}
                onClick={() => onSelect(t.id)}
                className={`flex h-12 shrink-0 snap-center touch-manipulation items-center gap-1.5 whitespace-nowrap px-4 text-base active:bg-hover ${on ? 'font-semibold text-fg' : 'text-muted'}`}
              >
                {t.name}
                <span className="text-xs font-normal tabular-nums text-muted">{t.count}</span>
              </button>
            );
          })}
        </div>
        {onCreate && (
          <button type="button" data-plus aria-label="New group" aria-haspopup="dialog" onClick={() => setCreating(true)} className={barButton}>
            <Plus size={20} strokeWidth={1.75} aria-hidden />
          </button>
        )}
        </div>
      </div>
      <div ref={line} data-testid="slider-underline" aria-hidden className="pointer-events-none absolute bottom-0 left-1/2 h-0.5 w-px bg-accent" />
      {creating && onCreate && <NewGroupSheet onCreate={onCreate} onClose={() => setCreating(false)} />}
    </div>
  );
}
