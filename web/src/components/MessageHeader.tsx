import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AddressDTO, MessageDTO } from '@supermail/shared';
import { useIsPhone } from '../lib/useIsPhone';
import { BottomSheet } from './BottomSheet';

/** "09:41" today, else "28 Oct, 09:41" (with the year when it isn't this year). */
export function formatDate(ms: number, now = new Date()): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  const sameYear = d.getFullYear() === now.getFullYear();
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })}, ${time}`;
}

/** The whole date and time, for tooltips and the details popover. */
export function fullDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const DAY = 86_400_000;

/** "now", "5m ago", "3h ago", "Yesterday", "Mon", "12 Oct", "12 Oct 2025". */
export function formatRelative(ms: number, now = new Date()): string {
  const d = new Date(ms);
  const diff = now.getTime() - ms;
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (d.toDateString() === now.toDateString()) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (d.toDateString() === new Date(now.getTime() - DAY).toDateString()) return 'Yesterday';
  if (diff < 6 * DAY) return d.toLocaleDateString(undefined, { weekday: 'short' });
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

const isMe = (a: AddressDTO, me: string | undefined) => !!me && a.email.toLowerCase() === me.toLowerCase();

/** A sender as a line shows it: "me" for the account's own address, else the name or the address. */
export function displayName(a: AddressDTO, me: string | undefined): string {
  return isMe(a, me) ? 'me' : a.name || a.email;
}

/** "Irina Vasile <irina@example.com>", or the bare address when there is no name. */
const fullAddress = (a: AddressDTO) => (a.name ? `${a.name} <${a.email}>` : a.email);

/** "to me, Ana +2": "me" first, then first names, two at most. */
export function recipientSummary(m: Pick<MessageDTO, 'to' | 'cc'>, me: string | undefined): string {
  const all = [...m.to, ...m.cc];
  if (all.length === 0) return 'to no one';
  const sorted = [...all.filter((a) => isMe(a, me)), ...all.filter((a) => !isMe(a, me))];
  const short = sorted.map((a) => (isMe(a, me) ? 'me' : a.name ? a.name.split(/\s+/)[0]! : a.email.split('@')[0]!));
  const shown = short.slice(0, 2).join(', ');
  return `to ${shown}${short.length > 2 ? ` +${short.length - 2}` : ''}`;
}

/** A collapsed message: sender, a one-line preview, and a relative date (the full date in its tooltip). */
export function CollapsedHeader({ m, me, preview, onToggle }: { m: MessageDTO; me: string | undefined; preview: string; onToggle(): void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={false}
      className="flex min-h-14 w-full cursor-pointer flex-wrap items-baseline gap-x-3 px-4 py-2 text-left text-base transition-colors duration-150 ease-out hover:bg-hover max-md:active:bg-hover md:min-h-0 md:flex-nowrap md:text-sm"
    >
      <span className="min-w-0 flex-1 truncate font-semibold md:w-40 md:flex-none md:shrink-0">{displayName(m.from, me)}</span>
      <span className="order-last w-full truncate text-sm text-muted md:order-none md:w-auto md:min-w-0 md:flex-1">{preview}</span>
      <span className="shrink-0 text-xs text-faint" title={fullDate(m.date)}>
        {formatRelative(m.date)}
      </span>
    </button>
  );
}

/** An open message's header: sender name and address, the date, and "to me, Ana +2" opening the details. */
export function ExpandedHeader({ m, me, account, onToggle }: { m: MessageDTO; me: string | undefined; account: string; onToggle(): void }) {
  return (
    <div className="px-4 pt-3">
      <button type="button" onClick={onToggle} aria-expanded={true} className="flex min-h-11 w-full cursor-pointer items-center gap-2 text-left max-md:active:bg-hover md:min-h-0 md:items-baseline">
        <span className="shrink-0 text-base font-semibold md:text-sm">{displayName(m.from, me)}</span>
        {!isMe(m.from, me) && <span className="min-w-0 truncate text-xs text-faint">{m.from.email}</span>}
        <span className="flex-1" />
        <span className="shrink-0 text-xs text-faint" title={fullDate(m.date)}>
          {formatDate(m.date)}
        </span>
      </button>
      <MessageDetails m={m} me={me} account={account} />
    </div>
  );
}

/** "to me, Ana +2" with a popover (on the phone, a sheet) listing From, To, Cc, Date and Account. */
function MessageDetails({ m, me, account }: { m: MessageDTO; me: string | undefined; account: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const phone = useIsPhone();

  useEffect(() => {
    if (!open || phone) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, phone]);

  // Escape closes the popover and never reaches the thread's shortcuts (where it means Back).
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !open) return;
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
    button.current?.focus();
  };

  const rows: [string, string][] = [
    ['From', fullAddress(m.from)],
    ['To', m.to.map(fullAddress).join(', ')],
    ...(m.cc.length ? ([['Cc', m.cc.map(fullAddress).join(', ')]] as [string, string][]) : []),
    ['Date', fullDate(m.date)],
    ['Account', account],
  ];
  const details = (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 max-md:px-4 max-md:pb-4 max-md:text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-right text-faint">{k}</dt>
          <dd className="break-words text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );

  return (
    <div ref={wrap} className="relative inline-block" onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="-ml-1 inline-flex h-11 cursor-pointer items-center gap-1 rounded px-1 text-xs text-muted hover:bg-hover hover:text-fg max-md:active:bg-hover md:h-6"
      >
        {recipientSummary(m, me)}
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open &&
        (phone ? (
          <BottomSheet label="Message details" onClose={() => setOpen(false)}>
            {details}
          </BottomSheet>
        ) : (
          <div
            role="dialog"
            aria-label="Message details"
            className="absolute left-0 top-full z-20 mt-1 w-max max-w-[min(32rem,calc(100vw-2rem))] rounded-md border border-line bg-bg p-3 text-xs shadow-lg"
          >
            {details}
          </div>
        ))}
    </div>
  );
}
