import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useIsPhone } from '../lib/useIsPhone';
import { BottomSheet } from './BottomSheet';
import { Kbd } from './Kbd';

export interface ConfirmDialogProps {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` for destructive confirms (Discard, Delete). */
  tone?: 'default' | 'danger';
  onConfirm(): void;
  onCancel(): void;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * An in-app replacement for window.confirm: a modal dialog that traps focus, confirms on Enter and
 * cancels on Escape or a click outside. Focus goes back where it was when it closes. Render it only
 * while it is open. On the phone it is a bottom sheet.
 */
export function ConfirmDialog({ title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', tone = 'default', onConfirm, onCancel }: ConfirmDialogProps) {
  const titleId = useId();
  const bodyId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const confirmBtn = useRef<HTMLButtonElement>(null);
  const phone = useIsPhone();

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    confirmBtn.current?.focus();
    return () => before?.focus();
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // Nothing behind the dialog reacts to keys while it is open (Esc would close the composer too).
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    } else if (e.key === 'Enter') {
      // Enter on another focused button (Cancel) activates that button instead.
      const onOtherButton = e.target instanceof HTMLButtonElement && e.target !== confirmBtn.current;
      if (onOtherButton) return;
      e.preventDefault();
      onConfirm();
    } else if (e.key === 'Tab') {
      const nodes = Array.from(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      const inside = nodes.includes(document.activeElement as HTMLElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const confirmTone = tone === 'danger' ? 'bg-danger text-bg' : 'bg-accent text-on-accent';

  if (phone) {
    return (
      <BottomSheet label={title} onClose={onCancel}>
        {message && <div className="px-4 text-sm text-muted">{message}</div>}
        <div className="flex flex-col gap-2 p-4">
          <button type="button" onClick={onConfirm} className={`h-12 w-full cursor-pointer rounded-lg text-base font-medium active:opacity-80 ${confirmTone}`}>
            {confirmLabel}
          </button>
          <button type="button" onClick={onCancel} className="h-12 w-full cursor-pointer rounded-lg text-base text-muted active:bg-hover">
            {cancelLabel}
          </button>
        </div>
      </BottomSheet>
    );
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" onKeyDown={onKeyDown}>
      <div aria-hidden="true" className="absolute inset-0 bg-fg opacity-20" onMouseDown={onCancel} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={message ? bodyId : undefined}
        className="relative w-full max-w-sm rounded-md border border-line bg-bg p-4 shadow-lg"
      >
        <h2 id={titleId} className="text-base font-semibold">
          {title}
        </h2>
        {message && (
          <div id={bodyId} className="mt-1 text-sm text-muted">
            {message}
          </div>
        )}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex h-8 cursor-pointer items-center gap-2 rounded px-3 text-sm text-muted transition-colors duration-150 ease-out hover:bg-hover hover:text-fg"
          >
            {cancelLabel} <Kbd k="Escape" />
          </button>
          <button
            ref={confirmBtn}
            type="button"
            onClick={onConfirm}
            className={`flex h-8 cursor-pointer items-center gap-2 rounded px-3 text-sm font-medium transition-opacity duration-150 ease-out hover:opacity-90 ${confirmTone}`}
          >
            {confirmLabel} <Kbd k="Enter" />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
