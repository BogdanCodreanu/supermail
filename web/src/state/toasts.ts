import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { createElement, useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { ActionResult, BulkResult, ServerEvent, ThreadId } from '@supermail/shared';
import { api, qk } from '../api/client';
import { applyServerEvent } from '../api/events';
import { UndoToast } from '../components/UndoToast';
import { OutboxToasts } from './outbox';

// The action toast ("Marked done · Undo"), kept outside the views so it outlives the screen that showed
// it: Done in a thread goes back to the inbox (or on to the next thread) and `z` there still undoes it.
// One <AppToasts /> at the app root draws it, above the send toast (state/outbox).

export interface ToastOptions {
  tone?: 'info' | 'error';
  /** Offers Undo (and `z`) for this server action. */
  undoId?: string;
  /** A follow-up offer, e.g. "Apply to whole domain". */
  action?: { label: string; run(): void };
  /** After Done or snooze moved on: the thread (and list) the thread view returns to when it is undone. */
  restore?: { id: ThreadId; ids?: ThreadId[] };
  /** A bulk action: its undo is one too. */
  bulk?: boolean;
}

export interface AppToast extends ToastOptions {
  key: number;
  message: string;
}

/** What the screen does once an undo went through (select the thread again, open it again). */
export type UndoneHandler = (result: ActionResult, toast: AppToast) => void;

let current: AppToast | null = null;
let seq = 0;
let undoing = false;
const listeners = new Set<() => void>();
// The mounted screens' handlers, newest last: the Undo button acts for the screen on show.
const handlers: { current: UndoneHandler | undefined }[] = [];

function set(next: AppToast | null): void {
  current = next;
  for (const l of listeners) l();
}

/** Shows `message` in place of the current action toast. */
export function showToast(message: string, opts: ToastOptions = {}): void {
  set({ ...opts, message, key: ++seq });
}

/** Closes the toast (only `key` when given, so a late timer never closes a newer toast). */
export function dismissToast(key?: number): void {
  if (current && (key === undefined || current.key === key)) set(null);
}

export function useAppToast(): AppToast | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => current,
  );
}

/** How long a bulk action's undo stays on offer: it is more to take back, and more to look over. */
const BULK_TOAST_MS = 15_000;

/** Words a bulk action, given how many threads it reached: "297 done". */
export type BulkWording = (count: number) => string;
type BulkSettled = Extract<ServerEvent, { type: 'bulk.settled' }>;

// A bulk action answers before Gmail is done, so each one waits here for the `bulk.settled` that says how it went.
const awaiting = new Map<string, { wording: BulkWording; failed: number; offerUndo: boolean }>();
// The event can win the race with the answer; only a failure or a skip has anything to say.
const settledFirst = new Map<string, BulkSettled>();

/** "297 done · 2 failed · 1 skipped: new mail". */
export const withFailed = (text: string, failed: number, skipped = 0) => [text, ...(failed > 0 ? [`${failed} failed`] : []), ...(skipped > 0 ? [`${skipped} skipped: new mail`] : [])].join(' · ');

function showBulkOutcome(wording: BulkWording, undoId: string, landed: number, failed: number, skipped: number, offerUndo: boolean): void {
  showToast(withFailed(wording(landed), failed, skipped), { tone: failed > 0 ? 'error' : 'info', undoId: offerUndo && landed > 0 ? undoId : undefined, bulk: true });
}

/** The toast of a bulk action. It gives way to "297 done · 3 failed" if Gmail refuses some of it. */
export function showBulkToast(wording: BulkWording, r: BulkResult, offerUndo = true): void {
  const first = settledFirst.get(r.undoId);
  settledFirst.delete(r.undoId);
  showBulkOutcome(wording, r.undoId, first?.affected ?? r.affected, r.failed.length + (first?.failed.length ?? 0), first?.skipped.length ?? 0, offerUndo);
  if (!first) awaiting.set(r.undoId, { wording, failed: r.failed.length, offerUndo });
}

