import { useEffect, useRef } from 'react';
import { BINDINGS, type KeyContext } from './keymap';

/** Keys that still work while the owner is typing (close the composer, send). */
const ALLOWED_WHILE_TYPING = new Set(['Escape', 'Ctrl+Enter']);

/** Normalizes a keydown into keymap syntax, or null for combinations we never handle (Alt). */
export function keyOf(e: KeyboardEvent): string | null {
  if (e.altKey) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return e.ctrlKey || e.metaKey ? `Ctrl+${key}` : key;
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest('[contenteditable="true"], [contenteditable=""]')) return true;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

/** Controls that Enter activates on their own (a focused link, button or tab keeps its Enter). */
const ACTIVATES_ON_ENTER = 'a[href], button, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemradio"]';

function ownsEnter(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(ACTIVATES_ON_ENTER) !== null;
}

/**
 * Calls `handlers[binding.id]` when a key bound in `ctx` is pressed. Several components can use it at
 * once (each handles only the ids it was given; the first listener that handles a key wins). Keys
 * are ignored while focus is in a text field, except Escape and Ctrl+Enter, and Enter is left to a
 * focused link or button.
 */
export function useShortcuts(ctx: KeyContext, handlers: Partial<Record<string /* Binding.id */, () => void>>): void {
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    const byKey = new Map<string, string>();
    for (const b of BINDINGS) if (b.contexts.includes(ctx)) for (const k of b.keys) byKey.set(k, b.id);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const key = keyOf(e);
      if (key === null) return;
      if (isTyping(e.target) && !ALLOWED_WHILE_TYPING.has(key)) return;
      if (key === 'Enter' && ownsEnter(e.target)) return;
      const id = (e.shiftKey && !e.ctrlKey && !e.metaKey ? byKey.get(`Shift+${key}`) : undefined) ?? byKey.get(key);
      const handler = id === undefined ? undefined : latest.current[id];
      if (!handler) return;
      e.preventDefault();
      handler();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [ctx]);
}
