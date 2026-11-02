import { offline, RetryButton, waitingForNetwork } from '../components/LoadFailure';
import { accountLabels } from '../lib/accounts';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Check, CheckCheck, Clock, FolderInput, Inbox as InboxIcon, Mail, MailOpen, OctagonAlert, Star, StarOff, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { MAX_BULK_IDS, type ActionResult, type BulkRequest, type TeachAction, type ThreadId, type ThreadSummaryDTO } from '@supermail/shared';
import { api, qk } from '../api/client';
import { applyServerEvent, cachedThreads, patchThreads } from '../api/events';
import { AccountSwitcher } from '../components/AccountSwitcher';
import { BulkBar, type BulkBarAction } from '../components/BulkBar';
import { CommandPalette } from '../components/CommandPalette';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { GroupPicker } from '../components/GroupPicker';
import { GroupTabs } from '../components/GroupTabs';
import { Kbd } from '../components/Kbd';
import { Layout } from '../components/Layout';
import { useBackLayer, whenBackSettled } from '../components/phone/backStack';
import { ComposeFab, useHideOnScroll } from '../components/phone/ComposeFab';
import { PullIndicator } from '../components/phone/Pull';
import { PushBanner } from '../components/phone/PushBanner';
import { RowSheet, threadSheetItems } from '../components/phone/RowSheet';
import { RowSkeleton } from '../components/phone/RowSkeleton';
import { SelectionBar, SelectionTopBar } from '../components/phone/SelectionBars';
import { usePullToRefresh } from '../components/phone/usePullToRefresh';
import { ScopePrompt } from '../components/ScopePrompt';
import { SnoozePicker } from '../components/SnoozePicker';
import { hint, useThreadMenu, type ThreadActions } from '../components/ThreadContextMenu';
import { ThreadListbox } from '../components/ThreadList';
import { formatRowDate, isDone, rowDomId, senderOf, threadHref, ThreadRow } from '../components/ThreadRow';
import { useShortcuts } from '../keys/useShortcuts';
import { createGroup } from '../lib/newGroup';
import { formatWhen } from '../lib/snoozeTimes';
import { useIsPhone } from '../lib/useIsPhone';
import { actedOn, emails, IMPORTANT, LOW_PRIORITY, movedMessage, moveOptimistically, scopeTitle, teachMessage, THREAD_CACHES, type GroupRef, type TeachScope } from '../lib/teach';
import { forgetOpenedThread, lastOpenedThread, listKey, readListMemory, writeListMemory } from '../state/listMemory';
import { showBulkToast, showToast, useUndoLast, withFailed, type BulkWording } from '../state/toasts';
import { useAccountFilter, useShowDone } from '../state/ui';
import { useChecked } from '../state/useChecked';
import type { ComposeMode, ThreadNavState } from './Thread';

/** Rows are exactly this tall (ThreadRow h-9), so the list never shifts. */
const ROW_HEIGHT = 36;
const PHONE_ROW_HEIGHT = 72;

/** From this many threads on, Report spam asks first: a slip of `!` on a big selection is slow to take back. */
const SPAM_CONFIRM_AT = 10;

/** The server's answer; a bulk action also names the threads it could not reach. */
type Answer = ActionResult & { failed?: ThreadId[] };

interface ActionVars {
  /** Lowercase verb for the error toast ("mark done"). */
  verb: string;
  call(): Promise<Answer>;
  /** Applied to the caches before the call; rolled back if it fails. */
  optimistic(qc: QueryClient): void;
  /** The toast; a function when it depends on the server's answer. A bulk action's has a count that can still change. */
  message: string | ((r: Answer) => string) | { bulk: BulkWording };
}

/** What the scope prompt is asking about: the teaching it leads to, once the owner picks how far it reaches. */
type ScopeAsk = { action: TeachAction; group: GroupRef; confirmKeys?: string[] };
type Picker =
  | { kind: 'snooze' | 'group'; thread: ThreadSummaryDTO }
  | ({ kind: 'scope'; thread: ThreadSummaryDTO } & ScopeAsk)
  // The same three for everything selected, so no thread of their own.
  | { kind: 'bulkSnooze' | 'bulkGroup' | 'bulkSpam' }
  | ({ kind: 'bulkScope' } & ScopeAsk);

const removeThread = (t: ThreadSummaryDTO) => (qc: QueryClient) => applyServerEvent(qc, { type: 'thread.removed', id: t.id });
const patchThread = (t: ThreadSummaryDTO, p: Partial<ThreadSummaryDTO>) => (qc: QueryClient) =>
  applyServerEvent(qc, { type: 'thread.updated', thread: { ...t, ...p } });

/** The right end of the group-tabs row: whether recently Done threads are listed too. */
function ShowDoneToggle({ on, onChange }: { on: boolean; onChange(on: boolean): void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={on ? 'Hide done (d)' : 'Show done (d)'}
      onClick={() => onChange(!on)}
      className={`ml-4 inline-flex h-8 shrink-0 cursor-pointer items-center gap-2 self-center rounded px-2 text-xs transition-colors duration-150 ease-out ${
        on ? 'bg-sel font-medium text-fg' : 'text-muted hover:bg-hover hover:text-fg'
      }`}
    >
      <CheckCheck size={16} strokeWidth={1.75} aria-hidden />
      <span className="sr-only sm:not-sr-only">Show done</span>
      <span className="hidden lg:inline-flex">
        <Kbd k="d" />
      </span>
    </button>
  );
}

