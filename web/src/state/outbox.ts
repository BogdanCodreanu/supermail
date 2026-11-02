import { createElement, useEffect, useSyncExternalStore } from 'react';
import type { SendRequest } from '@supermail/shared';
import { api } from '../api/client';
import { UndoToast } from '../components/UndoToast';
import { clearDraft, saveDraft, type DraftMode, type StoredDraft } from './drafts';

// Undo send. The composer closes at once and hands its message here; the message waits UNDO_SEND_MS
// (Undo puts the draft back and reopens the composer), then goes to api.send. It lives outside React
// so it survives the composer unmounting. <OutboxToasts /> shows the newest item; it uses no router
// hooks, so it can be mounted anywhere once.

export const UNDO_SEND_MS = 5_000;

export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'failed';

export interface OutboxItem {
  id: string;
  status: OutboxStatus;
  req: SendRequest;
  draftKey: string;
  draft: StoredDraft;
  error?: string;
}

export interface QueueSendInput {
  req: SendRequest;
  draftKey: string;
  draft: StoredDraft;
  /** Opens the composer again; the draft is back in the drafts store by then. */
  reopen(): void;
  onSent?(threadId: string): void;
}

interface Entry extends OutboxItem {
  reopen(): void;
  onSent?(threadId: string): void;
  timer?: ReturnType<typeof setTimeout>;
}

let entries: Entry[] = [];
let snapshot: OutboxItem[] = [];
const listeners = new Set<() => void>();
let seq = 0;

function publish(): void {
  snapshot = entries.map(({ id, status, req, draftKey, draft, error }) => ({ id, status, req, draftKey, draft, ...(error ? { error } : {}) }));
  syncUnloadGuard();
  for (const l of listeners) l();
}

function update(id: string, patch: Partial<Entry>): Entry | undefined {
  const e = entries.find((x) => x.id === id);
  if (!e) return undefined;
  Object.assign(e, patch);
  publish();
  return e;
}

function remove(id: string): void {
  const e = entries.find((x) => x.id === id);
  if (e?.timer) clearTimeout(e.timer);
  entries = entries.filter((x) => x.id !== id);
  publish();
}

function deliver(id: string): void {
  const e = entries.find((x) => x.id === id);
  if (!e || (e.status !== 'pending' && e.status !== 'failed')) return;
  if (e.timer) clearTimeout(e.timer);
  update(id, { status: 'sending', timer: undefined, error: undefined });
  api.send(e.req).then(
    (r) => {
      clearDraft(e.draftKey, e.draft.id);
      update(id, { status: 'sent' });
      e.onSent?.(r.threadId);
    },
    (err: unknown) => {
      // Keep the draft: opening the composer again brings it back.
      saveDraft(e.draftKey, e.draft);
      update(id, { status: 'failed', error: err instanceof Error ? err.message : 'Sending failed.' });
    },
  );
}

/** Queues a message; it is sent after UNDO_SEND_MS unless undone. Returns the outbox id. */
export function queueSend(input: QueueSendInput): string {
  const id = `send-${++seq}`;
  const entry: Entry = { id, status: 'pending', req: input.req, draftKey: input.draftKey, draft: input.draft, reopen: input.reopen, onSent: input.onSent };
  entry.timer = setTimeout(() => deliver(id), UNDO_SEND_MS);
  // While it waits, the draft is not in the drafts store, so a new composer starts empty.
  clearDraft(input.draftKey, input.draft.id);
  entries = [...entries, entry];
  publish();
  return id;
}

/** Cancels a waiting send, puts its draft back and reopens the composer. */
export function undoSend(id: string): void {
  const e = entries.find((x) => x.id === id);
  if (!e || e.status !== 'pending') return;
  remove(id);
  saveDraft(e.draftKey, e.draft);
  e.reopen();
}

/** Sends a waiting message now (the toast was dismissed). */
export function sendNow(id: string): void {
  deliver(id);
}

