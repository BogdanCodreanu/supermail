import { useQueryClient } from '@tanstack/react-query';
import {
  Check, Clock, Copy, ExternalLink, Forward, FolderInput, Inbox, Mail, MailOpen, OctagonAlert, Reply, ReplyAll, Star, StarOff,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ActionResult, TeachAction, ThreadId, ThreadSummaryDTO } from '@supermail/shared';
import { api, qk } from '../api/client';
import { applyServerEvent } from '../api/events';
import { BINDINGS, type KeyContext } from '../keys/keymap';
import { formatWhen } from '../lib/snoozeTimes';
import { IMPORTANT, LOW_PRIORITY, movedMessage, scopeTitle, teachMessage, type GroupRef, type TeachScope } from '../lib/teach';
import { showToast } from '../state/toasts';
import type { ComposeMode } from '../views/Thread';
import { ContextMenu, type MenuEntry } from './ContextMenu';
import { GroupPicker } from './GroupPicker';
import { ScopePrompt } from './ScopePrompt';
import { SnoozePicker } from './SnoozePicker';
import { rowDomId, threadHref } from './ThreadRow';

/** What the menu's items do to a thread; each screen supplies its own (the inbox's are optimistic). */
export interface ThreadActions {
  done(t: ThreadSummaryDTO): void;
  moveToInbox(t: ThreadSummaryDTO): void;
  pickSnooze(t: ThreadSummaryDTO): void;
  reportSpam(t: ThreadSummaryDTO): void;
  toggleRead(t: ThreadSummaryDTO): void;
  important(t: ThreadSummaryDTO): void;
  notImportant(t: ThreadSummaryDTO): void;
  pickGroup(t: ThreadSummaryDTO): void;
}

export type Notify = (message: string, opts?: { tone?: 'info' | 'error'; undoId?: string }) => void;

/** The key that does the same thing on this screen, if there is one: a hint never promises a dead key. */
export function hint(id: string, context: KeyContext): string | undefined {
  return BINDINGS.find((b) => b.id === id && b.contexts.includes(context))?.keys[0];
}

export function copyLink(href: string, notify: Notify): void {
  // No navigator.clipboard outside https or localhost, hence inside the promise.
  void Promise.resolve()
    .then(() => navigator.clipboard.writeText(new URL(href, location.origin).href))
    .then(
      () => notify('Link copied'),
      () => notify("Couldn't copy the link", { tone: 'error' }),
    );
}

interface MenuHandlers { open(t: ThreadSummaryDTO, compose?: ComposeMode): void; actions: ThreadActions; notify: Notify }

function menuEntries(t: ThreadSummaryDTO, context: KeyContext, { open, actions, notify }: MenuHandlers): MenuEntry[] {
  return [
    { id: 'open', label: 'Open', icon: MailOpen, keyHint: hint('open', context), onSelect: () => open(t) },
    { id: 'tab', label: 'Open in new tab', icon: ExternalLink, onSelect: () => window.open(threadHref(t.id), '_blank', 'noopener') },
    'separator',
    { id: 'reply', label: 'Reply', icon: Reply, keyHint: hint('reply', context), onSelect: () => open(t, 'reply') },
    { id: 'replyAll', label: 'Reply all', icon: ReplyAll, keyHint: hint('replyAll', context), onSelect: () => open(t, 'replyAll') },
    { id: 'forward', label: 'Forward', icon: Forward, keyHint: hint('forward', context), onSelect: () => open(t, 'forward') },
    'separator',
    t.inInbox
      ? { id: 'done', label: 'Done', icon: Check, keyHint: hint('done', context), onSelect: () => actions.done(t) }
      : { id: 'done', label: 'Move to inbox', icon: Inbox, keyHint: hint('restore', context) ?? hint('done', context), onSelect: () => actions.moveToInbox(t) },
    { id: 'snooze', label: 'Snooze…', icon: Clock, keyHint: hint('snooze', context), onSelect: () => actions.pickSnooze(t) },
    { id: 'spam', label: 'Report spam', icon: OctagonAlert, keyHint: hint('reportSpam', context), onSelect: () => actions.reportSpam(t) },
    {
      id: 'read',
      label: t.unread ? 'Mark as read' : 'Mark as unread',
      icon: t.unread ? MailOpen : Mail,
      keyHint: hint('toggleRead', context),
      onSelect: () => actions.toggleRead(t),
    },
    'separator',
    { id: 'important', label: 'Important to me', icon: Star, keyHint: hint('important', context), onSelect: () => actions.important(t) },
    { id: 'notImportant', label: 'Not important', icon: StarOff, keyHint: hint('notImportant', context), onSelect: () => actions.notImportant(t) },
    { id: 'group', label: 'Always group to…', icon: FolderInput, keyHint: hint('groupTo', context), onSelect: () => actions.pickGroup(t) },
    'separator',
    { id: 'copy', label: 'Copy link', icon: Copy, onSelect: () => copyLink(threadHref(t.id), notify) },
  ];
}

