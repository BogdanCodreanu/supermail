import { X } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { useIsPhone } from '../lib/useIsPhone';
import { Kbd } from './Kbd';

export interface UndoToastProps {
  message: string;
  tone?: 'info' | 'error';
  /** Shows the Undo button (the view binds `z` to the same call). */
  onUndo?(): void;
  /** A follow-up offer, e.g. "Apply to whole domain". */
  action?: { label: string; run(): void };
  onClose(): void;
  /** Milliseconds before it closes by itself; the clock stops while it is hovered or focused. */
  duration?: number;
}

const control = 'inline-flex h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center gap-1 rounded px-3 font-semibold hover:underline underline-offset-2 max-md:active:opacity-70 md:h-6 md:min-w-0 md:justify-start md:px-1';

/** How far down a toast has to be dragged to go away; less springs it back. */
const SWIPE_AWAY_PX = 40;

/** Dragging a toast down on the phone: it follows the finger, and past the mark it is dismissed. */
function useSwipeDown(enabled: boolean, onDismiss: () => void) {
  const from = useRef<number | null>(null);
  const [drag, setDrag] = useState(0);
  const end = (dismiss: boolean) => {
    from.current = null;
    setDrag(0);
    if (dismiss) onDismiss();
  };
  return {
    drag,
    handlers: {
      onPointerDown: (e: PointerEvent<HTMLElement>) => {
        if (!enabled || (e.target as Element).closest('button')) return;
        from.current = e.clientY;
        e.currentTarget.setPointerCapture?.(e.pointerId);
      },
      onPointerMove: (e: PointerEvent<HTMLElement>) => {
        if (from.current !== null) setDrag(Math.max(0, e.clientY - from.current));
      },
      onPointerUp: () => from.current !== null && end(drag >= SWIPE_AWAY_PX),
      onPointerCancel: () => from.current !== null && end(false),
    },
  };
}

/**
 * The toast after an action: undo with `z` until it closes, 5 s by default, plus an optional follow-up. Errors are alerts,
 * everything else a polite status. Re-mount it (key) per action. On the phone it spans the screen above the bottom bar or
 * the compose button, and swipes down to dismiss.
 */
export function UndoToast({ message, tone = 'info', onUndo, action, onClose, duration = 5_000 }: UndoToastProps) {
  const close = useRef(onClose);
  close.current = onClose;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const phone = useIsPhone();
  const { drag, handlers } = useSwipeDown(phone, () => close.current());
  const paused = hovered || focused || drag > 0;
  const left = useRef(duration);

  useEffect(() => {
    if (paused) return;
    const started = Date.now();
    const t = setTimeout(() => close.current(), left.current);
    return () => {
      clearTimeout(t);
      left.current = Math.max(0, left.current - (Date.now() - started));
    };
  }, [paused]);

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      // A tap sends mouse events too, and no mouseleave after it: only a real mouse hovers.
      onMouseEnter={() => setHovered(!phone)}
      onMouseLeave={() => setHovered(false)}
      {...handlers}
      style={drag > 0 ? { transform: `translateY(${drag}px)`, opacity: Math.max(0, 1 - drag / (SWIPE_AWAY_PX * 3)) } : undefined}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      className={`fixed inset-x-4 bottom-[calc(var(--toast-lift)+env(safe-area-inset-bottom))] z-50 flex touch-none items-center gap-2 rounded-lg py-1 pl-4 pr-1 text-sm shadow-lg md:inset-x-auto md:bottom-4 md:left-1/2 md:max-w-[calc(100vw-32px)] md:-translate-x-1/2 md:touch-auto md:gap-3 md:rounded-md md:text-xs ${drag > 0 ? '' : 'max-md:transition-[transform,opacity] max-md:duration-150 max-md:ease-out'} ${tone === 'error' ? 'bg-danger text-bg' : 'bg-fg text-bg'}`}
    >
      <span className="min-w-0 flex-1 max-md:line-clamp-2 md:flex-initial md:truncate">{message}</span>
      {action && (
        <button type="button" onClick={action.run} className={control}>
          {action.label}
        </button>
      )}
      {onUndo && (
        <button type="button" onClick={onUndo} className={`${control} gap-2`}>
          Undo {!phone && <Kbd k="z" />}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={onClose}
        className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded opacity-70 hover:opacity-100 max-md:active:opacity-100 md:h-6 md:w-6"
      >
        <X size={14} strokeWidth={1.75} aria-hidden className="h-5 w-5 md:h-3.5 md:w-3.5" />
      </button>
    </div>
  );
}
