import type { LucideIcon } from 'lucide-react';
import { Paperclip, Square, SquareCheck } from 'lucide-react';
import type { MouseEvent } from 'react';
import type { ThreadSummaryDTO } from '@supermail/shared';
import { useIsPhone } from '../lib/useIsPhone';
import { PhoneRow, type PhoneSwipe } from './phone/PhoneRow';

const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const FULL = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const TOOLTIP = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' });

/** Today → "10:12", this year → "27 Oct", older → "27 Oct 2025". */
export function formatRowDate(ms: number, now: Date = new Date()): string {
  const d = new Date(ms);
  if (d.toDateString() === now.toDateString()) return TIME.format(d);
  return d.getFullYear() === now.getFullYear() ? DAY.format(d) : FULL.format(d);
}

export function senderOf(t: Pick<ThreadSummaryDTO, 'fromName' | 'fromEmail'>): string {
  return t.fromName || t.fromEmail || '(unknown sender)';
}

/** The thread's own URL, so rows are real links (middle-click and Ctrl-click open a new tab). */
export function threadHref(id: string): string {
  return `/t/${encodeURIComponent(id)}`;
}

/** A spam thread's URL: it has no index row, so it can never open at `threadHref`. */
export function spamHref(id: string): string {
  return `/spam/${encodeURIComponent(id)}`;
}

/** Marked Done and still out of the inbox. A thread back in the inbox (from Gmail, say) can keep its done time. */
export function isDone(t: Pick<ThreadSummaryDTO, 'inInbox' | 'doneAt'>): boolean {
  return !t.inInbox && t.doneAt != null;
}

/** The row's DOM id, for the listbox's `aria-activedescendant`. */
export function rowDomId(id: string): string {
  return `thread-${encodeURIComponent(id)}`;
}

/** A mouse shortcut shown on hover; the keyboard has the same action on `keyHint`. */
export interface RowAction { label: string; keyHint: string; icon: LucideIcon; run(): void }

export interface ThreadRowProps {
  thread: ThreadSummaryDTO;
  accountColor: string;
  /** In a merged view of several accounts: which account received it (short label + full address). */
  account?: { label: string; email: string } | null;
  /** The small label before the subject (the group, "Archived", or "Done"); its tooltip says why. */
  chip?: { label: string; color?: string; title?: string; icon?: LucideIcon } | null;
  /** A Done thread in a list that shows them: the row's content recedes, the selection doesn't. */
  dimmed?: boolean;
  selected: boolean;
  onSelect(): void;
  onOpen(): void;
  /** Right-click, at the cursor; the row is selected first. */
  onMenu?(x: number, y: number): void;
  actions?: RowAction[];
  /** Where the row links to, when that is not the thread view. */
  href?: string;
  /** Ticked for a bulk action. */
  checked?: boolean;
  /** Something in the list is ticked: every row shows its checkbox, not just the one under the mouse. */
  selecting?: boolean;
  /** Ticks or unticks the row. A list without it has no checkboxes, and leaves Ctrl and Shift clicks to the browser. */
  onToggle?(): void;
  /** Ticks everything from the last anchor to this row. */
  onExtend?(): void;
  /** On a phone: what a swipe in each direction does. A direction left out does not swipe. */
  swipe?: { right?: PhoneSwipe; left?: PhoneSwipe };
  /** On a phone: the row's actions, on a long-press. The row is selected first. */
  onLongPress?(): void;
}

/** A click that should stay with the browser: a new tab or window, or a download. */
function opensElsewhere(e: MouseEvent): boolean {
  return e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
}

/** A row of a thread list: the dense line on a computer, the swipeable three lines on a phone. */
export function ThreadRow(props: ThreadRowProps) {
  return useIsPhone() ? <PhoneRow {...props} /> : <ComputerRow {...props} />;
}

/**
 * One dense row, always one line (36 px) so the list never shifts on `j`/`k`. Unread rows have a 2 px
 * accent bar on the left edge and bold sender and subject; the selected row has the selection background.
 * The only dot is the account's. The row is an
 * option of the list's listbox and a real link to the thread. Hover actions and the checkbox sit beside the link,
 * not inside it, and are mouse-only duplicates of their keys (hidden from assistive tech).
 * Under 900 px the snippet goes and the chip shrinks to a dot, and the subject gives way before anything overlaps.
 */