interface OpenMenu { thread: ThreadSummaryDTO; x: number; y: number; keyboard: boolean }

interface RowMenuOptions {
  /** The selected row: what Shift+F10 and the ContextMenu key open the menu on. */
  selected: ThreadSummaryDTO | undefined;
  /** A picker is up: the keys stay away. */
  disabled?: boolean;
  items(t: ThreadSummaryDTO): MenuEntry[];
  /** The menu's accessible name, when it is not about the one email. */
  label?(t: ThreadSummaryDTO): string | undefined;
}

/** What a row's menu offers in place of the usual one, for a row in a selection. */
export interface SelectionMenu { label: string; items: MenuEntry[] }

interface ThreadMenuOptions extends Omit<MenuHandlers, 'notify'>, Omit<RowMenuOptions, 'items' | 'label'> {
  context: KeyContext;
  notify?: Notify;
  selection?(t: ThreadSummaryDTO): SelectionMenu | null;
}

function isTextField(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('input, textarea, select, [contenteditable]') !== null;
}

/**
 * A right-click menu for the rows of a list. Give `openAt` to each row's `onMenu` and render `menu`; the
 * Shift+F10 and ContextMenu keys open it on the selected row.
 */
export function useRowMenu({ selected, disabled = false, items, label }: RowMenuOptions) {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const latest = useRef({ selected, disabled });
  latest.current = { selected, disabled };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
      const { selected: t, disabled: off } = latest.current;
      if (!t || off || isTextField(e.target)) return;
      e.preventDefault();
      const row = document.getElementById(rowDomId(t.id))?.getBoundingClientRect();
      setMenu({ thread: t, x: (row?.left ?? 0) + 48, y: row?.bottom ?? 0, keyboard: true });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const element: ReactNode = menu && (
    <ContextMenu
      label={label?.(menu.thread) ?? `Actions for ${menu.thread.subject || '(no subject)'}`}
      x={menu.x}
      y={menu.y}
      focusFirst={menu.keyboard}
      items={items(menu.thread)}
      onClose={() => setMenu(null)}
    />
  );
  return { openAt: (thread: ThreadSummaryDTO, x: number, y: number) => setMenu({ thread, x, y, keyboard: false }), menu: element };
}

