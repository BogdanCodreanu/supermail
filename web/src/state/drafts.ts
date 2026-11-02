// Composer drafts, autosaved per mode and thread (`reply:a:t1`, `new:`). They are mirrored to
// localStorage when it is available; storage can throw (private windows, blocked site data, a full
// quota), and the in-memory copy keeps the draft for this tab then.

export type DraftMode = 'new' | 'reply' | 'replyAll' | 'forward';

export interface StoredDraft {
  /** One id per composing session, so a late send result never clears a newer draft. */
  id: string;
  accountId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  replyToMessageId?: string;
  savedAt: number;
}

const PREFIX = 'sm.draft.';
const memory = new Map<string, StoredDraft>();

export function draftKey(mode: DraftMode, threadId?: string | null): string {
  return `${mode}:${threadId ?? ''}`;
}

export function newDraftId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

function decode(raw: string | null): StoredDraft | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<StoredDraft>;
    if (typeof d.id !== 'string' || typeof d.accountId !== 'string' || typeof d.subject !== 'string' || typeof d.text !== 'string') return null;
    if (!strings(d.to) || !strings(d.cc) || !strings(d.bcc)) return null;
    return {
      id: d.id,
      accountId: d.accountId,
      to: d.to,
      cc: d.cc,
      bcc: d.bcc,
      subject: d.subject,
      text: d.text,
      ...(typeof d.replyToMessageId === 'string' ? { replyToMessageId: d.replyToMessageId } : {}),
      savedAt: typeof d.savedAt === 'number' ? d.savedAt : 0,
    };
  } catch {
    return null;
  }
}

export function loadDraft(key: string): StoredDraft | null {
  const mem = memory.get(key);
  if (mem) return mem;
  try {
    return decode(localStorage.getItem(PREFIX + key));
  } catch {
    return null;
  }
}

/** Saves the draft. Returns false when only the in-memory copy could be kept. */
export function saveDraft(key: string, draft: StoredDraft): boolean {
  memory.set(key, draft);
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

/** Removes the draft; with `id`, only when the stored draft is still that one. */
export function clearDraft(key: string, id?: string): void {
  if (id !== undefined && loadDraft(key)?.id !== id) return;
  memory.delete(key);
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // nothing stored to remove
  }
}

/** Test helper: forgets the in-memory copies. */
export function resetDrafts(): void {
  memory.clear();
}
