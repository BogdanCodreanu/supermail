import { useEffect, useState } from 'react';

/** What the keyboard leaves of the screen: where it starts and how tall it is, and the height of the keyboard itself. */
export interface VisibleArea { top: number; height: number; keyboard: number }

function read(): VisibleArea | null {
  const v = window.visualViewport;
  if (!v) return null;
  return { top: v.offsetTop, height: v.height, keyboard: Math.max(0, window.innerHeight - v.height - v.offsetTop) };
}

/**
 * Follows the visible part of the screen. Android's keyboard shrinks only the visual viewport, so anything fixed to the
 * bottom would slide under it. Null where the browser has no visualViewport, and CSS (`dvh`) is all there is.
 */
export function useVisualViewport(): VisibleArea | null {
  const [area, setArea] = useState(read);
  useEffect(() => {
    const v = window.visualViewport;
    if (!v) return;
    const update = () => setArea(read());
    update();
    v.addEventListener('resize', update);
    v.addEventListener('scroll', update);
    return () => {
      v.removeEventListener('resize', update);
      v.removeEventListener('scroll', update);
    };
  }, []);
  return area;
}
