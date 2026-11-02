import { useEffect, useRef, type MouseEvent, type PointerEvent } from 'react';

/** Movement before a touch counts as a swipe or a scroll: a resting finger trembles. */
const SLOP_PX = 10;
/** Share of the row's width that commits a slow drag. */
const COMMIT_SHARE = 0.25;
/** A quick flick commits from this far, at this speed over the last moments of the swipe: thumbs flick, they don't drag. */
const FLICK_MIN_PX = 48;
const FLICK_PX_PER_MS = 0.4;
const FLICK_WINDOW_MS = 100;
const LONG_PRESS_MS = 450;
/** Android's back gesture starts here. */
const EDGE_PX = 24;
const FLY_MS = 180;
const SPRING_MS = 200;
/** The row stays off screen this long after its action, until the list has caught up. */
const HOLD_MS = 400;
/** How long after the finger lifts its tap can still arrive. */
const LIFT_TAP_MS = 400;

export interface SwipeAction {
  onCommit(): void;
  /** The row comes back instead of leaving: the action only opens a sheet. */
  stays?: boolean;
}

export interface RowGestureOptions {
  /** A swipe towards the right. */
  right?: SwipeAction;
  /** A swipe towards the left. */
  left?: SwipeAction;
  onLongPress(): void;
  /** Selection mode: taps tick rows, and nothing else moves them. */
  disabled?: boolean;
}

type Phase = 'idle' | 'pending' | 'swiping' | 'ignored';

/**
 * Lifting the finger after a long-press still makes a tap, on whatever has opened under it by then: it would close the
 * sheet from its scrim, or run the action under the finger. So the one tap that follows goes nowhere.
 */
function swallowLiftTap(): void {
  let expiry: ReturnType<typeof setTimeout>;
  const stop = () => {
    clearTimeout(expiry);
    window.removeEventListener('click', swallow, true);
    window.removeEventListener('pointerup', lifted, true);
    window.removeEventListener('pointercancel', lifted, true);
  };
  const swallow = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    stop();
  };
  const lifted = () => {
    expiry = setTimeout(stop, LIFT_TAP_MS);
  };
  window.addEventListener('click', swallow, true);
  window.addEventListener('pointerup', lifted, true);
  window.addEventListener('pointercancel', lifted, true);
}

/**
 * Swipes and long-press on a list row, by pointer events and direct style writes so a swipe never renders React. The
 * row needs `touch-action: pan-y`: the browser keeps vertical scrolling, and cancels the pointer when it takes over.
 */
