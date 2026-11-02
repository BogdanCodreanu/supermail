import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Forward, Paperclip, Reply, ReplyAll, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import type { AccountDTO, ActionResult, GroupDTO, MessageDTO, TeachAction, ThreadId } from '@supermail/shared';
import { api, ApiError, attachmentUrl, qk } from '../api/client';
import { applyServerEvent } from '../api/events';
import { CommandPalette } from '../components/CommandPalette';
import { Composer, draftFor, type ComposeMode as AnyComposeMode } from '../components/Composer';
import { GroupPicker } from '../components/GroupPicker';
import { Kbd } from '../components/Kbd';
import { Layout } from '../components/Layout';
import { loadFailure, offline, RetryButton, waitingForNetwork } from '../components/LoadFailure';
import { MessageBody } from '../components/MessageBody';
import { CollapsedHeader, ExpandedHeader, formatDate } from '../components/MessageHeader';
import { whenBackSettled } from '../components/phone/backStack';
import { ReaderScreen } from '../components/phone/ReaderScreen';
import { ScopePrompt } from '../components/ScopePrompt';
import { SnoozePicker } from '../components/SnoozePicker';
import { ThreadBar, ThreadMoreSheet, ThreadToolbar } from '../components/ThreadToolbar';
import { useShortcuts } from '../keys/useShortcuts';
import { previewOf } from '../lib/quotes';
import { formatWhen } from '../lib/snoozeTimes';
import { useIsPhone } from '../lib/useIsPhone';
import { actedOn, IMPORTANT, LOW_PRIORITY, movedMessage, moveOptimistically, scopeTitle, teachMessage, type GroupRef, type TeachScope } from '../lib/teach';
import { clearDraft, draftKey, loadDraft, newDraftId, saveDraft } from '../state/drafts';
import { requestReopen, useReopenRequest } from '../state/outbox';
import { showToast, useUndoLast } from '../state/toasts';

export { formatDate };

/**
 * Router state a list passes when it opens a thread: the ids in list order, so `j`/`k` move between
 * threads and Done/snooze continue to the next one. Without it, `j`/`k` move between messages
 * (`n`/`p` always do). `compose` opens the reply composer on arrival (Reply in a list's menu).
 */
export interface ThreadNavState { ids?: ThreadId[]; compose?: ComposeMode }

export type ComposeMode = Exclude<AnyComposeMode, 'new'>;

/** The reply composer open under the last message; `seq` changes on every r/a/f, to bring it into view. */
interface InlineCompose { mode: ComposeMode; replyToMessageId?: string; seq: number }

const enc = encodeURIComponent;

