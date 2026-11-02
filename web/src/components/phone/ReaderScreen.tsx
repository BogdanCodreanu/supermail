import { ArrowLeft, EllipsisVertical } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

/** How far the finger has to travel before the bar reacts, so a shaky thumb doesn't flicker it. */
const SCROLL_SLOP = 8;

/** True after scrolling down, false after scrolling up or at the top. `resetKey` starts over on a new screen. */
function useHiddenOnScroll(scroller: RefObject<HTMLElement>, resetKey: string): boolean {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = 0;
    setHidden(false);
    let last = 0;
    const onScroll = () => {
      const y = el.scrollTop;
      if (y > 0 && Math.abs(y - last) < SCROLL_SLOP) return;
      setHidden(y > 0 && y > last);
      last = y;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scroller, resetKey]);
  return hidden;
}

const topButton = 'inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted active:bg-hover';

export interface ReaderScreenProps {
  /** One line in the top bar; the view shows it in full in the page. */
  title: string;
  /** The screen's identity: a new one starts at the top. */
  screenKey: string;
  onBack(): void;
  /** The overflow menu, when the screen has one. */
  onMore?(): void;
  /** The fixed bar's buttons. It hides while scrolling down, leaving the page all the height. */
  bar?: ReactNode;
  barLabel?: string;
  children: ReactNode;
}

/** The phone's full-screen reader: a compact top bar, the page, and a bottom action bar above the Android gesture bar. */
export function ReaderScreen({ title, screenKey, onBack, onMore, bar, barLabel, children }: ReaderScreenProps) {
  const scroller = useRef<HTMLElement>(null);
  const hidden = useHiddenOnScroll(scroller, screenKey);
  return (
    <div className="flex h-dvh flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-line bg-bg px-1 pt-[env(safe-area-inset-top)]">
        <div className="flex h-14 min-w-0 flex-1 items-center gap-1">
          <button type="button" aria-label="Back" onClick={onBack} className={topButton}>
            <ArrowLeft size={20} strokeWidth={1.75} aria-hidden />
          </button>
          <span className="min-w-0 flex-1 truncate text-base font-semibold">{title}</span>
          {onMore && (
            <button type="button" aria-label="More actions" onClick={onMore} className={topButton}>
              <EllipsisVertical size={20} strokeWidth={1.75} aria-hidden />
            </button>
          )}
        </div>
      </header>
      <main ref={scroller} className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${bar ? 'pb-[calc(56px+env(safe-area-inset-bottom))]' : 'pb-[env(safe-area-inset-bottom)]'}`}>
        {children}
      </main>
      {bar && (
        <div
          role="toolbar"
          aria-label={barLabel}
          data-bottom-bar
          data-hidden={hidden}
          className={`fixed inset-x-0 bottom-0 z-20 border-t border-line bg-bg pb-[env(safe-area-inset-bottom)] transition-transform duration-200 ease-out ${hidden ? 'translate-y-full' : ''}`}
        >
          <div className="flex h-14 items-center gap-2 px-2">{bar}</div>
        </div>
      )}
    </div>
  );
}
