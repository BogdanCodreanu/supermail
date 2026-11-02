import type { LucideIcon } from 'lucide-react';
import { Check, Clock, FolderInput, Forward, Inbox, Mail, MailOpen, OctagonAlert, Reply, ReplyAll, SquareCheck, Star, StarOff } from 'lucide-react';
import type { ThreadSummaryDTO } from '@supermail/shared';
import type { ComposeMode } from '../../views/Thread';
import { BottomSheet } from '../BottomSheet';
import type { ThreadActions } from '../ThreadContextMenu';
import { senderOf } from '../ThreadRow';
import { whenBackSettled } from './backStack';

export interface SheetItem {
  id: string;
  label: string;
  icon: LucideIcon;
  run(): void;
  /** Goes to another screen, so it waits for the sheet to leave history. */
  navigates?: boolean;
}

/** A long-press on a row of indexed threads: the row's actions, as on the computer's right-click menu. */
export function threadSheetItems(t: ThreadSummaryDTO, { open, actions, onSelectMode }: { open(t: ThreadSummaryDTO, compose?: ComposeMode): void; actions: ThreadActions; onSelectMode?(): void }): SheetItem[] {
  return [
    { id: 'reply', label: 'Reply', icon: Reply, navigates: true, run: () => open(t, 'reply') },
    { id: 'replyAll', label: 'Reply all', icon: ReplyAll, navigates: true, run: () => open(t, 'replyAll') },
    { id: 'forward', label: 'Forward', icon: Forward, navigates: true, run: () => open(t, 'forward') },
    t.inInbox ? { id: 'done', label: 'Done', icon: Check, run: () => actions.done(t) } : { id: 'done', label: 'Move to inbox', icon: Inbox, run: () => actions.moveToInbox(t) },
    { id: 'snooze', label: 'Snooze', icon: Clock, run: () => actions.pickSnooze(t) },
    { id: 'read', label: t.unread ? 'Mark as read' : 'Mark as unread', icon: t.unread ? MailOpen : Mail, run: () => actions.toggleRead(t) },
    { id: 'spam', label: 'Report spam', icon: OctagonAlert, run: () => actions.reportSpam(t) },
    { id: 'important', label: 'Important to me', icon: Star, run: () => actions.important(t) },
    { id: 'notImportant', label: 'Not important', icon: StarOff, run: () => actions.notImportant(t) },
    { id: 'group', label: 'Move to group', icon: FolderInput, run: () => actions.pickGroup(t) },
    ...(onSelectMode ? [{ id: 'select', label: 'Select', icon: SquareCheck, run: onSelectMode }] : []),
  ];
}

export function RowSheet({ thread: t, items, onClose }: { thread: ThreadSummaryDTO; items: SheetItem[]; onClose(): void }) {
  const subject = t.subject || '(no subject)';
  return (
    <BottomSheet label={`Actions for ${subject}`} hideTitle onClose={onClose}>
      <div className="border-b border-line px-4 pb-2">
        <p className="truncate text-sm text-muted">{senderOf(t)}</p>
        <p className="truncate text-base font-semibold">{subject}</p>
      </div>
      <div>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              onClose();
              if (item.navigates) whenBackSettled(item.run);
              else item.run();
            }}
            className="flex min-h-12 w-full touch-manipulation items-center gap-4 px-4 text-left text-base active:bg-hover"
          >
            <item.icon size={20} strokeWidth={1.75} aria-hidden className="shrink-0 text-muted" />
            {item.label}
          </button>
        ))}
      </div>
    </BottomSheet>
  );
}