/** The full menu of a list of indexed threads. */
export function useThreadMenu({ context, selected, disabled, open, actions, notify = showToast, selection }: ThreadMenuOptions) {
  return useRowMenu({
    selected,
    disabled,
    items: (t) => selection?.(t)?.items ?? menuEntries(t, context, { open, actions, notify }),
    label: (t) => selection?.(t)?.label,
  });
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * ThreadActions for a screen with no thread actions of its own (search results, skipped mail): the server's
 * answer patches the lists, the toast offers Undo. Render `pickers` once.
 */
export function useThreadActions({ notify = showToast, moveToInbox }: { notify?: Notify; moveToInbox?(t: ThreadSummaryDTO): void } = {}) {
  const qc = useQueryClient();
  const [picker, setPicker] = useState<{ kind: 'snooze' | 'group'; thread: ThreadSummaryDTO } | null>(null);
  const [ask, setAsk] = useState<{ thread: ThreadSummaryDTO; action: TeachAction; group: GroupRef; confirmKeys: string[] } | null>(null);

  const run = (verb: string, call: () => Promise<ActionResult>, message: string | ((r: ActionResult) => string), id: ThreadId) =>
    call().then(
      (r) => {
        applyServerEvent(qc, r.thread ? { type: 'thread.updated', thread: r.thread } : { type: 'thread.removed', id });
        // A snoozed or Done thread has skipped nothing; only the server knows who is still on that list.
        void qc.invalidateQueries({ queryKey: qk.skipped() });
        void qc.invalidateQueries({ queryKey: ['groups'] });
        notify(typeof message === 'function' ? message(r) : message, { undoId: r.undoId });
      },
      (e: unknown) => notify(`Couldn't ${verb}: ${errorText(e)}`, { tone: 'error' }),
    );

  /** A teaching or, for "Only this email", a one-off move. */
  const apply = (t: ThreadSummaryDTO, action: TeachAction, scope: TeachScope, group: GroupRef) =>
    scope === 'thread'
      ? run('move', () => api.move(t.id, group.id), () => movedMessage(t, group.name), t.id)
      : run(
          'teach',
          () => api.teach({ threadId: t.id, action, scope, ...(action === 'always_group' ? { groupId: group.id } : {}) }),
          (r) => teachMessage(t, action, scope, group.name, r.affected),
          t.id,
        );

  const actions: ThreadActions = {
    done: (t) => void run('mark done', () => api.done(t.id), 'Marked done', t.id),
    moveToInbox: moveToInbox ?? ((t) => void run('move to inbox', () => api.restore(t.id), 'Moved to inbox', t.id)),
    pickSnooze: (t) => setPicker({ kind: 'snooze', thread: t }),
    reportSpam: (t) => void run('report spam', () => api.reportSpam(t.id), 'Reported as spam', t.id),
    toggleRead: (t) => void run(t.unread ? 'mark read' : 'mark unread', () => api.read(t.id, t.unread), t.unread ? 'Marked read' : 'Marked unread', t.id),
    important: (t) => setAsk({ thread: t, action: 'important', group: { id: IMPORTANT, name: 'Important' }, confirmKeys: ['+'] }),
    notImportant: (t) => setAsk({ thread: t, action: 'not_important', group: { id: LOW_PRIORITY, name: 'Low priority' }, confirmKeys: ['-'] }),
    pickGroup: (t) => setPicker({ kind: 'group', thread: t }),
  };

  const pickers = (
    <>
      <SnoozePicker
        open={picker?.kind === 'snooze'}
        onPick={(at) => {
          if (picker) void run('snooze', () => api.snooze(picker.thread.id, at.getTime()), `Snoozed until ${formatWhen(at)}`, picker.thread.id);
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
      />
      <GroupPicker
        open={picker?.kind === 'group'}
        thread={picker?.thread}
        groups={[]}
        onPick={(group, scope) => {
          if (picker) void apply(picker.thread, 'always_group', scope, group);
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
      />
      {ask && (
        <ScopePrompt
          open
          title={scopeTitle(ask.action, ask.group.name)}
          thread={ask.thread}
          confirmKeys={ask.confirmKeys}
          onConfirm={(scope) => {
            void apply(ask.thread, ask.action, scope, ask.group);
            setAsk(null);
          }}
          onClose={() => setAsk(null)}
        />
      )}
    </>
  );
  return { actions, pickers, pickerOpen: picker !== null || ask !== null };
}
