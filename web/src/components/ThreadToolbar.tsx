import {
  CircleArrowDown,
  CircleArrowUp,
  CircleCheck,
  Clock,
  Ellipsis,
  FolderInput,
  Forward,
  Inbox,
  Mail,
  MailOpen,
  OctagonAlert,
  Reply,
  ReplyAll,
  type LucideIcon,
} from 'lucide-react';
import { BottomSheet } from './BottomSheet';
import { ActionRow } from './phone/ActionRow';

export interface ThreadToolbarProps {
  unread: boolean;
  /** False for a Done thread: the first button then brings it back. */
  inInbox?: boolean;
  onDone(): void;
  onSnooze(): void;
  onReportSpam(): void;
  onToggleRead(): void;
  onGroupTo(): void;
  onImportant(): void;
  onNotImportant(): void;
  onReply(): void;
  onReplyAll(): void;
  onForward(): void;
}

/** An icon-only toolbar button: accessible name, and a tooltip naming its key ("Done · e"). */
export function ToolButton({ icon: Icon, label, keyHint, onClick }: { icon: LucideIcon; label: string; keyHint: string; onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={`${label} · ${keyHint}`}
      className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded text-muted transition-colors duration-150 ease-out hover:bg-hover hover:text-fg"
    >
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}

/** A labelled button of the phone's bottom action bar. */
export function BarButton({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-12 min-w-11 flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg text-2xs text-muted active:bg-hover"
    >
      <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
      {label}
    </button>
  );
}

const Divider = () => <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-line" />;

/** The email screen's bottom bar on the phone. A Done thread gets Move to inbox in the first place. */
export function ThreadBar(p: Pick<ThreadToolbarProps, 'inInbox' | 'onDone' | 'onSnooze' | 'onReply' | 'onForward'> & { onMore(): void }) {
  return (
    <>
      <BarButton icon={p.inInbox === false ? Inbox : CircleCheck} label={p.inInbox === false ? 'Move to inbox' : 'Done'} onClick={p.onDone} />
      <BarButton icon={Clock} label="Snooze" onClick={p.onSnooze} />
      <BarButton icon={Reply} label="Reply" onClick={p.onReply} />
      <BarButton icon={Forward} label="Forward" onClick={p.onForward} />
      <BarButton icon={Ellipsis} label="More" onClick={p.onMore} />
    </>
  );
}

/** What the phone's bar has no room for. Each row closes the sheet first, so a picker it opens takes its place. */
export function ThreadMoreSheet({ onClose, ...p }: ThreadToolbarProps & { onClose(): void }) {
  const row = (icon: LucideIcon, label: string, run: () => void) => (
    <ActionRow
      icon={icon}
      label={label}
      onClick={() => {
        onClose();
        run();
      }}
    />
  );
  return (
    <BottomSheet label="More actions" hideTitle onClose={onClose}>
      <div className="py-2">
        {row(ReplyAll, 'Reply all', p.onReplyAll)}
        {row(p.unread ? MailOpen : Mail, p.unread ? 'Mark read' : 'Mark unread', p.onToggleRead)}
        {row(FolderInput, 'Move to group', p.onGroupTo)}
        {row(CircleArrowUp, 'Important', p.onImportant)}
        {row(CircleArrowDown, 'Not important', p.onNotImportant)}
        {row(OctagonAlert, 'Report spam', p.onReportSpam)}
      </div>
    </BottomSheet>
  );
}

/**
 * The sticky bar over a thread: triage on the left, respond on the right. Every key has a button;
 * Back (Esc) is the header's (Layout), so the screen has one.
 */
export function ThreadToolbar(p: ThreadToolbarProps) {
  return (
    <div role="toolbar" aria-label="Thread actions" className="sticky top-0 z-10 border-b border-line bg-bg">
      <div className="mx-auto flex h-11 max-w-4xl items-center gap-1 overflow-x-auto px-2">
        <ToolButton icon={p.inInbox === false ? Inbox : CircleCheck} label={p.inInbox === false ? 'Move to inbox' : 'Done'} keyHint="e" onClick={p.onDone} />
        <ToolButton icon={Clock} label="Snooze" keyHint="h" onClick={p.onSnooze} />
        <ToolButton icon={OctagonAlert} label="Report spam" keyHint="!" onClick={p.onReportSpam} />
        <ToolButton icon={p.unread ? MailOpen : Mail} label={p.unread ? 'Mark read' : 'Mark unread'} keyHint="u" onClick={p.onToggleRead} />
        <Divider />
        <ToolButton icon={FolderInput} label="Always group to…" keyHint="l" onClick={p.onGroupTo} />
        <ToolButton icon={CircleArrowUp} label="Important" keyHint="+" onClick={p.onImportant} />
        <ToolButton icon={CircleArrowDown} label="Not important" keyHint="-" onClick={p.onNotImportant} />
        <span className="flex-1" />
        <ToolButton icon={Reply} label="Reply" keyHint="r" onClick={p.onReply} />
        <ToolButton icon={ReplyAll} label="Reply all" keyHint="a" onClick={p.onReplyAll} />
        <ToolButton icon={Forward} label="Forward" keyHint="f" onClick={p.onForward} />
      </div>
    </div>
  );
}