/** Sends a failed message again. */
export function retrySend(id: string): void {
  const e = entries.find((x) => x.id === id);
  if (e?.status === 'failed') deliver(id);
}

export function dismissSend(id: string): void {
  const e = entries.find((x) => x.id === id);
  if (e && (e.status === 'sent' || e.status === 'failed')) remove(id);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

const getSnapshot = () => snapshot;

export function useOutbox(): OutboxItem[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Test helper: drops every item and timer. */
export function resetOutbox(): void {
  for (const e of entries) if (e.timer) clearTimeout(e.timer);
  entries = [];
  reopenRequest = null;
  publish();
}

// Leaving the page while a message waits would drop it: put its draft back (so it is not lost if the
// owner leaves anyway) and ask the browser to confirm.
let unloadBound = false;
function onBeforeUnload(ev: BeforeUnloadEvent): void {
  const waiting = entries.filter((e) => e.status === 'pending' || e.status === 'sending');
  if (waiting.length === 0) return;
  for (const e of waiting) saveDraft(e.draftKey, e.draft);
  ev.preventDefault();
  ev.returnValue = '';
}
function syncUnloadGuard(): void {
  const need = entries.some((e) => e.status === 'pending' || e.status === 'sending');
  if (need === unloadBound || typeof window === 'undefined') return;
  unloadBound = need;
  if (need) window.addEventListener('beforeunload', onBeforeUnload);
  else window.removeEventListener('beforeunload', onBeforeUnload);
}

// An inline composer (under a thread) can't be reopened by URL alone: Undo leaves a request here that
// the thread view reads with useReopenRequest and clears once its composer is open again.
export interface ReopenRequest { mode: DraftMode; threadId: string | null }
let reopenRequest: ReopenRequest | null = null;
const reopenListeners = new Set<() => void>();

export function requestReopen(r: ReopenRequest | null): void {
  reopenRequest = r;
  for (const l of reopenListeners) l();
}

export function useReopenRequest(): ReopenRequest | null {
  return useSyncExternalStore(
    (l) => {
      reopenListeners.add(l);
      return () => reopenListeners.delete(l);
    },
    () => reopenRequest,
    () => reopenRequest,
  );
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

const MESSAGES: Record<OutboxStatus, string> = { pending: 'Sending…', sending: 'Sending…', sent: 'Sent', failed: "Couldn't send. Your draft is saved." };

/** The send toast: "Sending… Undo" (also `z`), then "Sent", or an error with Retry. Mount once. */
export function OutboxToasts() {
  const items = useOutbox();
  const top = items.at(-1);
  const pendingId = top?.status === 'pending' ? top.id : null;

  // `z` undoes the send. Capture phase, so the view's own `z` (undo the last thread action) doesn't also run.
  useEffect(() => {
    if (pendingId === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'z' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || isTyping(e.target)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      undoSend(pendingId);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pendingId]);

  if (!top) return null;
  const id = top.id;
  switch (top.status) {
    case 'pending':
    case 'sending':
      return createElement(UndoToast, {
        key: `${id}:pending`,
        message: MESSAGES.pending,
        onUndo: top.status === 'pending' ? () => undoSend(id) : undefined,
        // The outbox timer sends; closing the toast early just sends sooner.
        onClose: () => sendNow(id),
        duration: UNDO_SEND_MS + 60_000,
      });
    case 'sent':
      return createElement(UndoToast, { key: `${id}:sent`, message: MESSAGES.sent, onClose: () => dismissSend(id), duration: 3_000 });
    case 'failed':
      return createElement(UndoToast, {
        key: `${id}:failed`,
        tone: 'error',
        message: top.error ? `${MESSAGES.failed} ${top.error}` : MESSAGES.failed,
        action: { label: 'Retry', run: () => retrySend(id) },
        onClose: () => dismissSend(id),
        duration: 30_000,
      });
  }
}
