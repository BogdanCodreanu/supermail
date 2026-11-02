import { useQueries } from '@tanstack/react-query';
import { Check, ChevronDown, Settings } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import type { AccountDTO } from '@supermail/shared';
import { api, qk } from '../api/client';
import { accountLabels } from '../lib/accounts';
import { useIsPhone } from '../lib/useIsPhone';
import { BottomSheet } from './BottomSheet';
import { whenBackSettled } from './phone/backStack';

const MENU_WIDTH = 288;
const SCREEN_MARGIN = 16;
const GAP = 4;
const ITEMS = '[role="menuitemradio"], [role="menuitem"]';

function Dot({ color }: { color: string | null }) {
  return <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color ?? 'transparent', boxShadow: color ? undefined : 'inset 0 0 0 1px var(--faint)' }} />;
}

function Unread({ count }: { count: number | null }) {
  if (!count) return null;
  return (
    <span data-testid="unread" className="shrink-0 text-xs tabular-nums text-muted">
      {count}
      <span className="sr-only"> unread</span>
    </span>
  );
}

/** Unread per account, from each account's group counts. `total` waits for every account: a partial sum would read as a real one. */
function useUnread(accounts: AccountDTO[], enabled: boolean) {
  const results = useQueries({ queries: accounts.map((a) => ({ queryKey: qk.groups(a.id), queryFn: () => api.groups(a.id), enabled })) });
  const counts = results.map((r) => r.data?.reduce((n, g) => n + g.unreadCount, 0) ?? null);
  const total = counts.includes(null) ? null : counts.reduce<number>((n, c) => n + (c ?? 0), 0);
  return { byAccount: new Map(accounts.map((a, i) => [a.id, counts[i] ?? null])), total };
}

/**
 * All accounts, or one account (`value` null means all). `` ` `` cycles it from the keyboard
 * (handled by the view). The menu takes the arrow keys, and Escape closes it. It lives in a portal
 * so the header can't clip it, and only counts unread mail while it is open. On the phone it is a sheet.
 */
