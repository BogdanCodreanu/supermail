import type { LucideIcon } from 'lucide-react';
import { Paperclip, Square, SquareCheck } from 'lucide-react';
import { formatRowDate, rowDomId, senderOf, threadHref, type ThreadRowProps } from '../ThreadRow';
import { useRowGestures, type SwipeAction } from './useRowGestures';
import './phone.css';

/** A swipe on a phone row, and what shows behind the row as it moves. */
export interface PhoneSwipe extends SwipeAction { label: string; icon: LucideIcon; tone: 'done' | 'snooze' }

const TONE = {
  done: { backgroundColor: 'var(--swipe-done)', color: 'var(--on-swipe-done)' },
  snooze: { backgroundColor: 'var(--swipe-snooze)', color: 'var(--on-swipe-snooze)' },
};

function RevealLayer({ side, swipe }: { side: 'right' | 'left'; swipe: PhoneSwipe }) {
  return (
    <div data-testid={`reveal-${side}`} style={TONE[swipe.tone]} className={`swipe-layer absolute inset-0 flex items-center gap-2 px-5 text-sm font-semibold ${side === 'right' ? 'justify-start' : 'justify-end'}`}>
      <swipe.icon size={20} strokeWidth={1.75} aria-hidden className="swipe-icon" />
      {swipe.label}
    </div>
  );
}

/**
 * The row on a phone: sender and time, subject, then snippet with the chip and the paperclip, 72px in all. The whole
 * row opens the email; it swipes (`swipe`) and long-presses (`onLongPress`), and in selection mode a tap ticks it.
 */
export function PhoneRow({ thread: t, accountColor, account, chip, dimmed = false, onSelect, onOpen, href, checked = false, selecting = false, onToggle, swipe, onLongPress, selected }: ThreadRowProps) {
  const bind = (action?: PhoneSwipe) =>
    action && {
      stays: action.stays,
      onCommit() {
        onSelect();
        action.onCommit();
      },
    };
  const gestures = useRowGestures({
    right: bind(swipe?.right),
    left: bind(swipe?.left),
    onLongPress() {
      onSelect();
      onLongPress?.();
    },
    disabled: selecting,
  });
  const Tick = checked ? SquareCheck : Square;

  return (
    <div role="none" className="relative overflow-hidden">
      {swipe && (
        <div ref={gestures.revealRef} data-testid="swipe-reveal" aria-hidden className="swipe-reveal absolute inset-0">
          {swipe.right && <RevealLayer side="right" swipe={swipe.right} />}
          {swipe.left && <RevealLayer side="left" swipe={swipe.left} />}
        </div>
      )}
      <a
        ref={gestures.rowRef}
        {...gestures.handlers}
        id={rowDomId(t.id)}
        role="option"
        aria-selected={selected}
        aria-checked={onToggle ? checked : undefined}
        href={href ?? threadHref(t.id)}
        tabIndex={-1}
        draggable={false}
        data-testid="thread-row"
        data-thread-id={t.id}
        data-unread={t.unread}
        data-done={dimmed || undefined}
        onClick={(e) => {
          e.preventDefault();
          if (selecting) {
            onSelect();
            onToggle?.();
            return;
          }
          onSelect();
          onOpen();
        }}
        className={`relative flex h-[72px] touch-pan-y select-none items-center gap-3 border-b border-l-2 border-b-line pl-3.5 pr-4 text-fg [-webkit-tap-highlight-color:transparent] [-webkit-touch-callout:none] ${
          t.unread ? 'border-l-accent' : 'border-l-transparent'
        } ${checked ? 'bg-sel' : 'bg-bg active:bg-hover'} ${dimmed ? '[&>*]:opacity-60' : ''}`}
      >
        {selecting && (
          <span data-testid="row-checkbox" className={`flex w-6 shrink-0 items-center justify-center ${checked ? 'text-accent' : 'text-muted'}`}>
            <Tick size={20} strokeWidth={1.75} aria-hidden />
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          {t.unread && <span className="sr-only">Unread,</span>}
          <span data-testid="row-line" className="flex min-w-0 items-center gap-2">
            <span data-testid="account-dot" aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: accountColor }} />
            <span data-testid="row-sender" className={`min-w-0 flex-1 truncate text-base leading-5 ${t.unread ? 'font-semibold text-fg' : 'text-muted'}`}>
              {senderOf(t)}
            </span>
            {account && (
              <span data-testid="account-tag" title={`Received at ${account.email}`} className="max-w-20 shrink-0 truncate text-xs" style={{ color: accountColor }}>
                <span className="sr-only">Received at </span>
                {account.label}
              </span>
            )}
            <time dateTime={new Date(t.lastMessageAt).toISOString()} className="shrink-0 text-xs tabular-nums text-muted">
              {formatRowDate(t.lastMessageAt)}
            </time>
          </span>
          <span data-testid="row-line" className={`truncate text-base leading-5 ${t.unread ? 'font-medium text-fg' : 'text-muted'}`}>
            {t.subject || '(no subject)'}
          </span>
          <span data-testid="row-line" className="flex min-w-0 items-center gap-1.5 text-sm leading-[18px] text-muted">
            {chip && (
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded px-1 text-2xs font-semibold"
                style={{ backgroundColor: `color-mix(in srgb, ${chip.color ?? 'var(--faint)'} 18%, transparent)`, color: chip.color ?? 'var(--muted)' }}
              >
                {chip.icon && <chip.icon size={14} strokeWidth={1.75} aria-hidden data-testid="chip-icon" />}
                {chip.label}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">{t.snippet}</span>
            {t.hasAttachments && (
              <span className="shrink-0 text-faint">
                <Paperclip size={14} strokeWidth={1.75} aria-hidden data-testid="attachment-icon" />
                <span className="sr-only">, has attachments</span>
              </span>
            )}
          </span>
        </span>
      </a>
    </div>
  );
}
