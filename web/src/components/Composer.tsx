import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Send, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type { AccountDTO, AddressDTO, MessageDTO, SendRequest, ThreadDetailDTO } from '@supermail/shared';
import { api, qk } from '../api/client';
import { useShortcuts } from '../keys/useShortcuts';
import { useIsPhone } from '../lib/useIsPhone';
import { useVisualViewport } from '../lib/useVisualViewport';
import { clearDraft, draftKey, loadDraft, newDraftId, saveDraft, type StoredDraft } from '../state/drafts';
import { queueSend, requestReopen } from '../state/outbox';
import { ConfirmDialog } from './ConfirmDialog';
import { Kbd } from './Kbd';
import { offline, RetryButton, waitingForNetwork } from './LoadFailure';
import { useBackLayer } from './phone/backStack';
import { isValidRecipient, parseRecipients, RecipientInput, type RecipientInputHandle } from './RecipientInput';

export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward';
export interface Draft { to: string[]; cc: string[]; bcc: string[]; subject: string; text: string; replyToMessageId?: string }

export interface ComposerProps {
  mode: ComposeMode;
  threadId?: string;
  /** Answer this message instead of the latest one from someone else. */
  replyToMessageId?: string;
  /** The preferred From account for a new message (replies always go out from the thread's account). */
  accountId?: string;
  onClose(): void;
  onSent?(threadId: string): void;
  autoFocus?: boolean;
  variant?: 'page' | 'inline';
}

/** How long typing may go unsaved before the draft is written. */
export const AUTOSAVE_MS = 800;

const RE = /^\s*re\s*:\s*/i;
const FWD = /^\s*(fwd?|fw)\s*:\s*/i;
const TITLES: Record<ComposeMode, string> = { new: 'New message', reply: 'Reply', replyAll: 'Reply all', forward: 'Forward' };

const lower = (a: AddressDTO) => a.email.toLowerCase();

function uniqueEmails(addrs: AddressDTO[], skip: Set<string>): string[] {
  const seen = new Set(skip);
  const out: string[] = [];
  for (const a of addrs) {
    const k = lower(a);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(a.email);
  }
  return out;
}

/**
 * The starting draft for a reply, reply-all or forward. It answers `replyToMessageId` when given,
 * otherwise the latest message not sent by the owner (`own` holds the owner's addresses, lowercased),
 * like the server's default. The body stays empty: the server appends the quoted original.
 */
export function draftFor(detail: ThreadDetailDTO, mode: Exclude<ComposeMode, 'new'>, own: Set<string>, replyToMessageId?: string): Draft {
  const msgs = detail.messages;
  const target: MessageDTO | undefined =
    (replyToMessageId ? msgs.find((m) => m.id === replyToMessageId) : undefined) ?? [...msgs].reverse().find((m) => !own.has(lower(m.from))) ?? msgs.at(-1);
  const base = (target?.subject || detail.thread.subject || '').trim();
  const draft: Draft = { to: [], cc: [], bcc: [], subject: '', text: '', ...(target ? { replyToMessageId: target.id } : {}) };
  if (mode === 'forward') return { ...draft, subject: FWD.test(base) ? base.replace(FWD, 'Fwd: ') : `Fwd: ${base}` };

  const subject = `Re: ${base.replace(RE, '')}`;
  if (!target) return { ...draft, subject };
  const fromOwner = own.has(lower(target.from));
  // Replying to the owner's own last message goes to that message's recipients.
  const primary = fromOwner ? target.to : [target.from];
  if (mode === 'reply') return { ...draft, subject, to: uniqueEmails(primary, own) };
  const to = uniqueEmails([...primary, ...target.to], own);
  const cc = uniqueEmails(target.cc, new Set([...own, ...to.map((e) => e.toLowerCase())]));
  return { ...draft, subject, to, cc };
}

