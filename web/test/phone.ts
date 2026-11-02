import { fireEvent } from '@testing-library/react';
import { vi } from 'vitest';

/** The phone layout: every `max-width` query at or above this width matches, as on a real screen. */
export function stubPhone(width = 360): void {
  vi.stubGlobal('matchMedia', (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    return {
      matches: max ? width <= Number(max[1]) : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });
}

const touch = (x: number, y: number) => ({ pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y });

/** A finger across `el`; the row is treated as `width` wide. */
export function swipe(el: Element, from: number, to: number, y = 100): void {
  fireEvent.pointerDown(el, touch(from, y));
  fireEvent.pointerMove(el, touch(from + Math.sign(to - from) * 40, y));
  fireEvent.pointerMove(el, touch(to, y));
  fireEvent.pointerUp(el, touch(to, y));
}

export const pressDown = (el: Element, x = 200, y = 100) => fireEvent.pointerDown(el, touch(x, y));
export const pressUp = (el: Element, x = 200, y = 100) => fireEvent.pointerUp(el, touch(x, y));

/** The end of a long-press, as Chrome delivers it: the pointer lifts, then a tap lands on whatever is under the finger. */
export function liftAfterLongPress(el: Element): void {
  pressUp(el);
  fireEvent.click(document.body);
}

/** Gives every element a width, which jsdom's layout leaves at 0. */
export function stubRowWidth(width = 360): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width, left: 0, right: width, top: 0, bottom: 72, height: 72, x: 0, y: 0, toJSON: () => ({}) });
}

/** A real touch event: pull to refresh needs touches, because the browser cancels the pointer once it pans. */
export function touchAt(el: Element, type: 'touchstart' | 'touchmove' | 'touchend', y: number): TouchEvent {
  const e = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
  const list = type === 'touchend' ? [] : [{ identifier: 1, clientX: 180, clientY: y }];
  Object.defineProperty(e, 'touches', { value: list });
  el.dispatchEvent(e);
  return e;
}