export function bulkSettled(e: BulkSettled): void {
  const waiting = awaiting.get(e.undoId);
  if (!waiting) {
    if (e.failed.length > 0 || e.skipped.length > 0) settledFirst.set(e.undoId, e);
    return;
  }
  awaiting.delete(e.undoId);
  if (e.failed.length === 0 && e.skipped.length === 0) return;
  const failed = waiting.failed + e.failed.length;
  const own = current?.undoId === e.undoId;
  // The owner has moved on, and `z` is for what they did last: the news joins that toast and leaves its undo alone.
  if (current?.undoId && !own) set({ ...current, message: withFailed(`${current.message} · ${waiting.wording(e.affected)}`, failed, e.skipped.length), tone: failed > 0 ? 'error' : current.tone });
  else showBulkOutcome(waiting.wording, e.undoId, e.affected, failed, e.skipped.length, waiting.offerUndo && own);
}

/** Undoes the action on the current toast, once; does nothing when it offers no undo. */
export function undoLast(qc: QueryClient, onUndone?: UndoneHandler): void {
  const t = current;
  if (!t?.undoId || undoing) return;
  const undoId = t.undoId;
  undoing = true;
  awaiting.delete(undoId); // whatever Gmail makes of the action now, the owner has moved on from it
  set({ ...t, undoId: undefined });
  api
    .undo(undoId)
    .then(
      (r) => {
        if (r.thread) {
          applyServerEvent(qc, { type: 'thread.updated', thread: r.thread });
          void qc.invalidateQueries({ queryKey: qk.thread(r.thread.id) });
        } else void qc.invalidateQueries({ queryKey: ['threads'] });
        void qc.invalidateQueries({ queryKey: qk.spam() });
        if (t.bulk) showBulkToast((n) => (r.skipped ? `${n} undone · ${r.skipped} skipped` : `${n} undone`), { undoId: r.undoId, affected: r.affected ?? 0, failed: [] }, false);
        else showToast('Undone');
        onUndone?.(r, t);
      },
      (e: unknown) => showToast(`Couldn't undo: ${e instanceof Error ? e.message : String(e)}`, { tone: 'error' }),
    )
    .finally(() => {
      undoing = false;
      void qc.invalidateQueries({ queryKey: ['groups'] });
    });
}

/** The screen's undo (bind it to `z`). While the screen is mounted, the toast's Undo button acts the same. */
export function useUndoLast(onUndone?: UndoneHandler): () => void {
  const qc = useQueryClient();
  const ref = useRef<{ current: UndoneHandler | undefined }>({ current: onUndone });
  ref.current.current = onUndone;
  useEffect(() => {
    const h = ref.current;
    handlers.push(h);
    return () => void handlers.splice(handlers.indexOf(h), 1);
  }, []);
  return useCallback(() => undoLast(qc, ref.current.current), [qc]);
}

/** Test helper: no toast, no undo in flight. */
export function resetToasts(): void {
  undoing = false;
  awaiting.clear();
  settledFirst.clear();
  set(null);
}

/** Every toast, mount once: the send toast (state/outbox) stacked over the action toast. */
export function AppToasts() {
  const qc = useQueryClient();
  const t = useAppToast();
  // UndoToast places itself at the bottom; inside this stack each one flows in a column instead.
  return createElement(
    'div',
    {
      className:
        'pointer-events-none fixed inset-x-4 bottom-[calc(var(--toast-lift)+env(safe-area-inset-bottom))] z-50 flex flex-col gap-2 md:inset-x-auto md:bottom-4 md:left-1/2 md:-translate-x-1/2 md:items-center [&>*]:pointer-events-auto [&>*]:!static md:[&>*]:!translate-x-0',
    },
    createElement(OutboxToasts),
    t &&
      createElement(UndoToast, {
        key: t.key,
        message: t.message,
        tone: t.tone,
        action: t.action,
        duration: t.bulk ? BULK_TOAST_MS : undefined,
        onUndo: t.undoId ? () => undoLast(qc, handlers.at(-1)?.current) : undefined,
        onClose: () => dismissToast(t.key),
      }),
  );
}