export function AccountDot({ account }: { account: AccountDTO | undefined }) {
  return (
    <span
      title={account?.email}
      aria-hidden="true"
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ background: account?.color ?? 'var(--faint)' }}
    />
  );
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function Attachments({ m, accountId }: { m: MessageDTO; accountId: string }) {
  return (
    <ul className="mt-3 flex flex-col gap-2 md:flex-row md:flex-wrap" aria-label="Attachments">
      {m.attachments.map((a) => {
        const name = a.filename || 'attachment';
        return (
          <li key={a.attachmentId} className="flex items-center rounded border border-line text-sm md:inline-flex md:text-xs">
            <a
              href={attachmentUrl(accountId, m.gmailMessageId, a.attachmentId, { name: a.filename })}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open ${name}`}
              className="inline-flex h-12 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-l px-3 hover:bg-hover max-md:active:bg-hover md:h-7 md:flex-none md:px-2"
            >
              <Paperclip size={14} strokeWidth={1.75} aria-hidden="true" className="h-5 w-5 shrink-0 text-faint md:h-3.5 md:w-3.5" />
              <span className="min-w-0 flex-1 truncate md:max-w-60 md:flex-none">{name}</span>
              <span className="shrink-0 text-faint">{sizeLabel(a.size)}</span>
            </a>
            <a
              href={attachmentUrl(accountId, m.gmailMessageId, a.attachmentId, { name: a.filename, download: true })}
              download={name}
              title={`Download ${name}`}
              aria-label={`Download ${name}`}
              className="inline-flex h-12 w-12 shrink-0 cursor-pointer items-center justify-center rounded-r border-l border-line text-muted hover:bg-hover hover:text-fg max-md:active:bg-hover md:h-7 md:w-7"
            >
              <Download size={14} strokeWidth={1.75} aria-hidden="true" className="h-5 w-5 md:h-3.5 md:w-3.5" />
            </a>
          </li>
        );
      })}
    </ul>
  );
}

interface MessageViewProps {
  m: MessageDTO;
  accountId: string;
  accountEmail: string | undefined;
  expanded: boolean;
  focused: boolean;
  onToggle(): void;
}

function MessageView({ m, accountId, accountEmail, expanded, focused, onToggle }: MessageViewProps) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [focused]);
  const preview = useMemo(() => (expanded ? '' : previewOf(m)), [expanded, m]);
  return (
    <article
      ref={ref}
      data-focused={focused}
      className={`border-b border-b-line transition-colors duration-150 ease-out md:border-l-2 ${focused ? 'md:border-l-accent md:bg-sel' : 'md:border-l-transparent'}`}
    >
      {expanded ? (
        <>
          <ExpandedHeader m={m} me={accountEmail} account={accountEmail ?? accountId} onToggle={onToggle} />
          <div className="px-4 pb-4 pt-2">
            <MessageBody message={m} />
            {m.attachments.length > 0 && <Attachments m={m} accountId={accountId} />}
          </div>
        </>
      ) : (
        <CollapsedHeader m={m} me={accountEmail} preview={preview} onToggle={onToggle} />
      )}
    </article>
  );
}

function RespondButton({ icon: Icon, label, k, onClick }: { icon: LucideIcon; label: string; k: string; onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 cursor-pointer items-center gap-2 rounded border border-line px-3 text-sm transition-colors duration-150 ease-out hover:bg-hover"
    >
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" className="text-muted" />
      {label}
      <Kbd k={k} />
    </button>
  );
}

/**
 * The messages a thread opens with: the latest, plus the unread ones. Messages carry no read state of
 * their own, so in a thread that was unread, the ones after the owner's own last message count as unread.
 */
function initiallyOpen(messages: MessageDTO[], wasUnread: boolean, me: string | undefined): Set<string> {
  const open = new Set<string>();
  const last = messages[messages.length - 1];
  if (last) open.add(last.id);
  if (wasUnread) {
    let mine = -1;
    if (me) messages.forEach((m, i) => m.from.email.toLowerCase() === me.toLowerCase() && (mine = i));
    messages.slice(mine + 1).forEach((m) => open.add(m.id));
  }
  return open;
}

/** `/t/:id`: one thread, its messages (sandboxed HTML), the toolbar and the thread shortcuts. */
export function Thread() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const nav = (location.state ?? {}) as ThreadNavState;
  const qc = useQueryClient();

  const detail = useQuery({ queryKey: qk.thread(id), queryFn: () => api.thread(id) });
  const accounts = useQuery({ queryKey: qk.accounts(), queryFn: api.accounts });

  const [opened, setOpened] = useState<Record<string, boolean>>({}); // per-message expand overrides
  const [focus, setFocus] = useState(-1);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [groupPickerOpen, setGroupPickerOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const phone = useIsPhone();
  /** The scope prompt: the teaching it leads to, once the owner picks how far it reaches. */
  const [ask, setAsk] = useState<{ action: TeachAction; group: GroupRef; confirmKeys?: string[] } | null>(null);
  const [composer, setComposer] = useState<InlineCompose | null>(null);
  const composeSeq = useRef(0);
  const composerBox = useRef<HTMLDivElement>(null);
  /** The mode whose body just moved to another mode; its draft is dropped once its composer closed. */
  const movedFrom = useRef<ComposeMode | null>(null);
  const busy = useRef(false);

  const thread = detail.data?.thread;
  const messages = detail.data?.messages ?? [];

  // Whether the thread was unread when it arrived, before opening it marks it read.
  const arrivedUnread = useRef<{ id: string; unread: boolean } | null>(null);
  if (thread && arrivedUnread.current?.id !== thread.id) arrivedUnread.current = { id: thread.id, unread: thread.unread };

  // A new thread id (j/k, Done → next) starts from its own defaults.
  useEffect(() => {
    setOpened({});
    setFocus(-1);
    setSnoozeOpen(false);
    setGroupPickerOpen(false);
    setMoreOpen(false);
    setAsk(null);
    setComposer(null);
  }, [id]);

  // Undo send puts the draft back and asks for its composer again (state/outbox).
  const reopen = useReopenRequest();
  useEffect(() => {
    if (!reopen || reopen.threadId !== id || reopen.mode === 'new') return;
    requestReopen(null);
    setComposer({ mode: reopen.mode, seq: ++composeSeq.current });
  }, [reopen, id]);

  // A list asked for the composer. Taken out of the history entry, so Back or a reload doesn't open it again.
  const askedFor = nav.compose;
  const loaded = detail.data !== undefined;
  useEffect(() => {
    if (!askedFor || !loaded) return;
    setComposer({ mode: askedFor, seq: ++composeSeq.current });
    navigate(`/t/${enc(id)}`, { replace: true, state: { ids: nav.ids } satisfies ThreadNavState });
  }, [askedFor, loaded]);

  // A body that moved to another mode: the old composer saved it as it closed, so drop that copy now.
  useEffect(() => {
    const from = movedFrom.current;
    if (!from) return;
    movedFrom.current = null;
    clearDraft(draftKey(from, id));
  }, [composer, id]);

  // Each r/a/f brings the composer into view and puts the cursor in it (a new one focuses itself).
  useEffect(() => {
    const box = composerBox.current;
    if (!composer || !box) return;
    box.scrollIntoView?.({ block: 'nearest' });
    if (!box.contains(document.activeElement)) box.querySelector<HTMLElement>('textarea[aria-label="Message"]')?.focus();
  }, [composer?.seq]);

  // The server does not mark threads read on fetch; opening one does, once per visit.
  const markedRead = useRef<string | null>(null);
  useEffect(() => {
    if (!thread?.unread || markedRead.current === thread.id) return;
    markedRead.current = thread.id;
    api.read(thread.id, true).then(
      (r) => r.thread && applyServerEvent(qc, { type: 'thread.updated', thread: r.thread }),
      () => undefined,
    );
  }, [thread, qc]);

  const goBack = useCallback(() => {
    if (location.key !== 'default') navigate(-1);
    else navigate('/');
  }, [location.key, navigate]);

  // Undo send comes back to this thread by URL alone; it is still the same list.
  const keptIds = useRef<ThreadId[] | undefined>(undefined);
  if (nav.ids) keptIds.current = nav.ids;
  const ids = nav.ids ?? (keptIds.current?.includes(id) ? keptIds.current : undefined);
  const at = ids ? ids.indexOf(id) : -1;

  const openThread = (to: ThreadId, state: ThreadNavState) => navigate(`/t/${enc(to)}`, { replace: true, state });

  /** After Done, snooze or Report spam: on to the next thread in the list, or back to the list. */
  const leave = () => {
    if (ids && at !== -1) {
      const rest = ids.filter((x) => x !== id);
      const next = rest[at] ?? rest[at - 1];
      if (next) return openThread(next, { ids: rest });
    }
    goBack();
  };

  /** Runs one server action at a time; a second press while one is in flight is ignored. */
  const run = (verb: string, call: () => Promise<ActionResult>, onOk: (r: ActionResult) => void, optimistic?: () => () => void) => {
    if (busy.current) return;
    busy.current = true;
    const rollback = optimistic?.();
    call()
      .then(onOk)
      .catch((e: unknown) => {
        rollback?.();
        showToast(`Couldn't ${verb}: ${e instanceof Error ? e.message : String(e)}`, { tone: 'error' });
      })
      .finally(() => {
        busy.current = false;
        void qc.invalidateQueries({ queryKey: ['groups'] });
      });
  };

  /**
   * A thread action: apply the result, confirm it with an undo toast, and for Done/snooze/spam move on. The
   * toast is the app's (state/toasts), so it stays on the next thread or the inbox, and `z` there undoes it.
   */
  const act = (verb: string, call: () => Promise<ActionResult>, message: string | ((r: ActionResult) => string), moveOn = false, optimistic?: () => () => void) => {
    if (!thread) return;
    const here = { id, ids };
    run(
      verb,
      call,
      (r) => {
        if (r.thread) applyServerEvent(qc, { type: 'thread.updated', thread: r.thread });
        else applyServerEvent(qc, { type: 'thread.removed', id: here.id });
        showToast(typeof message === 'function' ? message(r) : message, { undoId: r.undoId, restore: moveOn ? here : undefined });
        if (moveOn) whenBackSettled(leave); // it may have come from a sheet
      },
      optimistic,
    );
  };

  // Undoing Done or snooze from the thread that came next goes back to the one it was done on.
  const undoLast = useUndoLast((_, t) => {
    if (t.restore && t.restore.id !== id) openThread(t.restore.id, { ids: t.restore.ids });
  });

  const groups = qc.getQueryData<GroupDTO[]>(qk.groups(null)) ?? [];
  const groupName = (gid: string) => groups.find((g) => g.id === gid)?.name ?? { [IMPORTANT]: 'Important', [LOW_PRIORITY]: 'Low priority' }[gid] ?? gid;

  /** A teaching or, for "Only this email", a one-off move. Everything in scope moves on screen at once. */
  const apply = (action: TeachAction, scope: TeachScope, group: GroupRef) => {
    if (!thread) return;
    const optimistic = () => moveOptimistically(qc, thread, scope, group);
    if (scope === 'thread') {
      act('move', () => api.move(id, group.id), movedMessage(thread, group.name), false, optimistic);
      return;
    }
    const groupId = action === 'always_group' ? { groupId: group.id } : {};
    act('teach', () => api.teach({ threadId: id, action, scope, ...groupId }), (r) => teachMessage(thread, action, scope, group.name, r.affected), false, optimistic);
  };
  // Nothing to ask about until the thread has loaded.
  const askImportant = () => thread && setAsk({ action: 'important', group: { id: IMPORTANT, name: groupName(IMPORTANT) }, confirmKeys: ['+'] });
  const askNotImportant = () => thread && setAsk({ action: 'not_important', group: { id: LOW_PRIORITY, name: groupName(LOW_PRIORITY) }, confirmKeys: ['-'] });
  const openGroupPicker = () => thread && setGroupPickerOpen(true);

  // On a thread that is not in the inbox (a Done one, opened from Show done) e brings it back instead.
  const done = () =>
    thread && !thread.inInbox
      ? act('move to inbox', () => api.restore(id), actedOn(thread, 'Moved to inbox'))
      : thread && act('mark done', () => api.done(id), actedOn(thread, 'Done'), true);
  const reportSpam = () => thread && act('report spam', () => api.reportSpam(id), actedOn(thread, 'Reported as spam'), true);
  const toggleRead = () => {
    if (!thread) return;
    const read = thread.unread;
    act(read ? 'mark read' : 'mark unread', () => api.read(id, read), actedOn(thread, read ? 'Marked read' : 'Marked unread'));
  };

  /** `j`/`k`: the next thread in the list, or the next message when the thread was opened without one. */
  const moveFocus = (delta: number) => {
    if (ids && at !== -1) {
      const next = ids[at + delta];
      if (next) openThread(next, { ids });
      return;
    }
    moveMessage(delta);
  };

  /** `n`/`p`: focus (and expand) the next or previous message. */
  const moveMessage = (delta: number) => {
    if (messages.length === 0) return;
    const current = focus === -1 ? messages.length - 1 : focus;
    const i = Math.min(Math.max(current + delta, 0), messages.length - 1);
    setFocus(i);
    setOpened((o) => ({ ...o, [messages[i]!.id]: true }));
  };

  /** Moves the body typed in the open composer to `to`'s draft, so it is there when that composer opens. */
  const carryBody = (from: ComposeMode, to: ComposeMode, replyToMessageId: string | undefined) => {
    const text = composerBox.current?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.value ?? '';
    if (!text.trim() || !detail.data) return;
    const own = new Set((accounts.data ?? []).map((a) => a.email.toLowerCase()));
    const key = draftKey(to, id);
    const base = loadDraft(key) ?? { id: newDraftId(), accountId: detail.data.thread.accountId, ...draftFor(detail.data, to, own, replyToMessageId) };
    saveDraft(key, { ...base, text, savedAt: Date.now() });
    movedFrom.current = from;
  };

  /** r/a/f: the composer under the last message, answering the focused message when there is one. */
  const compose = (mode: ComposeMode) => {
    const replyToMessageId = focus === -1 ? undefined : messages[focus]?.id;
    if (composer && composer.mode !== mode) carryBody(composer.mode, mode, replyToMessageId);
    setComposer({ mode, replyToMessageId, seq: ++composeSeq.current });
  };
  const closeComposer = () => setComposer(null);

  const onSnoozePick = (when: Date) => {
    setSnoozeOpen(false);
    if (thread) act('snooze', () => api.snooze(id, when.getTime()), actedOn(thread, `Snoozed until ${formatWhen(when)}`), true);
  };
  const onGroupPick = (group: GroupRef, scope: TeachScope) => {
    setGroupPickerOpen(false);
    apply('always_group', scope, group);
  };

  const pickerOpen = snoozeOpen || groupPickerOpen || moreOpen || ask !== null;
  useShortcuts(
    'thread',
    pickerOpen
      ? {}
      : {
          // With the composer open, Escape is the composer's (close, keep the draft).
          ...(composer ? {} : { back: goBack }),
          next: () => moveFocus(1),
          prev: () => moveFocus(-1),
          nextMessage: () => moveMessage(1),
          prevMessage: () => moveMessage(-1),
          done,
          snooze: () => setSnoozeOpen(true),
          reportSpam,
          reply: () => compose('reply'),
          replyAll: () => compose('replyAll'),
          forward: () => compose('forward'),
          compose: () => navigate('/compose'),
          search: () => navigate('/search'),
          toggleRead,
          undo: undoLast,
          important: askImportant,
          notImportant: askNotImportant,
          groupTo: openGroupPicker,
        },
  );

  const accountOf = (accountId: string) => accounts.data?.find((a) => a.id === accountId);
  const accountEmail = thread ? accountOf(thread.accountId)?.email : undefined;
  const openByDefault = useMemo(
    () => initiallyOpen(messages, arrivedUnread.current?.unread ?? false, accountEmail),
    [detail.data?.messages, accountEmail],
  );
  const isExpanded = (m: MessageDTO) => opened[m.id] ?? openByDefault.has(m.id);

  let body;
  if (waitingForNetwork(detail)) {
    body = (
      <div role="alert" className="p-6 text-muted">
        {offline('this thread')} <RetryButton onRetry={() => void detail.refetch()} />
      </div>
    );
  } else if (detail.isPending) {
    body = <div className="p-6 text-muted">Loading…</div>;
  } else if (detail.isError) {
    const gone = detail.error instanceof ApiError && detail.error.status === 404;
    body = gone ? (
      <div className="p-6 text-muted">This thread is no longer here.</div>
    ) : (
      <div role="alert" className="p-6 text-muted">
        {loadFailure('this thread', detail.error)} <RetryButton onRetry={() => void detail.refetch()} />
      </div>
    );
  } else {
    const t = detail.data.thread;
    const account = accountOf(t.accountId);
    const composerView = composer && (
      <Composer
        variant="inline"
        mode={composer.mode}
        threadId={t.id}
        replyToMessageId={composer.replyToMessageId}
        onClose={closeComposer}
        // Only the composer it was sent from (Undo may have opened another since).
        onSent={() => setComposer((c) => (c?.seq === composer.seq ? null : c))}
        autoFocus
      />
    );
    body = (
      <div className="mx-auto max-w-4xl pb-8 pt-4">
        <header className="px-4 pb-4">
          <h1 className="text-lg font-semibold">{t.subject || '(no subject)'}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1.5 rounded bg-hover px-2 py-0.5 text-muted">
              <AccountDot account={account} />
              {t.groupName}
            </span>
            <span className="text-faint">{account?.email ?? t.accountId}</span>
            {t.snoozedUntil !== null && <span className="text-muted">Snoozed until {formatDate(t.snoozedUntil)}</span>}
          </div>
          <p className="mt-2 text-xs text-muted">{t.reason.text}</p>
          {t.suggestRule && t.fromEmail && (
            <button
              type="button"
              onClick={() => setAsk({ action: 'always_group', group: { id: t.groupId, name: t.groupName } })}
              className="mt-1 inline-flex min-h-11 cursor-pointer items-center text-xs text-accent underline-offset-2 hover:underline max-md:active:bg-hover md:min-h-0"
            >
              Make this a rule for {t.fromEmail}?
            </button>
          )}
        </header>
        <div className="border-t border-line">
          {messages.map((m, i) => (
            <MessageView
              key={m.id}
              m={m}
              accountId={t.accountId}
              accountEmail={account?.email}
              expanded={isExpanded(m)}
              focused={i === focus}
              onToggle={() => {
                setFocus(i);
                setOpened((o) => ({ ...o, [m.id]: !isExpanded(m) }));
              }}
            />
          ))}
        </div>
        {phone ? (
          composerView // full screen, over the thread
        ) : composer ? (
          <div ref={composerBox} className="scroll-mb-4 px-4 pt-4">
            {composerView}
          </div>
        ) : (
          <div role="group" aria-label="Respond" className="flex flex-wrap gap-2 px-4 pt-4">
            <RespondButton icon={Reply} label="Reply" k="r" onClick={() => compose('reply')} />
            <RespondButton icon={ReplyAll} label="Reply all" k="a" onClick={() => compose('replyAll')} />
            <RespondButton icon={Forward} label="Forward" k="f" onClick={() => compose('forward')} />
          </div>
        )}
      </div>
    );
  }

  const actions = {
    unread: thread?.unread ?? false,
    inInbox: thread?.inInbox ?? true,
    onDone: done,
    onSnooze: () => setSnoozeOpen(true),
    onReportSpam: reportSpam,
    onToggleRead: toggleRead,
    onGroupTo: openGroupPicker,
    onImportant: askImportant,
    onNotImportant: askNotImportant,
    onReply: () => compose('reply'),
    onReplyAll: () => compose('replyAll'),
    onForward: () => compose('forward'),
  };
  const dialogs = (
    <>
      <SnoozePicker open={snoozeOpen} onPick={onSnoozePick} onClose={() => setSnoozeOpen(false)} />
      <GroupPicker open={groupPickerOpen} thread={thread} groups={groups} onPick={onGroupPick} onClose={() => setGroupPickerOpen(false)} />
      {ask && (
        <ScopePrompt
          open
          title={scopeTitle(ask.action, ask.group.name)}
          thread={thread}
          confirmKeys={ask.confirmKeys}
          onConfirm={(scope) => {
            setAsk(null);
            apply(ask.action, scope, ask.group);
          }}
          onClose={() => setAsk(null)}
        />
      )}
    </>
  );

  if (phone) {
    return (
      <ReaderScreen
        title={thread ? thread.subject || '(no subject)' : ''}
        screenKey={id}
        onBack={goBack}
        onMore={thread && (() => setMoreOpen(true))}
        bar={thread && <ThreadBar {...actions} onMore={() => setMoreOpen(true)} />}
        barLabel="Thread actions"
      >
        {body}
        {moreOpen && <ThreadMoreSheet {...actions} onClose={() => setMoreOpen(false)} />}
        {dialogs}
      </ReaderScreen>
    );
  }

  return (
    <Layout context={composer ? 'compose' : 'thread'}>
      <ThreadToolbar {...actions} />
      {body}
      {dialogs}
      <CommandPalette context="thread" />
    </Layout>
  );
}
