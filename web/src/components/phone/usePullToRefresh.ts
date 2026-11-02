import { useEffect, useRef, useState, type RefObject } from 'react';

/** The indicator moves this share of the finger's travel. */
const RESIST = 0.5;
const ARM_PX = 64;
const MAX_PX = 96;
/** Where the indicator rests off screen, and where it rests to speak. */
const HIDDEN_Y = -48;
const SHOWN_Y = 8;
const UPDATED_MS = 1_500;
const FAILED_MS = 4_000;

export type PullState = 'idle' | 'pulling' | 'armed' | 'updating' | 'updated' | 'failed';

export const PULL_LABEL: Record<PullState, string> = {
  idle: '',
  pulling: 'Pull to refresh',
  armed: 'Release to refresh',
  updating: 'Updating…',
  updated: 'Updated',
  failed: "Couldn't update. Pull to try again",
};

export interface PullOptions {
  /** Where a pull can start. */
  areaRef: RefObject<HTMLElement>;
  /** The list: a pull starts only at its top. */
  scrollRef: RefObject<HTMLElement>;
  disabled: boolean;
  /** Resolves true when the list came back. */
  onRefresh(): Promise<boolean>;
}

/**
 * Pull down at the top of the list to refetch it. Touch events, not pointer events: the rows are `touch-action: pan-y`,
 * so the browser cancels the pointer as soon as it starts panning, and only a touchmove can still stop that.
 */
export function usePullToRefresh({ areaRef, scrollRef, disabled, onRefresh }: PullOptions) {
  const indicatorRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<PullState>('idle');
  const latest = useRef({ disabled, onRefresh, state });
  latest.current = { disabled, onRefresh, state };

  const place = (y: number, animate: boolean) => {
    const el = indicatorRef.current;
    if (!el) return;
    el.style.transition = animate ? 'transform 200ms ease-out' : 'none';
    el.style.transform = `translateY(${y}px)`;
  };

  useEffect(() => {
    if (state === 'updating' || state === 'updated' || state === 'failed') place(SHOWN_Y, true);
    else if (state === 'idle') place(HIDDEN_Y, true);
    if (state !== 'updated' && state !== 'failed') return;
    const t = setTimeout(() => setState('idle'), state === 'updated' ? UPDATED_MS : FAILED_MS);
    return () => clearTimeout(t);
  }, [state]);

  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    let start: { x: number; y: number } | null = null;
    let pulling = false;
    let armed = false;

    const onStart = (e: TouchEvent) => {
      const busy = latest.current.state === 'updating';
      const atTop = (scrollRef.current?.scrollTop ?? 0) <= 0;
      start = e.touches.length === 1 && !latest.current.disabled && !busy && atTop ? { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY } : null;
      pulling = false;
      armed = false;
    };

    const onMove = (e: TouchEvent) => {
      if (!start) return;
      const dx = e.touches[0]!.clientX - start.x;
      const dy = e.touches[0]!.clientY - start.y;
      if (!pulling) {
        // Up scrolls the list, and sideways is a row's swipe.
        if (dy <= 0 || Math.abs(dx) >= dy) {
          start = null;
          return;
        }
        pulling = true;
      }
      e.preventDefault();
      const travel = Math.min(MAX_PX, Math.max(0, dy) * RESIST);
      armed = travel >= ARM_PX;
      place(HIDDEN_Y + travel, false);
      setState(armed ? 'armed' : 'pulling');
    };

    const onEnd = () => {
      if (!pulling) return;
      pulling = false;
      start = null;
      if (!armed) {
        setState('idle');
        return;
      }
      setState('updating');
      void latest.current.onRefresh().then(
        (ok) => setState(ok ? 'updated' : 'failed'),
        () => setState('failed'),
      );
    };

    area.addEventListener('touchstart', onStart, { passive: true });
    area.addEventListener('touchmove', onMove, { passive: false });
    area.addEventListener('touchend', onEnd);
    area.addEventListener('touchcancel', onEnd);
    return () => {
      area.removeEventListener('touchstart', onStart);
      area.removeEventListener('touchmove', onMove);
      area.removeEventListener('touchend', onEnd);
      area.removeEventListener('touchcancel', onEnd);
    };
  }, [areaRef, scrollRef]);

  return { state, indicatorRef };
}