export function AccountSwitcher({ accounts, value, onChange }: { accounts: AccountDTO[]; value: string | null; onChange(id: string | null): void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  const current = accounts.find((a) => a.id === value) ?? null;
  const options = [null, ...accounts];
  const labels = useMemo(() => accountLabels(accounts), [accounts]);
  const unread = useUnread(accounts, open);
  const phone = useIsPhone();
  const navigate = useNavigate();

  // Written straight to the element, before paint: the menu has to exist at its place when it takes focus.
  useLayoutEffect(() => {
    if (!open || phone) return;
    const place = () => {
      const box = trigger.current?.getBoundingClientRect();
      const el = menu.current;
      if (!box || !el) return;
      const top = box.bottom + GAP;
      el.style.top = `${top}px`;
      el.style.left = `${Math.max(SCREEN_MARGIN, Math.min(box.left, window.innerWidth - MENU_WIDTH - SCREEN_MARGIN))}px`;
      el.style.maxHeight = `${window.innerHeight - top - SCREEN_MARGIN}px`;
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, phone]);

  useEffect(() => {
    if (!open || phone) return;
    const close = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!trigger.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open, phone]);

  // Start on the current choice, like a native select; `` ` `` moves it while the menu is open.
  useEffect(() => {
    if (!open) return;
    const items = menu.current?.querySelectorAll<HTMLElement>(ITEMS);
    items?.[Math.max(0, options.findIndex((a) => (a?.id ?? null) === value))]?.focus();
  }, [open, value]);

  const pick = (id: string | null) => {
    onChange(id);
    setOpen(false);
    trigger.current?.focus();
  };

  const onMenuKeyDown = (e: KeyboardEvent) => {
    // The list is behind the menu: only `` ` `` still reaches the page's shortcuts.
    if (e.key !== '`') e.stopPropagation();
    const items = [...(menu.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[e.key];
    if (e.key === 'Escape') {
      // never reaches the page (Escape would go back)
      e.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    } else if (e.key === 'Tab') {
      // Tab carries on from the trigger, not from the portal at the end of the page.
      setOpen(false);
      trigger.current?.focus();
    } else if (to !== undefined && items.length > 0) {
      e.preventDefault();
      items[(to + items.length) % items.length]?.focus();
    }
  };

  const items = (
    <>
      {options.map((a) => {
        const on = (a?.id ?? null) === value;
        return (
          <li key={a?.id ?? ''} role="none">
            <button
              type="button"
              role="menuitemradio"
              aria-checked={on}
              title={a?.email}
              onClick={() => pick(a?.id ?? null)}
              className="flex min-h-12 w-full cursor-pointer items-center gap-3 px-4 py-1 text-left text-base hover:bg-hover focus-visible:bg-hover max-md:active:bg-hover md:min-h-8 md:gap-2 md:px-3 md:text-xs"
            >
              <Dot color={a?.color ?? null} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-fg">{a ? (labels.get(a.id) ?? a.email) : 'All accounts'}</span>
                {a && <span className="block truncate text-xs text-faint md:text-2xs">{a.email}</span>}
              </span>
              {a?.status === 'reconnect_needed' && <span className="shrink-0 text-2xs text-danger">reconnect</span>}
              {a?.status === 'syncing' && <span className="shrink-0 text-2xs text-faint">syncing</span>}
              <Unread count={a ? (unread.byAccount.get(a.id) ?? null) : unread.total} />
              <Check size={14} strokeWidth={1.75} aria-hidden className={`h-5 w-5 shrink-0 md:h-3.5 md:w-3.5 ${on ? 'text-accent' : 'invisible'}`} />
            </button>
          </li>
        );
      })}
      <li role="separator" className="my-1 h-px bg-line" />
      <li role="none">
        <Link
          to="/settings"
          role="menuitem"
          onClick={(e) => {
            setOpen(false);
            if (!phone) return;
            // The sheet's history entry goes first: navigating at once would land on the page behind it instead.
            e.preventDefault();
            whenBackSettled(() => navigate('/settings'));
          }}
          className="flex h-12 w-full cursor-pointer items-center gap-3 px-4 text-base text-muted hover:bg-hover hover:text-fg focus-visible:bg-hover max-md:active:bg-hover md:h-8 md:gap-2 md:px-3 md:text-xs"
        >
          <Settings size={14} strokeWidth={1.75} aria-hidden className="h-5 w-5 shrink-0 md:h-3.5 md:w-3.5" />
          Manage accounts…
        </Link>
      </li>
    </>
  );

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={`Account: ${current?.email ?? 'All accounts'}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch account (`)"
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={`flex h-11 min-w-0 cursor-pointer items-center gap-2 rounded px-2 text-xs text-muted hover:bg-hover hover:text-fg max-md:active:bg-hover md:h-8 ${open ? 'bg-hover text-fg' : ''}`}
      >
        <Dot color={current?.color ?? null} />
        <span className="truncate">{current ? (labels.get(current.id) ?? current.email) : 'All accounts'}</span>
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
      </button>
      {open &&
        (phone ? (
          <BottomSheet label="Accounts" onClose={() => setOpen(false)}>
            <ul ref={menu} role="menu" aria-label="Accounts" onKeyDown={onMenuKeyDown} className="pb-2">
              {items}
            </ul>
          </BottomSheet>
        ) : (
          createPortal(
            <ul
              ref={menu}
              role="menu"
              aria-label="Accounts"
              onKeyDown={onMenuKeyDown}
              style={{ width: MENU_WIDTH }}
              className="fixed z-40 max-w-[calc(100vw-32px)] overflow-y-auto rounded-md border border-line bg-bg py-1 shadow-lg"
            >
              {items}
            </ul>,
            document.body,
          )
        ))}
    </>
  );
}