function ComputerRow({ thread: t, accountColor, account, chip, dimmed = false, selected, onSelect, onOpen, onMenu, actions = [], href, checked = false, selecting = false, onToggle, onExtend }: ThreadRowProps) {
  const sender = senderOf(t);
  const subject = t.subject || '(no subject)';
  return (
    // Hovering selects the row, so keyboard actions (e, h, +, -, r…) apply to the email under the mouse.
    // mousemove rather than mouseenter: rows sliding under a still mouse while j/k scrolls must not steal it.
    <div
      role="none"
      className="group relative"
      onMouseMove={() => {
        if (!selected) onSelect();
      }}
      onContextMenu={
        onMenu &&
        ((e) => {
          e.preventDefault();
          onSelect();
          onMenu(e.clientX, e.clientY);
        })
      }
    >
      <a
        id={rowDomId(t.id)}
        role="option"
        aria-selected={selected}
        aria-checked={onToggle ? checked : undefined}
        href={href ?? threadHref(t.id)}
        tabIndex={-1}
        data-testid="thread-row"
        data-thread-id={t.id}
        data-unread={t.unread}
        data-done={dimmed || undefined}
        onMouseDown={(e) => {
          if (e.shiftKey && onExtend) e.preventDefault(); // a range of rows, not of text
        }}
        onClick={(e) => {
          const join = e.button === 0 && (e.shiftKey ? onExtend : e.ctrlKey || e.metaKey ? onToggle : undefined);
          if (join) {
            e.preventDefault();
            join();
            return;
          }
          if (opensElsewhere(e)) return;
          e.preventDefault();
          onSelect();
          onOpen();
        }}
        className={`flex h-9 cursor-pointer items-center gap-3 border-b border-l-2 border-b-line pl-4 pr-4 text-fg group-focus-visible/list:ring-inset ${
          t.unread ? 'border-l-accent' : 'border-l-transparent'
        } ${selected ? 'bg-sel group-focus-visible/list:ring-2 group-focus-visible/list:ring-accent' : checked ? 'bg-hover' : 'hover:bg-hover'} ${dimmed ? '[&>*]:opacity-60' : ''}`}
      >
        {t.unread && <span className="sr-only">Unread,</span>}
        {account ? (
          <span
            data-testid="account-tag"
            title={`Received at ${account.email}`}
            className="flex w-28 shrink-0 items-center gap-1.5 text-2xs text-muted"
          >
            <span data-testid="account-dot" aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: accountColor }} />
            <span className="truncate" style={{ color: accountColor }}>
              <span className="sr-only">Received at </span>
              {account.label}
            </span>
          </span>
        ) : (
          <span data-testid="account-dot" aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: accountColor }} />
        )}
        <span className={`w-40 min-w-0 truncate max-[899px]:w-28 ${t.unread ? 'font-semibold text-fg' : 'text-muted'}`} title={t.fromEmail ?? undefined}>
          {sender}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {chip && (
            <>
              <span
                title={chip.title}
                className="inline-flex shrink-0 items-center gap-1 rounded px-1 text-2xs font-semibold max-[899px]:hidden"
                style={{ backgroundColor: `color-mix(in srgb, ${chip.color ?? 'var(--faint)'} 18%, transparent)`, color: chip.color ?? 'var(--muted)' }}
              >
                {chip.icon && <chip.icon size={14} strokeWidth={1.75} aria-hidden data-testid="chip-icon" />}
                {chip.label}
              </span>
              <span
                data-testid="chip-dot"
                role="img"
                aria-label={chip.label}
                title={[chip.label, chip.title].filter(Boolean).join(' · ')}
                className="hidden h-2 w-2 shrink-0 rounded-full max-[899px]:inline-block"
                style={{ backgroundColor: chip.color ?? 'var(--faint)' }}
              />
            </>
          )}
          <span className={`min-w-0 max-w-[60%] truncate max-[899px]:max-w-full ${t.unread ? 'font-semibold' : ''}`}>{subject}</span>
          <span className="min-w-0 flex-1 truncate text-muted max-[899px]:hidden">{t.snippet}</span>
        </span>
        {t.hasAttachments && (
          <span className="shrink-0 text-faint" title="Has attachments">
            <Paperclip size={14} strokeWidth={1.75} aria-hidden data-testid="attachment-icon" />
            <span className="sr-only">, has attachments</span>
          </span>
        )}
        <time dateTime={new Date(t.lastMessageAt).toISOString()} title={TOOLTIP.format(t.lastMessageAt)} className="w-16 shrink-0 text-right text-2xs tabular-nums text-faint">
          {formatRowDate(t.lastMessageAt)}
        </time>
      </a>
      {onToggle && (
        <button
          type="button"
          aria-hidden
          tabIndex={-1}
          aria-label={`Select ${subject}`}
          title="Select (x)"
          onClick={(e) => (e.shiftKey ? onExtend ?? onToggle : onToggle)()}
          className={`absolute inset-y-0 left-0 w-7 cursor-pointer items-center pl-1 ${selecting ? 'flex' : 'hidden group-hover:flex'} ${checked ? 'text-accent' : 'text-muted hover:text-fg'}`}
        >
          {checked ? <SquareCheck size={14} strokeWidth={1.75} aria-hidden /> : <Square size={14} strokeWidth={1.75} aria-hidden />}
        </button>
      )}
      {actions.length > 0 && !selecting && (
        <div
          aria-hidden
          className={`absolute inset-y-0 right-0 hidden items-center gap-1 border-b border-b-line pl-2 pr-3 group-hover:flex ${selected ? 'bg-sel' : 'bg-hover'}`}
        >
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              tabIndex={-1}
              aria-label={a.label}
              title={`${a.label} (${a.keyHint})`}
              onClick={a.run}
              className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted hover:bg-bg hover:text-fg"
            >
              <a.icon size={16} strokeWidth={1.75} aria-hidden />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
