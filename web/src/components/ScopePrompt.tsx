import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ThreadSummaryDTO } from '@supermail/shared';
import type { TeachScope } from '../lib/teach';
import { useIsPhone } from '../lib/useIsPhone';
import { Kbd } from './Kbd';
import { BulkHeading, bulkScopeOptions, defaultScope, EmailHeading, ScopeList, useScopeOptions, type BulkScope, type ScopeOption } from './ScopeList';
import { arrowStep, PickerDialog } from './SnoozePicker';

export interface ScopePromptProps {
  open: boolean;
  /** The action, e.g. "Mark as important". */
  title: string;
  thread: ThreadSummaryDTO | undefined;
  /** Asks about a selection instead of `thread`: these emails or all from their senders, starting on these emails. */
  bulk?: BulkScope;
  /** The key that opened the prompt: pressing it again confirms the highlighted scope. */
  confirmKeys?: string[];
  onConfirm(scope: TeachScope): void;
  onClose(): void;
}

/**
 * Asks what a teaching is about before anything changes: this email, the sender, the domain or the list.
 * The sender is highlighted, so the fast path is the same key twice. Up and down move, Enter or a click
 * confirms, 1-4 pick directly, Esc cancels.
 */
export function ScopePrompt({ open, thread, bulk, ...rest }: ScopePromptProps) {
  if (!open) return null;
  if (bulk) return <PromptBody options={bulkScopeOptions(bulk)} initial="thread" heading={<BulkHeading {...bulk} />} {...rest} />;
  return thread ? <ThreadPrompt thread={thread} {...rest} /> : null;
}

type PromptProps = Pick<ScopePromptProps, 'title' | 'confirmKeys' | 'onConfirm' | 'onClose'>;

function ThreadPrompt({ thread, ...rest }: PromptProps & { thread: ThreadSummaryDTO }) {
  return <PromptBody options={useScopeOptions(thread)} initial={defaultScope(thread)} heading={<EmailHeading thread={thread} />} {...rest} />;
}

function PromptBody({ title, options, initial, heading, confirmKeys = [], onConfirm, onClose }: PromptProps & { options: ScopeOption[]; initial: TeachScope; heading: ReactNode }) {
  const [scope, setScope] = useState(initial);
  const list = useRef<HTMLDivElement>(null);
  const phone = useIsPhone();
  const current = Math.max(0, options.findIndex((o) => o.scope === scope));

  // The focus follows the highlight, so every key lands here from the first press.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, [scope]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Tab') return; // the dialog's, and the browser's
    e.stopPropagation(); // a modal: no key reaches the page's shortcuts
    const step = arrowStep(e, current, options.length);
    const picked = /^[1-9]$/.test(e.key) ? options[Number(e.key) - 1] : undefined;
    if (step !== null) setScope(options[step]!.scope);
    else if (picked) onConfirm(picked.scope);
    else if (e.key === 'Enter' || (confirmKeys.includes(e.key) && !e.repeat)) onConfirm(scope);
    else return;
    e.preventDefault();
  };

  return (
    <PickerDialog label={title} onClose={onClose}>
      <div onKeyDown={onKeyDown}>
        {heading}
        <ScopeList options={options} value={scope} onSelect={onConfirm} layout="column" listRef={list} />
        {!phone && (
          <div className="flex flex-wrap gap-3 border-t border-line px-3 py-2 text-2xs text-faint">
            <span className="flex items-center gap-1">
              <Kbd k="Enter" />
              {confirmKeys[0] !== undefined && <Kbd k={confirmKeys[0]} />} confirm
            </span>
            <span className="flex items-center gap-1"><Kbd k="↑↓" raw /> move</span>
            <span className="flex items-center gap-1"><Kbd k="Escape" /> cancel</span>
          </div>
        )}
      </div>
    </PickerDialog>
  );
}