export function useRowGestures({ right, left, onLongPress, disabled = false }: RowGestureOptions) {
  const frameRef = useRef<HTMLDivElement>(null);
  const revealRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLAnchorElement>(null);
  const latest = useRef({ right, left, onLongPress });
  latest.current = { right, left, onLongPress };

  const gesture = useRef({ phase: 'idle' as Phase, id: -1, startX: 0, startY: 0, width: 0, canSwipe: false, armed: false, swallowClick: false, pressed: false });
  /** Recent finger positions while swiping, for the speed at release. */
  const trail = useRef<{ x: number; t: number }[]>([]);
  const press = useRef<ReturnType<typeof setTimeout>>();
  const motion = useRef<ReturnType<typeof setTimeout>>();
  const commit = useRef<(() => void) | null>(null);

  const reveal = (side: 'right' | 'left' | null, armed: boolean) => {
    const el = revealRef.current;
    if (!el) return;
    el.dataset.side = side ?? '';
    el.dataset.armed = String(armed);
  };

  const rest = () => {
    const el = rowRef.current;
    if (el) {
      el.style.transition = '';
      el.style.transform = '';
    }
    reveal(null, false);
  };

  const slide = (to: string, ms: number) => {
    const el = rowRef.current;
    if (!el) return;
    el.style.transition = `transform ${ms}ms ease-out`;
    el.style.transform = to;
  };

  const springBack = () => {
    slide('translateX(0px)', SPRING_MS);
    motion.current = setTimeout(rest, SPRING_MS);
  };

  // A swipe already released still happens if the row goes in the moment it takes to fly off.
  useEffect(
    () => () => {
      clearTimeout(press.current);
      clearTimeout(motion.current);
      commit.current?.();
    },
    [],
  );

  /** Moving fast, and still in the swipe's direction, when the finger lifted. */
  const flicked = (x: number) => {
    const now = performance.now();
    const recent = trail.current.filter((p) => now - p.t <= FLICK_WINDOW_MS);
    const first = recent[0];
    if (!first || Math.abs(x) < FLICK_MIN_PX) return false;
    const speed = (x - first.x) / Math.max(now - first.t, 1);
    return Math.sign(speed) === Math.sign(x) && Math.abs(speed) >= FLICK_PX_PER_MS;
  };

  const release = (x: number) => {
    const g = gesture.current;
    const action = x > 0 ? latest.current.right : latest.current.left;
    if (!(g.armed || flicked(x)) || !action) {
      springBack();
    } else if (action.stays) {
      springBack();
      action.onCommit();
    } else {
      slide(`translateX(${x > 0 ? 100 : -100}%)`, FLY_MS);
      commit.current = () => {
        commit.current = null;
        action.onCommit();
      };
      motion.current = setTimeout(() => {
        commit.current?.();
        motion.current = setTimeout(rest, HOLD_MS);
      }, FLY_MS);
    }
  };

  const follow = (dx: number) => {
    const g = gesture.current;
    const side = dx > 0 ? 'right' : 'left';
    const x = latest.current[side] ? dx : 0;
    const armed = Math.abs(x) >= g.width * COMMIT_SHARE;
    if (armed && !g.armed) navigator.vibrate?.(10);
    g.armed = armed;
    if (rowRef.current) rowRef.current.style.transform = `translateX(${x}px)`;
    reveal(x === 0 ? null : side, armed);
  };

  const handlers = {
    onPointerDown(e: PointerEvent<HTMLElement>) {
      const g = gesture.current;
      g.swallowClick = false;
      g.pressed = false;
      if (disabled || e.pointerType === 'mouse' || !e.isPrimary || g.phase !== 'idle' || commit.current) return;
      clearTimeout(motion.current);
      rest();
      const { right: r, left: l } = latest.current;
      Object.assign(g, {
        phase: 'pending',
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        width: e.currentTarget.getBoundingClientRect().width,
        canSwipe: (r !== undefined || l !== undefined) && e.clientX >= EDGE_PX,
        armed: false,
      });
      press.current = setTimeout(() => {
        g.phase = 'ignored';
        g.pressed = true;
        swallowLiftTap();
        latest.current.onLongPress();
      }, LONG_PRESS_MS);
    },
    onPointerMove(e: PointerEvent<HTMLElement>) {
      const g = gesture.current;
      if (e.pointerId !== g.id) return;
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      if (g.phase === 'swiping') {
        trail.current.push({ x: dx, t: performance.now() });
        follow(dx);
        return;
      }
      if (g.phase !== 'pending' || (Math.abs(dx) < SLOP_PX && Math.abs(dy) < SLOP_PX)) return;
      clearTimeout(press.current);
      if (Math.abs(dx) <= Math.abs(dy) || !g.canSwipe) {
        g.phase = 'ignored';
        return;
      }
      g.phase = 'swiping';
      g.swallowClick = true;
      trail.current = [{ x: dx, t: performance.now() }];
      if (rowRef.current) rowRef.current.style.transition = 'none';
      follow(dx);
    },
    onPointerUp(e: PointerEvent<HTMLElement>) {
      const g = gesture.current;
      if (e.pointerId !== g.id) return;
      clearTimeout(press.current);
      if (g.phase === 'swiping') release(e.clientX - g.startX);
      g.phase = 'idle';
      g.id = -1;
    },
    onPointerCancel(e: PointerEvent<HTMLElement>) {
      const g = gesture.current;
      if (e.pointerId !== g.id) return;
      clearTimeout(press.current);
      if (g.phase === 'swiping') springBack();
      g.phase = 'idle';
      g.id = -1;
    },
    /** Android's own long-press menu never shows. A right-click reaches the same sheet. */
    onContextMenu(e: MouseEvent<HTMLElement>) {
      e.preventDefault();
      const g = gesture.current;
      if (disabled || g.pressed) return;
      clearTimeout(press.current);
      g.pressed = true;
      g.swallowClick = true;
      if (g.phase === 'pending') g.phase = 'ignored';
      latest.current.onLongPress();
    },
    onClickCapture(e: MouseEvent<HTMLElement>) {
      const g = gesture.current;
      if (!g.swallowClick) return;
      g.swallowClick = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };

  return { frameRef, revealRef, rowRef, handlers };
}
