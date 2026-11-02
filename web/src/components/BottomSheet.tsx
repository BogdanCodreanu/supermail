import { useEffect, useLayoutEffect, useRef, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useBackLayer } from './phone/backStack';

export interface BottomSheetProps {
  /** The accessible name, and the visible title unless `hideTitle`. */
  label: string;
  hideTitle?: boolean;
  onClose(): void;
  children: ReactNode;
}

/** Dragged down this share of its height, the sheet closes on release. */
const DRAG_CLOSE = 0.3;
const SLIDE_MS = 200;
/** Space kept above the sheet when the keyboard leaves it little room. */
const TOP_GAP = 16;

/**
 * The phone's version of a menu or dialog: slides up from the bottom, above the Android gesture bar and the keyboard.
 * The scrim, dragging the grab handle down and Escape all close it, and the Android back gesture closes it instead of
 * leaving the screen.
 */
export function BottomSheet({ label, hideTitle, onClose, children }: BottomSheetProps) {
  const backdrop = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startY: number; height: number; moved: number } | null>(null);
  const slide = useRef<ReturnType<typeof setTimeout>>();
  const close = useRef(onClose);
  close.current = onClose;
  useBackLayer(true, onClose);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    // A field inside that took focus keeps it: moving it away would close Android's keyboard.
    if (!sheet.current?.contains(document.activeElement)) sheet.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      before?.focus?.();
      clearTimeout(slide.current);
    };
  }, []);

  // Android's keyboard covers the page rather than resizing it, so only the visual viewport knows where it starts.
  useLayoutEffect(() => {
    const view = window.visualViewport;
    if (!view) return;
    const fit = () => {
      if (backdrop.current) backdrop.current.style.bottom = `${Math.max(0, window.innerHeight - view.height - view.offsetTop)}px`;
      if (sheet.current) sheet.current.style.maxHeight = `min(85dvh, ${view.height - TOP_GAP}px)`;
    };
    fit();
    view.addEventListener('resize', fit);
    view.addEventListener('scroll', fit);
    return () => {
      view.removeEventListener('resize', fit);
      view.removeEventListener('scroll', fit);
    };
  }, []);

  const startDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!sheet.current || slide.current !== undefined) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { startY: e.clientY, height: sheet.current.getBoundingClientRect().height, moved: 0 };
    sheet.current.style.transition = 'none';
  };

  const followDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || !sheet.current) return;
    drag.current.moved = Math.max(0, e.clientY - drag.current.startY);
    sheet.current.style.transform = `translateY(${drag.current.moved}px)`;
  };

  /** Slides to its resting place, or off the screen and then closes. */
  const endDrag = (shut: boolean) => {
    const el = sheet.current;
    if (!drag.current || !el) return;
    drag.current = null;
    el.style.transition = `transform ${SLIDE_MS}ms ease-out`;
    el.style.transform = shut ? 'translateY(100%)' : 'translateY(0px)';
    slide.current = setTimeout(() => {
      slide.current = undefined;
      if (shut) {
        close.current();
      } else {
        el.style.transition = '';
        el.style.transform = '';
      }
    }, SLIDE_MS);
  };

  return createPortal(
    <div ref={backdrop} className="fixed inset-0 z-50 flex flex-col justify-end">
      <button type="button" aria-label="Close" tabIndex={-1} onClick={onClose} className="absolute inset-0 cursor-default bg-bg opacity-70" />
      <div
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="relative max-h-[85dvh] overflow-y-auto rounded-t-xl border-t border-line bg-panel pb-[env(safe-area-inset-bottom)] outline-none"
      >
        <div
          data-testid="sheet-handle"
          aria-hidden
          onPointerDown={startDrag}
          onPointerMove={followDrag}
          onPointerUp={() => drag.current && endDrag(drag.current.moved > drag.current.height * DRAG_CLOSE)}
          onPointerCancel={() => endDrag(false)}
          className="sticky top-0 z-10 flex h-11 cursor-grab touch-none items-center justify-center bg-panel"
        >
          <div className="h-1 w-10 rounded-full bg-line" />
        </div>
        {!hideTitle && <h2 className="px-4 pb-1 text-base font-semibold">{label}</h2>}
        {children}
      </div>
    </div>,
    document.body,
  );
}
