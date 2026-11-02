import { Pencil } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

/** Scrolling less than this is a finger settling, not a change of direction. */
const JITTER_PX = 8;

/** Hidden while the list scrolls down, back as soon as it scrolls up. */
export function useHideOnScroll() {
  const [hidden, setHidden] = useState(false);
  const last = useRef(0);
  const onScroll = useCallback((top: number) => {
    if (Math.abs(top - last.current) < JITTER_PX) return;
    setHidden(top > last.current && top > 0);
    last.current = top;
  }, []);
  return { hidden, onScroll };
}

export function ComposeFab({ hidden }: { hidden: boolean }) {
  return (
    <Link
      to="/compose"
      aria-label="Compose"
      aria-hidden={hidden || undefined}
      tabIndex={hidden ? -1 : undefined}
      className={`absolute bottom-[calc(16px+env(safe-area-inset-bottom))] right-4 z-20 inline-flex h-14 w-14 touch-manipulation items-center justify-center rounded-full bg-accent text-on-accent shadow-lg transition duration-200 ease-out active:opacity-80 ${
        hidden ? 'pointer-events-none translate-y-24 opacity-0' : ''
      }`}
    >
      <Pencil size={20} strokeWidth={1.75} aria-hidden />
    </Link>
  );
}