/** The merged inbox: account switcher, group tabs, a virtual thread list, actions with undo, and teaching keys. */
export function Inbox() {
  const qc = useQueryClient();
  const phone = useIsPhone();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const groupId = params.get('group');
  const [accountId, setAccountId] = useAccountFilter();
  const [showDone, setShowDone] = useShowDone();

  const accountsQ = useQuery({ queryKey: qk.accounts(), queryFn: api.accounts });
  const groupsQ = useQuery({ queryKey: qk.groups(accountId), queryFn: () => api.groups(accountId), placeholderData: keepPreviousData });
  const listQ = useInfiniteQuery({
    queryKey: qk.threads({ accountId, groupId, includeDone: showDone }),
    queryFn: ({ pageParam }) => api.threads({ accountId, groupId, cursor: pageParam, ...(showDone ? { includeDone: true } : {}) }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    // Show done only adds or drops rows: the list stays up until the other one arrives. A new filter still starts clean.
    placeholderData: (prev, prevQuery) => {
      const f = prevQuery?.queryKey[1] as { accountId: string | null; groupId: string | null } | undefined;
      return f?.accountId === accountId && f?.groupId === groupId ? prev : undefined;
    },
  });

  const accounts = useMemo(() => accountsQ.data ?? [], [accountsQ.data]);
  const groups = useMemo(() => [...(groupsQ.data ?? [])].sort((a, b) => a.position - b.position), [groupsQ.data]);
  const threads = useMemo(() => listQ.data?.pages.flatMap((p) => p.threads) ?? [], [listQ.data]);
  const accountColor = useMemo(() => new Map(accounts.map((a) => [a.id, a.color])), [accounts]);
  // In the merged view of several accounts every row says which account received it.
  const labels = useMemo(() => accountLabels(accounts), [accounts]);
  const accountOf = (id: string) => {
    if (accountId !== null || accounts.length < 2) return null;
    const a = accounts.find((x) => x.id === id);
    return a ? { label: labels.get(id) ?? a.email, email: a.email } : null;
  };
  const groupById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);

  // A remembered account or group that no longer exists falls back to All.
  useEffect(() => {
    if (accountId !== null && accountsQ.data && !accountsQ.data.some((a) => a.id === accountId)) setAccountId(null);
  }, [accountId, accountsQ.data, setAccountId]);
  const selectGroup = (id: string | null) => {
    const go = () => setParams(id ? { group: id } : {}, { replace: true });
    // Replacing the entry under selection mode would strand its back step, so that goes first.
    if (phone && selecting) {
      clearSelection();
      whenBackSettled(go);
    } else {
      go();
    }
  };
  useEffect(() => {
    if (groupId !== null && groupsQ.isSuccess && !groupsQ.isPlaceholderData && !groupById.has(groupId)) setParams({}, { replace: true });
  }, [groupId, groupsQ.isSuccess, groupsQ.isPlaceholderData, groupById, setParams]);

  // Selection follows the thread, not the row number, so live inserts never shift `e` onto another
  // thread. When the selected thread leaves the list, the row that takes its place is selected, and
  // with no selection yet the first row is. Coming back from a thread restores where the owner was
  // in this list (state/listMemory), on the thread last read when it is still here.
  const key = listKey(accountId, groupId);
  const [selId, setSelId] = useState<string | null>(() => lastOpenedThread() ?? readListMemory(key)?.selId ?? null);
  const lastIndex = useRef(readListMemory(key)?.index ?? 0);
  useEffect(() => forgetOpenedThread(), []);
  let index = threads.findIndex((t) => t.id === selId);
  if (index === -1 && threads.length > 0) index = selId === null ? 0 : Math.max(0, Math.min(lastIndex.current, threads.length - 1));
  const selected = index >= 0 ? threads[index] : undefined;
  useEffect(() => {
    if (index >= 0) lastIndex.current = index;
    if (selected && selected.id !== selId) setSelId(selected.id);
  });
  // A new filter starts at its first row, at the top (before the restore below reads the memory). On a phone each group
  // keeps its place instead: the slider is for going back and forth between them.
  const shownKey = useRef(key);
  useLayoutEffect(() => {
    if (shownKey.current === key) return;
    shownKey.current = key;
    if (phone) {
      const place = readListMemory(key);
      setSelId(place?.selId ?? null);
      lastIndex.current = place?.index ?? 0;
      return;
    }
    setSelId(null);
    lastIndex.current = 0;
    writeListMemory(key, { selId: null, index: 0, scrollTop: 0 });
  }, [key]);
  // Threads ticked for a bulk action belong to the list on show: another list starts with none, as does Show done.
  const checked = useChecked(threads, key);
  const [selectingAll, setSelectingAll] = useState(false);
  const selectAllRun = useRef(0);
  const selectAllFrom = useRef<ThreadId | null>(null);
  const clearSelection = () => {
    selectAllRun.current++;
    selectAllFrom.current = null;
    setSelectingAll(false);
    checked.clear();
  };
  const shownList = useRef({ key, showDone });
  useLayoutEffect(() => {
    if (shownList.current.key === key && shownList.current.showDone === showDone) return;
    writeListMemory(shownList.current.key, { checked: [] });
    shownList.current = { key, showDone };
    clearSelection();
  });
  useEffect(() => {
    if (selected) writeListMemory(key, { selId: selected.id, index });
  }, [key, selected, index]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: threads.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (phone ? PHONE_ROW_HEIGHT : ROW_HEIGHT),
    // It scrolls to this itself on mount, and judges what is in view by it: left at 0 it undoes the restore below.
    initialOffset: () => readListMemory(key)?.scrollTop ?? 0,
    overscan: 12,
    getItemKey: (i) => threads[i]?.id ?? i,
  });
  useEffect(() => virtualizer.measure(), [phone, virtualizer]);
  const items = virtualizer.getVirtualItems();
  // Put the list back at its remembered offset once its rows are there (then the selection is kept in view).
  const restored = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (restored.current === key || threads.length === 0 || !scrollRef.current) return;
    restored.current = key;
    const top = readListMemory(key)?.scrollTop ?? 0;
    scrollRef.current.scrollTop = top;
    virtualizer.scrollToOffset(top);
  }, [key, threads.length, virtualizer]);
  // Both neighbours are ready before the slider gets there, and the list fades over rather than cutting. `neighbourKeys`
  // stands for `groups`, which changes with every count.
  const neighbourKeys = [null, ...groups.map((g) => g.id)].join('\n');
  useEffect(() => {
    if (!phone || !groupsQ.isSuccess) return;
    const order = [null, ...groups.map((g) => g.id)];
    const at = order.indexOf(groupId);
    for (const neighbour of [order[at - 1], order[at + 1]]) {
      if (neighbour === undefined) continue;
      void qc.prefetchInfiniteQuery({
        queryKey: qk.threads({ accountId, groupId: neighbour, includeDone: showDone }),
        queryFn: ({ pageParam }) => api.threads({ accountId, groupId: neighbour, cursor: pageParam, ...(showDone ? { includeDone: true } : {}) }),
        initialPageParam: null as string | null,
        getNextPageParam: (page) => page.nextCursor,
        pages: 1,
      });
    }
  }, [phone, groupsQ.isSuccess, neighbourKeys, groupId, accountId, showDone, qc]);
  const fadedKey = useRef(key);
  useEffect(() => {
    if (fadedKey.current === key) return;
    fadedKey.current = key;
    if (!phone || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    scrollRef.current?.animate?.([{ opacity: 0.4 }, { opacity: 1 }], { duration: 120, easing: 'ease-out' });
  }, [key, phone]);
  const fab = useHideOnScroll();
  const onScroll = () => {
    if (!scrollRef.current) return;
    fab.onScroll(scrollRef.current.scrollTop);
    if (restored.current === key) writeListMemory(key, { scrollTop: scrollRef.current.scrollTop });
  };
  // A phone follows the selection only coming back to the list: after that the finger decides what is on screen, and
  // live mail moving the selected row must not move the list.
  const followedOnPhone = useRef(false);
  useEffect(() => {
    if (index < 0 || (phone && followedOnPhone.current)) return;
    followedOnPhone.current = true;
    virtualizer.scrollToIndex(index, { align: 'auto' });
  }, [index, virtualizer, phone]);
  // Load the next page when the end of the list comes into view.
  const lastVisible = items.at(-1)?.index ?? -1;
  useEffect(() => {
    if (listQ.hasNextPage && !listQ.isFetchingNextPage && !listQ.isPlaceholderData && lastVisible >= threads.length - 10) void listQ.fetchNextPage();
  }, [lastVisible, threads.length, listQ]);

  // ---- actions -------------------------------------------------------------------------------
  // Toasts are the app's (state/toasts): `z` here also undoes Done or snooze from the thread just left.

  const action = useMutation({
    mutationFn: (v: ActionVars) => v.call(),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ['threads'] });
      const snapshot = qc.getQueriesData(THREAD_CACHES);
      v.optimistic(qc);
      return { snapshot };
    },
    onError: (err, v, ctx) => {
      for (const [key, data] of ctx?.snapshot ?? []) qc.setQueryData(key, data);
      showToast(`Couldn't ${v.verb}: ${err instanceof Error ? err.message : String(err)}`, { tone: 'error' });
    },
    onSuccess: (res, v) => {
      if (res.thread) applyServerEvent(qc, { type: 'thread.updated', thread: res.thread });
      if (typeof v.message === 'object') showBulkToast(v.message.bulk, { undoId: res.undoId, affected: res.affected ?? 0, failed: res.failed ?? [] });
      else showToast(typeof v.message === 'function' ? v.message(res) : v.message, { undoId: res.undoId, bulk: res.failed !== undefined });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['groups'] }),
  });
  const run = (v: ActionVars) => action.mutate(v);

  // The undone thread is back in the list: select it.
  const undoLast = useUndoLast((res) => {
    if (res.thread) setSelId(res.thread.id);
  });

  const groupName = (id: string) => groupById.get(id)?.name ?? { [IMPORTANT]: 'Important', [LOW_PRIORITY]: 'Low priority' }[id] ?? id;

  const done = (t: ThreadSummaryDTO) => {
    // With Show done on the row stays, dimmed: the selection moves on by itself, so another `e` does the next
    // thread, as it would with the row gone, and never takes this one back out.
    if (showDone && t.id === selected?.id) {
      const next = threads.slice(index + 1).find((x) => !isDone(x));
      if (next) setSelId(next.id);
    }
    run({
      verb: 'mark done',
      call: () => api.done(t.id),
      optimistic: showDone ? patchThread(t, { inInbox: false, doneAt: Date.now() }) : removeThread(t),
      message: actedOn(t, 'Done'),
    });
  };
  const moveToInbox = (t: ThreadSummaryDTO) =>
    run({ verb: 'move to inbox', call: () => api.restore(t.id), optimistic: patchThread(t, { inInbox: true, doneAt: null }), message: actedOn(t, 'Moved to inbox') });
  const snooze = (t: ThreadSummaryDTO, at: Date) =>
    run({ verb: 'snooze', call: () => api.snooze(t.id, at.getTime()), optimistic: removeThread(t), message: actedOn(t, `Snoozed until ${formatWhen(at)}`) });
  const reportSpam = (t: ThreadSummaryDTO) => run({ verb: 'report spam', call: () => api.reportSpam(t.id), optimistic: removeThread(t), message: actedOn(t, 'Reported as spam') });
  const toggleRead = (t: ThreadSummaryDTO) =>
    run({
      verb: t.unread ? 'mark read' : 'mark unread',
      call: () => api.read(t.id, t.unread),
      optimistic: patchThread(t, { unread: !t.unread }),
      message: actedOn(t, t.unread ? 'Marked read' : 'Marked unread'),
    });

  /** A teaching or, for "Only this email", a one-off move. Everything in scope moves on screen at once. */
  const apply = (t: ThreadSummaryDTO, kind: TeachAction, scope: TeachScope, group: GroupRef) => {
    const optimistic = (cache: QueryClient) => void moveOptimistically(cache, t, scope, group);
    if (scope === 'thread') {
      run({ verb: 'move', call: () => api.move(t.id, group.id), optimistic, message: movedMessage(t, group.name) });
      return;
    }
    run({
      verb: 'teach',
      call: () => api.teach({ threadId: t.id, action: kind, scope, ...(kind === 'always_group' ? { groupId: group.id } : {}) }),
      optimistic,
      message: (r) => teachMessage(t, kind, scope, group.name, r.affected),
    });
  };

  // ---- the selection -------------------------------------------------------------------------
  // On screen at once, in one pass over the lists. The server's events then confirm it, or bring back what Gmail refused.

  const selection = checked.rows;
  const anyChecked = selection.length > 0;
  const selecting = anyChecked || selectingAll;
  useBackLayer(phone && selecting, clearSelection);
  const anyUnread = selection.some((t) => t.unread);
  const senders = useMemo(() => new Set(selection.flatMap((t) => (t.fromEmail ? [t.fromEmail.toLowerCase()] : []))), [selection]);
  const bulkScope = { count: selection.length, senders: senders.size };

  const onSelection = (verb: string, targets: ThreadSummaryDTO[], req: Omit<BulkRequest, 'ids'>, wording: BulkWording, change: Partial<ThreadSummaryDTO>) => {
    const ids = targets.map((t) => t.id);
    clearSelection();
    run({
      verb,
      call: () => api.bulk({ ids, ...req }).then((r) => ({ ...r, thread: null })),
      optimistic: (cache) => patchThreads(cache, targets.map((t) => ({ ...t, ...change }))),
      message: { bulk: wording },
    });
  };
  // With Show done on, rows already done are not done again.
  const doneSelection = () => {
    const targets = selection.filter((t) => !isDone(t));
    if (targets.length === 0) showToast('Already done');
    else onSelection('mark done', targets, { action: 'done' }, (n) => `${n} done`, { inInbox: false, doneAt: Date.now(), snoozedUntil: null });
  };
  const snoozeSelection = (at: Date) =>
    onSelection('snooze', selection, { action: 'snooze', until: at.getTime() }, (n) => `${n} snoozed until ${formatWhen(at)}`, { inInbox: false, doneAt: null, snoozedUntil: at.getTime() });
  const readSelection = () =>
    onSelection(anyUnread ? 'mark read' : 'mark unread', selection, { action: anyUnread ? 'read' : 'unread' }, (n) => `${n} marked ${anyUnread ? 'read' : 'unread'}`, { unread: !anyUnread });
  const reportSelection = () => onSelection('report spam', selection, { action: 'spam' }, (n) => `${n} reported as spam`, { inInbox: false, doneAt: null });
  const spamSelection = () => (selection.length >= SPAM_CONFIRM_AT ? setPicker({ kind: 'bulkSpam' }) : reportSelection());
  const moveSelection = (group: GroupRef) =>
    onSelection('move', selection, { action: 'move', groupId: group.id }, (n) => `${emails(n)} → ${group.name}`, { groupId: group.id, groupName: group.name, suggestRule: false });
  /** Rules for every sender in the selection: their other mail moves too, on screen as on the server. */
  const teachSelection = (kind: TeachAction, group: GroupRef) => {
    const ids = selection.map((t) => t.id);
    const count = senders.size;
    clearSelection();
    run({
      verb: 'teach',
      call: () => api.teachBulk({ ids, action: kind, ...(kind === 'always_group' ? { groupId: group.id } : {}) }).then((r) => ({ ...r, thread: null })),
      optimistic: (cache) =>
        patchThreads(cache, cachedThreads(cache).filter((t) => t.fromEmail && senders.has(t.fromEmail.toLowerCase())).map((t) => ({ ...t, groupId: group.id, groupName: group.name, suggestRule: false }))),
      message: (r) => withFailed(`${count} sender${count === 1 ? '' : 's'} → ${group.name}`, r.failed?.length ?? 0),
    });
  };
  const applyToSelection = (kind: TeachAction, scope: TeachScope, group: GroupRef) => (scope === 'thread' ? moveSelection(group) : teachSelection(kind, group));

  const stopSelectingAll = () => {
    selectAllRun.current++;
    selectAllFrom.current = null;
    setSelectingAll(false);
    showToast('That row left the list: nothing selected');
  };
  // Watched on the list itself: a page on its way puts back a row that left while it was fetched.
  useEffect(() => {
    if (selectingAll && selectAllFrom.current && !threads.some((t) => t.id === selectAllFrom.current)) stopSelectingAll();
  }, [selectingAll, threads]);

  /** Ctrl+A: from the current row to the bottom, fetching the rows not loaded yet, as far as one action can take. */
  const selectToBottom = async () => {
    if (!selected) return;
    const run = ++selectAllRun.current;
    const fromId = selected.id;
    selectAllFrom.current = fromId;
    const below = (rows: ThreadSummaryDTO[]) => {
      const from = rows.findIndex((t) => t.id === fromId);
      return from === -1 ? [] : rows.slice(from);
    };
    let rows = threads;
    let more = listQ.hasNextPage;
    let error = false;
    setSelectingAll(true);
    while (more && !error && below(rows).length > 0 && below(rows).length < MAX_BULK_IDS) {
      const page = await listQ.fetchNextPage();
      if (selectAllRun.current !== run) return;
      rows = page.data?.pages.flatMap((p) => p.threads) ?? rows;
      more = page.hasNextPage;
      error = page.isError;
    }
    const ids = below(rows).map((t) => t.id);
    if (ids.length === 0) {
      stopSelectingAll();
      return;
    }
    setSelectingAll(false);
    const fits = checked.add(ids);
    if (error) showToast(`Couldn't load the rest of the list: selected what was there`, { tone: 'error' });
    else if (more || !fits) showToast(`Selected the first ${MAX_BULK_IDS}: the most one action can take`);
  };
  const extend = (delta: 1 | -1) => {
    if (!selected) return;
    const to = threads[Math.max(0, Math.min(threads.length - 1, index + delta))]!;
    checked.extendTo(to.id, selected.id);
    setSelId(to.id);
  };

  // ---- pickers and keys ----------------------------------------------------------------------

  const [picker, setPicker] = useState<Picker | null>(null);
  /** The row whose long-press sheet is up. */
  const [pressed, setPressed] = useState<ThreadSummaryDTO | null>(null);
  const askImportant = (t: ThreadSummaryDTO) => setPicker({ kind: 'scope', thread: t, action: 'important', group: { id: IMPORTANT, name: groupName(IMPORTANT) }, confirmKeys: ['+'] });
  const askNotImportant = (t: ThreadSummaryDTO) => setPicker({ kind: 'scope', thread: t, action: 'not_important', group: { id: LOW_PRIORITY, name: groupName(LOW_PRIORITY) }, confirmKeys: ['-'] });
  // The ids go along so j/k in the thread view walk this list, and Done/snooze continue to the next thread.
  const open = (t: ThreadSummaryDTO, compose?: ComposeMode) =>
    navigate(threadHref(t.id), { state: { ids: threads.map((x) => x.id), compose } satisfies ThreadNavState });
  // From the latest selection, so several keys in one tick (fast key repeat) each move a row.
  const move = (delta: 1 | -1) => {
    if (threads.length === 0) return;
    setSelId((prev) => {
      const at = threads.findIndex((t) => t.id === prev);
      const from = at === -1 ? index : at;
      return threads[from === -1 ? 0 : Math.max(0, Math.min(threads.length - 1, from + delta))]!.id;
    });
  };
  const moveTo = (edge: 'first' | 'last') => {
    const t = edge === 'first' ? threads[0] : threads.at(-1);
    if (t) setSelId(t.id);
  };
  const groupOrder = [null, ...groups.map((g) => g.id)];
  const stepGroup = (delta: 1 | -1) =>
    selectGroup(groupOrder[(groupOrder.indexOf(groupId) + delta + groupOrder.length) % groupOrder.length] ?? null);
  const withSelected = (fn: (t: ThreadSummaryDTO) => void) => () => {
    if (selected) fn(selected);
  };
  /** A triage key: on everything selected when there is a selection, on the current row when not. */
  const triage = (onAll: () => void, onOne: (t: ThreadSummaryDTO) => void) => () => {
    if (selectingAll) return; // nothing is ticked yet, so the key would land on the one row under the cursor
    if (anyChecked) onAll();
    else if (selected) onOne(selected);
  };
  const askSelection = (action: TeachAction, id: string, confirmKeys?: string[]) => setPicker({ kind: 'bulkScope', action, group: { id, name: groupName(id) }, confirmKeys });
  const importantSelection = () => askSelection('important', IMPORTANT, ['+']);
  const notImportantSelection = () => askSelection('not_important', LOW_PRIORITY, ['-']);

  const keys: Record<string, () => void> = {
    next: () => move(1),
    prev: () => move(-1),
    open: withSelected(open),
    nextGroup: () => stepGroup(1),
    prevGroup: () => stepGroup(-1),
    cycleAccount: () => {
      const ids = [null, ...accounts.map((a) => a.id)];
      setAccountId(ids[(ids.indexOf(accountId) + 1) % ids.length] ?? null);
    },
    toggleDone: () => setShowDone(!showDone),
    // `/` and `c` are the header's (Layout).
    done: triage(doneSelection, (t) => (isDone(t) ? moveToInbox(t) : done(t))),
    snooze: triage(() => setPicker({ kind: 'bulkSnooze' }), (t) => setPicker({ kind: 'snooze', thread: t })),
    reportSpam: triage(spamSelection, reportSpam),
    reply: withSelected((t) => open(t, 'reply')),
    replyAll: withSelected((t) => open(t, 'replyAll')),
    forward: withSelected((t) => open(t, 'forward')),
    toggleRead: triage(readSelection, toggleRead),
    undo: undoLast,
    important: triage(importantSelection, askImportant),
    notImportant: triage(notImportantSelection, askNotImportant),
    groupTo: triage(() => setPicker({ kind: 'bulkGroup' }), (t) => setPicker({ kind: 'group', thread: t })),
    select: withSelected((t) => {
      checked.toggle(t.id);
      move(1);
    }),
    selectToBottom: () => void selectToBottom(),
    extendDown: () => extend(1),
    extendUp: () => extend(-1),
    ...(selecting ? { clearSelection } : {}),
  };
  groups.slice(0, 9).forEach((g, i) => (keys[`group${i + 1}`] = () => selectGroup(g.id)));
  useShortcuts('list', picker ? {} : keys);
  const hintFor = (id: string) => hint(id, 'list');
  const barActions: BulkBarAction[] = [
    { label: 'Done', icon: Check, keyHint: hintFor('done'), run: doneSelection },
    { label: 'Snooze', icon: Clock, keyHint: hintFor('snooze'), run: () => setPicker({ kind: 'bulkSnooze' }) },
    { label: anyUnread ? 'Read' : 'Unread', icon: anyUnread ? MailOpen : Mail, keyHint: hintFor('toggleRead'), run: readSelection },
    { label: 'Important', icon: Star, keyHint: hintFor('important'), run: importantSelection },
    { label: 'Not important', icon: StarOff, keyHint: hintFor('notImportant'), run: notImportantSelection },
    { label: 'Move to group', icon: FolderInput, keyHint: hintFor('groupTo'), run: () => setPicker({ kind: 'bulkGroup' }) },
    { label: 'Report spam', icon: OctagonAlert, keyHint: hintFor('reportSpam'), run: spamSelection },
  ];
  const rowActions: ThreadActions = {
    done,
    moveToInbox,
    pickSnooze: (t) => setPicker({ kind: 'snooze', thread: t }),
    reportSpam,
    toggleRead,
    important: askImportant,
    notImportant: askNotImportant,
    pickGroup: (t) => setPicker({ kind: 'group', thread: t }),
  };
  const barAction = (label: string) => barActions.find((a) => a.label === label)!;
  const moveAction = { ...barAction('Move to group'), label: 'Move' };
  const phoneBarActions = [barAction('Done'), barAction('Snooze'), barActions[2]!, moveAction, barAction('Important'), barAction('Not important'), barAction('Report spam')];
  const menu = useThreadMenu({
    context: 'list',
    selected,
    disabled: picker !== null,
    open,
    // On a selected row the menu is about the selection; on any other row, about that row alone.
    selection: (t) => {
      if (!checked.ids.has(t.id)) return null;
      const n = emails(selection.length);
      return {
        label: `Actions for ${selection.length} selected`,
        items: [
          { id: 'done', label: `Done ${n}`, icon: Check, keyHint: hintFor('done'), onSelect: doneSelection },
          { id: 'snooze', label: `Snooze ${n}…`, icon: Clock, keyHint: hintFor('snooze'), onSelect: () => setPicker({ kind: 'bulkSnooze' }) },
          { id: 'read', label: `Mark ${n} as ${anyUnread ? 'read' : 'unread'}`, icon: anyUnread ? MailOpen : Mail, keyHint: hintFor('toggleRead'), onSelect: readSelection },
          { id: 'spam', label: `Report ${n} as spam`, icon: OctagonAlert, keyHint: hintFor('reportSpam'), onSelect: spamSelection },
          'separator',
          { id: 'important', label: 'Important to me…', icon: Star, keyHint: hintFor('important'), onSelect: importantSelection },
          { id: 'notImportant', label: 'Not important…', icon: StarOff, keyHint: hintFor('notImportant'), onSelect: notImportantSelection },
          { id: 'group', label: `Move ${n} to group…`, icon: FolderInput, keyHint: hintFor('groupTo'), onSelect: () => setPicker({ kind: 'bulkGroup' }) },
          'separator',
          { id: 'clear', label: 'Clear selection', icon: X, keyHint: hintFor('clearSelection'), onSelect: clearSelection },
        ],
      };
    },
    actions: rowActions,
  });

  const pullArea = useRef<HTMLDivElement>(null);
  const pull = usePullToRefresh({
    areaRef: pullArea,
    scrollRef,
    disabled: !phone || selecting,
    onRefresh: async () => {
      const [list] = await Promise.all([listQ.refetch(), groupsQ.refetch()]);
      return !list.isError;
    },
  });

  // ---- render --------------------------------------------------------------------------------

  const needsReconnect = accounts.filter((a) => a.status === 'reconnect_needed');
  const viewName = groupId ? groupName(groupId) : 'your inbox';

  return (
    <Layout
      context="list"
      top={<AccountSwitcher accounts={accounts} value={accountId} onChange={setAccountId} />}
      phoneBar={phone && selecting ? <SelectionTopBar count={selection.length} loading={selectingAll} onClose={clearSelection} onSelectBelow={() => void selectToBottom()} /> : undefined}
      sub={
        <>
          <GroupTabs
            groups={groups}
            selected={groupId}
            onSelect={selectGroup}
            onCreate={async (name) => selectGroup((await createGroup(qc, name, groups)).id)}
          />
          {!phone && <ShowDoneToggle on={showDone} onChange={setShowDone} />}
        </>
      }
    >
      <div ref={pullArea} data-testid="pull-area" className="relative flex h-full flex-col">
        {phone && <PullIndicator ref={pull.indicatorRef} state={pull.state} />}
        {phone && <PushBanner />}
        {needsReconnect.length > 0 && (
          <div className="shrink-0 border-b border-line bg-warn-bg px-4 py-2 text-xs text-fg">
            {needsReconnect.map((a) => a.email).join(', ')} {needsReconnect.length === 1 ? 'needs' : 'need'} reconnecting.{' '}
            <Link to="/settings" className="cursor-pointer text-accent underline">
              Settings
            </Link>
          </div>
        )}
        {waitingForNetwork(listQ) ? (
          <p role="alert" className="min-h-0 flex-1 p-6 text-muted">
          {offline('your mail')} <RetryButton onRetry={() => void listQ.refetch()} />
        </p>
        ) : listQ.isPending ? (
          phone ? <RowSkeleton /> : <p className="min-h-0 flex-1 p-6 text-muted">Loading…</p>
        ) : listQ.isError && threads.length === 0 ? (
          <p role="alert" className="min-h-0 flex-1 p-6 text-muted">
            Couldn't load threads.{' '}
            <button type="button" className="inline-flex h-11 cursor-pointer touch-manipulation items-center text-accent underline md:inline md:h-auto" onClick={() => void listQ.refetch()}>
              Try again
            </button>
          </p>
        ) : threads.length === 0 ? (
          <p className="min-h-0 flex-1 p-6 text-muted">Nothing left in {viewName}.</p>
        ) : (
          <ThreadListbox
            label="Threads"
            activeId={selected ? rowDomId(selected.id) : undefined}
            onMove={move}
            onMoveTo={moveTo}
            listRef={scrollRef}
            onScroll={onScroll}
            className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain"
          >
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {items.map((v) => {
                const t = threads[v.index]!;
                const g = groupById.get(t.groupId);
                const finished = isDone(t);
                return (
                  <div key={v.key} role="none" className="absolute left-0 top-0 w-full" style={{ transform: `translateY(${v.start}px)` }}>
                    <ThreadRow
                      thread={t}
                      accountColor={accountColor.get(t.accountId) ?? 'var(--faint)'}
                      account={accountOf(t.accountId)}
                      chip={
                        finished
                          ? { label: 'Done', icon: Check, title: `Done ${formatRowDate(t.doneAt!)}` }
                          : t.groupId !== groupId
                            ? { label: t.groupName, color: g?.color, title: t.reason.text }
                            : null
                      }
                      dimmed={finished}
                      selected={v.index === index}
                      checked={checked.ids.has(t.id)}
                      selecting={selecting}
                      onSelect={() => setSelId(t.id)}
                      onOpen={() => open(t)}
                      onToggle={() => checked.toggle(t.id)}
                      onExtend={() => checked.extendTo(t.id, selected?.id ?? t.id)}
                      onMenu={(x, y) => menu.openAt(t, x, y)}
                      onLongPress={() => setPressed(t)}
                      swipe={{
                        right: finished
                          ? { label: 'Inbox', icon: InboxIcon, tone: 'done', onCommit: () => moveToInbox(t) }
                          : { label: 'Done', icon: Check, tone: 'done', onCommit: () => done(t) },
                        left: { label: 'Snooze', icon: Clock, tone: 'snooze', stays: true, onCommit: () => setPicker({ kind: 'snooze', thread: t }) },
                      }}
                      actions={
                        finished
                          ? [{ label: 'Move to inbox', keyHint: 'e', icon: InboxIcon, run: () => moveToInbox(t) }]
                          : [
                              { label: 'Done', keyHint: 'e', icon: Check, run: () => done(t) },
                              { label: 'Snooze', keyHint: 'h', icon: Clock, run: () => setPicker({ kind: 'snooze', thread: t }) },
                            ]
                      }
                    />
                  </div>
                );
              })}
            </div>
            {listQ.isFetchingNextPage && <p className="px-4 py-2 text-xs text-faint">Loading more…</p>}
            {/* The last row clears the Compose button and the gesture bar. */}
            {phone && <div role="none" className="h-[calc(88px+env(safe-area-inset-bottom))]" />}
          </ThreadListbox>
        )}
        {phone ? (
          selecting ? <SelectionBar actions={phoneBarActions} /> : <ComposeFab hidden={fab.hidden} />
        ) : selecting ? (
          <BulkBar count={selection.length} loading={selectingAll} actions={barActions} onClear={clearSelection} />
        ) : (
          /* Why the selected thread is here, on one fixed line so rows never move. */
          <div data-testid="reason-strip" className="flex h-8 shrink-0 items-center gap-2 border-t border-line bg-panel px-4 text-xs text-muted">
            {selected && (
              <>
                <span className="truncate">{selected.reason.text}</span>
                {selected.suggestRule && (
                  <>
                    <span aria-hidden className="text-faint">
                      ·
                    </span>
                    <button
                      type="button"
                      title={`Always group ${senderOf(selected)} to ${groupName(selected.groupId)}`}
                      onClick={() => setPicker({ kind: 'scope', thread: selected, action: 'always_group', group: { id: selected.groupId, name: groupName(selected.groupId) } })}
                      className="h-6 shrink-0 cursor-pointer rounded px-1 font-medium text-accent hover:bg-hover"
                    >
                      Make this a rule?
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        )}
        {!phone && (
          <div data-testid="selection-status" aria-live="polite" className="sr-only">
            {anyChecked ? `${selection.length} selected` : ''}
          </div>
        )}
      </div>

      {menu.menu}
      {pressed && (
        <RowSheet
          thread={pressed}
          items={threadSheetItems(pressed, { open, actions: rowActions, onSelectMode: () => checked.toggle(pressed.id) })}
          onClose={() => setPressed(null)}
        />
      )}
      <CommandPalette context="list" onGroup={selectGroup} />
      <SnoozePicker
        open={picker?.kind === 'snooze' || picker?.kind === 'bulkSnooze'}
        onPick={(at) => {
          if (picker?.kind === 'snooze') snooze(picker.thread, at);
          else snoozeSelection(at);
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
      />
      <GroupPicker
        open={picker?.kind === 'group' || picker?.kind === 'bulkGroup'}
        thread={picker?.kind === 'group' ? picker.thread : undefined}
        bulk={picker?.kind === 'bulkGroup' ? bulkScope : undefined}
        groups={groups}
        onPick={(group, scope) => {
          if (picker?.kind === 'group') apply(picker.thread, 'always_group', scope, group);
          else applyToSelection('always_group', scope, group);
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
      />
      {picker?.kind === 'bulkSpam' && (
        <ConfirmDialog
          title={`Report ${emails(selection.length)} as spam?`}
          message={`From ${senders.size} ${senders.size === 1 ? 'sender' : 'senders'}.`}
          confirmLabel="Report spam"
          tone="danger"
          onConfirm={() => {
            reportSelection();
            setPicker(null);
          }}
          onCancel={() => setPicker(null)}
        />
      )}
      {picker?.kind === 'bulkScope' && (
        <ScopePrompt
          open
          title={scopeTitle(picker.action, picker.group.name)}
          thread={undefined}
          bulk={bulkScope}
          confirmKeys={picker.confirmKeys}
          onConfirm={(scope) => {
            applyToSelection(picker.action, scope, picker.group);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {picker?.kind === 'scope' && (
        <ScopePrompt
          open
          title={scopeTitle(picker.action, picker.group.name)}
          thread={picker.thread}
          confirmKeys={picker.confirmKeys}
          onConfirm={(scope) => {
            apply(picker.thread, picker.action, scope, picker.group);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </Layout>
  );
}