/** The `/compose` URL that opens this composer as a page. */
export function composeUrl(mode: ComposeMode, threadId: string | null): string {
  return threadId && mode !== 'new' ? `/compose?thread=${encodeURIComponent(threadId)}&mode=${mode}` : '/compose';
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Whether `d` holds anything the owner wrote beyond the starting draft. */
function changed(d: Pick<Draft, 'to' | 'cc' | 'bcc' | 'subject' | 'text'>, initial: Draft): boolean {
  return (
    d.text.trim() !== initial.text.trim() ||
    d.subject !== initial.subject ||
    !sameList(d.to, initial.to) ||
    !sameList(d.cc, initial.cc) ||
    !sameList(d.bcc, initial.bcc)
  );
}

// Each field row marks focus with an inset bar on its left edge (the bare inputs inside draw no ring).
const ROW = 'flex shrink-0 items-start gap-2 border-b border-line px-4 md:focus-within:shadow-[inset_2px_0_0_0_var(--ring)]';
const LABEL = 'w-12 shrink-0 pt-3 text-sm text-muted md:pt-2 md:text-xs';
const HEADER_ICON = 'flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted active:bg-hover';

/** The phone's composer: the whole visible screen, which ends at the keyboard. */
function FullScreen({ children }: { children: ReactNode }) {
  const area = useVisualViewport();
  return createPortal(
    <div
      style={area ? { top: area.top, height: area.height } : undefined}
      className="fixed inset-x-0 top-0 z-50 flex h-dvh flex-col bg-bg pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]"
    >
      {children}
    </div>,
    document.body,
  );
}

function Frame({ variant, phone, children }: { variant: 'page' | 'inline'; phone: boolean; children: ReactNode }) {
  if (phone) return <FullScreen>{children}</FullScreen>;
  const card = <div className="rounded-md border border-line bg-bg">{children}</div>;
  return variant === 'page' ? <div className="mx-auto w-full max-w-3xl px-4 py-6">{card}</div> : card;
}

/**
 * The composer, as a page (`/compose`) or inline under a thread. It loads what it needs (accounts,
 * the thread), autosaves the draft, and on send closes at once and hands the message to the outbox
 * (5 s to undo). Esc and Close keep the draft; Discard drops it (asking first when it has content).
 * On the phone either variant fills the screen; over a thread, the back gesture closes it like Close does.
 */
export function Composer(props: ComposerProps): JSX.Element {
  const { mode: rawMode, threadId: rawThreadId, replyToMessageId, accountId, variant = 'page' } = props;
  const threadId = rawMode === 'new' ? null : (rawThreadId ?? null);
  const mode: ComposeMode = threadId ? rawMode : 'new';

  const accounts = useQuery({ queryKey: qk.accounts(), queryFn: api.accounts });
  const detail = useQuery({ queryKey: qk.thread(threadId ?? ''), queryFn: () => api.thread(threadId!), enabled: threadId !== null });
  const phone = useIsPhone();
  const pending = accounts.isPending || (threadId !== null && detail.isPending);
  const failed = accounts.isError || (threadId !== null && detail.isError);
  // The form takes over once it shows.
  useBackLayer(phone && variant === 'inline' && (pending || failed), props.onClose);

  const backOut = phone && (
    <button type="button" aria-label="Close" onClick={props.onClose} className={HEADER_ICON}>
      <X size={20} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
  if (pending) {
    const stalled = waitingForNetwork(accounts) || (threadId !== null && waitingForNetwork(detail));
    return (
      <Frame variant={variant} phone={phone}>
        {backOut}
        <div className="p-4 text-muted">{stalled ? offline('the composer') : 'Loading…'}</div>
      </Frame>
    );
  }
  if (failed) {
    return (
      <Frame variant={variant} phone={phone}>
        {backOut}
        <div className="p-4 text-muted">
          Couldn't load {accounts.isError ? 'your accounts' : 'this thread'}. <RetryButton onRetry={() => void (accounts.isError ? accounts.refetch() : detail.refetch())} />
        </div>
      </Frame>
    );
  }

  const list = accounts.data;
  const own = new Set(list.map((a) => a.email.toLowerCase()));
  const initial: Draft = mode === 'new' || !detail.data ? { to: [], cc: [], bcc: [], subject: '', text: '' } : draftFor(detail.data, mode, own, replyToMessageId);
  const fixedAccountId = detail.data?.thread.accountId ?? null;
  const defaultAccount = list.find((a) => a.id === accountId)?.id ?? list[0]?.id ?? '';
  const key = draftKey(mode, threadId);
  return (
    <ComposerForm
      key={key}
      {...props}
      mode={mode}
      threadId={threadId}
      variant={variant}
      draftKey={key}
      accounts={list}
      own={own}
      fixedAccountId={fixedAccountId}
      initialAccountId={defaultAccount}
      initial={initial}
    />
  );
}

interface FormProps extends Omit<ComposerProps, 'threadId' | 'variant'> {
  threadId: string | null;
  variant: 'page' | 'inline';
  draftKey: string;
  accounts: AccountDTO[];
  own: Set<string>;
  fixedAccountId: string | null;
  initialAccountId: string;
  initial: Draft;
}

type SaveState = 'idle' | 'restored' | 'pending' | 'saved' | 'failed';

function ComposerForm({
  mode,
  threadId,
  variant,
  draftKey: key,
  accounts,
  own,
  fixedAccountId,
  initialAccountId,
  initial,
  onClose,
  onSent,
  autoFocus = true,
}: FormProps) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const phone = useIsPhone();
  const [restored] = useState(() => loadDraft(key));
  const start = restored ?? { ...initial, accountId: initialAccountId };
  const draftId = useRef(restored?.id ?? newDraftId());
  const replyTo = restored?.replyToMessageId ?? initial.replyToMessageId;

  const [chosenAccount, setAccountId] = useState(start.accountId || initialAccountId);
  const accountId = fixedAccountId ?? chosenAccount;
  const [to, setTo] = useState(start.to);
  const [cc, setCc] = useState(start.cc);
  const [bcc, setBcc] = useState(start.bcc);
  const [pending, setPending] = useState({ to: '', cc: '', bcc: '' });
  const [showCopies, setShowCopies] = useState(start.cc.length > 0 || start.bcc.length > 0);
  const [subject, setSubject] = useState(start.subject);
  const [text, setText] = useState(start.text);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>(restored ? 'restored' : 'idle');
  // Refs, not state: two Ctrl+Enter presses in one tick must still send once, and once the composer
  // is closed (sent, discarded) nothing may save the draft again.
  const inFlight = useRef(false);
  const closed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputs = { to: useRef<RecipientInputHandle>(null), cc: useRef<RecipientInputHandle>(null), bcc: useRef<RecipientInputHandle>(null) };
  const body = useRef<HTMLTextAreaElement>(null);

  const all = (values: string[], typed: string) => [...values, ...parseRecipients(typed)];
  const current = { to: all(to, pending.to), cc: all(cc, pending.cc), bcc: all(bcc, pending.bcc), subject, text };
  const dirty = changed(current, initial);

  const snapshot = (): StoredDraft => ({
    id: draftId.current,
    accountId,
    ...current,
    ...(replyTo ? { replyToMessageId: replyTo } : {}),
    savedAt: Date.now(),
  });
  // Timers, unload and unmount read the latest values through this ref.
  const latest = useRef({ snapshot, dirty });
  latest.current = { snapshot, dirty };

  /** Writes the draft now (or forgets it when nothing was written). Returns false if storage failed. */
  const flush = useCallback(
    (fromUnmount = false): boolean => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (closed.current) return true;
      const { snapshot: snap, dirty: isDirty } = latest.current;
      if (!isDirty) {
        clearDraft(key, draftId.current);
        if (!fromUnmount) setSaveState('idle');
        return true;
      }
      const ok = saveDraft(key, snap());
      if (!fromUnmount) setSaveState(ok ? 'saved' : 'failed');
      return ok;
    },
    [key],
  );

  // Autosave: at most AUTOSAVE_MS after any change. Compared by content, so effects that run twice
  // (StrictMode) or re-renders without edits schedule nothing.
  const content = JSON.stringify([to, cc, bcc, pending, subject, text, chosenAccount]);
  const savedContent = useRef(content);
  useEffect(() => {
    if (content === savedContent.current) return;
    savedContent.current = content;
    if (closed.current || timer.current) return;
    setSaveState('pending');
    timer.current = setTimeout(() => flush(), AUTOSAVE_MS);
  }, [content, flush]);

  // Leaving by any route (Back, a link, browser back) unmounts the composer: save what is unsaved.
  useEffect(() => () => void flush(true), [flush]);

  // Reloading or closing the tab: write the pending save first; ask only if it couldn't be stored.
  const unsaved = saveState === 'pending' || (saveState === 'failed' && dirty);
  useEffect(() => {
    if (!unsaved) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (flush(true)) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [unsaved, flush]);

  // The body grows with its text. On the phone it fills the screen instead, and scrolls inside.
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    el.style.height = 'auto';
    if (!phone) el.style.height = `${el.scrollHeight}px`;
  }, [text, phone]);

  const reopen = () => {
    if (variant === 'inline' && threadId) {
      requestReopen({ mode, threadId });
      navigate(`/t/${encodeURIComponent(threadId)}`);
    } else navigate(composeUrl(mode, threadId));
  };

  const send = () => {
    if (inFlight.current || closed.current || confirming) return;
    const req: SendRequest = {
      accountId,
      to: current.to,
      cc: current.cc,
      bcc: current.bcc,
      subject,
      text,
      ...(threadId ? { replyToThreadId: threadId } : {}),
      ...(threadId && replyTo ? { replyToMessageId: replyTo } : {}),
      ...(mode === 'forward' ? { forward: true } : {}),
    };
    const recipients = [...req.to, ...req.cc, ...req.bcc];
    if (recipients.length === 0) {
      setError('Add at least one recipient.');
      return;
    }
    const bad = recipients.find((r) => !isValidRecipient(r));
    if (bad !== undefined) {
      // Show typed text as chips, so the bad one is marked.
      setTo(current.to);
      setCc(current.cc);
      setBcc(current.bcc);
      setPending({ to: '', cc: '', bcc: '' });
      if (current.cc.length || current.bcc.length) setShowCopies(true);
      setError(`“${bad}” isn't a valid email address.`);
      return;
    }
    if (!req.accountId) {
      setError('Connect a Gmail account first.');
      return;
    }
    inFlight.current = true;
    const draft = snapshot();
    closed.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    queueSend({
      req,
      draftKey: key,
      draft,
      reopen,
      onSent: (tid) => {
        void qc.invalidateQueries({ queryKey: qk.thread(tid) });
        onSent?.(tid);
      },
    });
    onClose();
  };

  /** Esc and Close: keep the draft and close. */
  const close = () => {
    if (closed.current || confirming) return;
    flush(true);
    closed.current = true;
    onClose();
  };

  const discardNow = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    clearDraft(key, draftId.current);
    closed.current = true;
    onClose();
  };

  /** Discard: drops the draft, asking first when it has content. */
  const discard = () => {
    if (closed.current) return;
    if (dirty) setConfirming(true);
    else discardNow();
  };

  useShortcuts('compose', { send, back: close });
  // A page is a history entry of its own already.
  useBackLayer(phone && variant === 'inline', close);

  const fixed = fixedAccountId ? accounts.find((a) => a.id === fixedAccountId) : undefined;
  const chooseFrom = !fixedAccountId && accounts.length > 1;
  const from = fixed ?? accounts.find((a) => a.id === accountId);
  const focusTo = autoFocus && (mode === 'new' || mode === 'forward' || start.to.length === 0);

  const field = (name: 'to' | 'cc' | 'bcc', label: string, values: string[], set: (v: string[]) => void, focus = false) => (
    <RecipientInput
      ref={inputs[name]}
      label={label}
      values={values}
      pending={pending[name]}
      onChange={(v) => {
        set(v);
        setError(null);
      }}
      onPending={(v) => setPending((p) => ({ ...p, [name]: v }))}
      exclude={own}
      autoFocus={focus}
    />
  );

  // The phone folds an unused field away, so its label is a way in too.
  const rowLabel = (name: 'to' | 'cc' | 'bcc', text: string) => (
    <span className={LABEL} onClick={() => inputs[name].current?.focus()}>
      {text}
    </span>
  );

  // Inline under a thread, single-key thread shortcuts must not fire from inside the composer.
  const isolateKeys = (e: ReactKeyboardEvent) => {
    if (variant !== 'inline') return;
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) return;
    e.stopPropagation();
  };

  const status =
    saveState === 'restored' ? 'Draft restored' : saveState === 'saved' ? 'Draft saved' : saveState === 'pending' ? 'Saving…' : saveState === 'failed' ? "Draft can't be saved in this browser" : null;

  const sentFrom = !chooseFrom && from && (
    <span className="ml-auto flex min-w-0 items-center gap-2 text-xs text-muted" title="Sending from">
      <span aria-hidden="true" className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: from.color }} />
      <span className="truncate">{from.email}</span>
    </span>
  );
  const statusLine = status && <span className={`text-2xs ${saveState === 'failed' ? 'text-danger' : 'text-faint'}`}>{status}</span>;
  const errorLine = error && (
    <p role="alert" className="px-4 pb-2 text-xs text-danger">
      {error}
    </p>
  );

  return (
    <Frame variant={variant} phone={phone}>
      <div onKeyDown={isolateKeys} aria-label={TITLES[mode]} role="region" className={phone ? 'flex min-h-0 flex-1 flex-col' : undefined}>
        {phone ? (
          <div className="flex h-14 shrink-0 items-center gap-1 border-b border-line px-1">
            <button type="button" aria-label="Close" onClick={close} className={HEADER_ICON}>
              <X size={20} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{TITLES[mode]}</h1>
            <button type="button" aria-label="Discard" onClick={discard} className={HEADER_ICON}>
              <Trash2 size={20} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <button type="button" onClick={send} className="ml-1 mr-2 inline-flex h-11 shrink-0 cursor-pointer items-center gap-2 rounded-lg bg-accent px-4 font-medium text-on-accent active:opacity-80">
              <Send size={20} strokeWidth={1.75} aria-hidden="true" />
              Send
            </button>
          </div>
        ) : (
          <div className="flex h-10 items-center gap-2 border-b border-line pl-4 pr-2">
            {variant === 'page' ? (
              <h1 className="text-base font-semibold">{TITLES[mode]}</h1>
            ) : (
              <h2 className="text-xs font-medium text-muted">{TITLES[mode]}</h2>
            )}
            <button
              type="button"
              aria-label="Close"
              title="Close (Esc). The draft is kept."
              onClick={close}
              className="ml-auto flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted transition-colors duration-150 ease-out hover:bg-hover hover:text-fg"
            >
              <X size={16} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
        )}
        <div className={phone ? 'flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain' : 'contents'}>
        {chooseFrom && (
          <div className={ROW}>
            <span className={LABEL}>From</span>
            <select
              aria-label="From"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="h-11 min-w-0 flex-1 cursor-pointer rounded bg-transparent text-[16px] hover:bg-hover focus-visible:outline-none md:my-1 md:h-6 md:flex-none md:text-sm"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.email}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className={ROW}>
          {rowLabel('to', 'To')}
          {field('to', 'To', to, setTo, focusTo)}
          {!showCopies && (
            <button
              type="button"
              onClick={() => {
                setShowCopies(true);
                setTimeout(() => inputs.cc.current?.focus(), 0);
              }}
              className="h-11 shrink-0 cursor-pointer rounded px-2 text-sm text-muted transition-colors duration-150 ease-out hover:bg-hover hover:text-fg max-md:active:bg-hover md:mt-1 md:h-6 md:text-xs"
            >
              Cc Bcc
            </button>
          )}
        </div>
        {showCopies && (
          <div className={ROW}>
            {rowLabel('cc', 'Cc')}
            {field('cc', 'Cc', cc, setCc)}
          </div>
        )}
        {showCopies && (
          <div className={ROW}>
            {rowLabel('bcc', 'Bcc')}
            {field('bcc', 'Bcc', bcc, setBcc)}
          </div>
        )}
        <div className={ROW}>
          <input
            aria-label="Subject"
            placeholder="Subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="h-11 min-w-0 flex-1 bg-transparent text-[16px] font-medium placeholder:text-faint focus-visible:outline-none md:h-10 md:text-sm"
          />
        </div>
        <div className={`md:focus-within:shadow-[inset_2px_0_0_0_var(--ring)] ${phone ? 'flex min-h-40 flex-1 flex-col' : ''}`}>
          <textarea
            ref={body}
            aria-label="Message"
            value={text}
            autoFocus={autoFocus && !focusTo}
            onChange={(e) => setText(e.target.value)}
            rows={variant === 'page' ? 10 : 4}
            className={
              phone
                ? 'block min-h-0 w-full flex-1 resize-none bg-transparent px-4 py-3 text-[16px] leading-relaxed focus-visible:outline-none'
                : `block w-full resize-none overflow-hidden bg-transparent px-4 py-3 text-sm leading-relaxed focus-visible:outline-none ${variant === 'page' ? 'min-h-60' : 'min-h-24'}`
            }
          />
          {mode !== 'new' && <p className="px-4 pb-2 text-2xs text-faint">The original message is quoted below your text when it is sent.</p>}
        </div>
        {!phone && errorLine}
        </div>
        {phone ? (
          (errorLine || statusLine || sentFrom) && (
            <div className="shrink-0 border-t border-line pt-2">
              {errorLine}
              <div className="flex min-h-5 items-center gap-2 px-4 pb-2">
                {statusLine}
                {sentFrom}
              </div>
            </div>
          )
        ) : (
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
            <button
              type="button"
              onClick={send}
              title="Send (Ctrl+Enter)"
              className="inline-flex h-8 cursor-pointer items-center gap-2 rounded bg-accent px-3 text-sm font-medium text-on-accent transition-opacity duration-150 ease-out hover:opacity-90"
            >
              <Send size={16} strokeWidth={1.75} aria-hidden="true" />
              Send
            </button>
            <span className="flex items-center gap-1 text-2xs text-faint">
              <Kbd k="Ctrl+Enter" />
            </span>
            <button
              type="button"
              onClick={discard}
              className="inline-flex h-8 cursor-pointer items-center gap-2 rounded px-2 text-sm text-muted transition-colors duration-150 ease-out hover:bg-hover hover:text-fg"
            >
              <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
              Discard
            </button>
            {statusLine}
            {sentFrom}
          </div>
        )}
      </div>
      {confirming && (
        <ConfirmDialog
          title="Discard draft?"
          message="The message you were writing will be deleted."
          confirmLabel="Discard"
          tone="danger"
          onConfirm={() => {
            setConfirming(false);
            discardNow();
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </Frame>
  );
}
