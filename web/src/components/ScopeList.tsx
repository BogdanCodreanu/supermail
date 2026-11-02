import { useQuery } from '@tanstack/react-query';
import type { RefObject } from 'react';
import { MAX_BULK_SENDERS, type TeachPreviewDTO, type ThreadSummaryDTO } from '@supermail/shared';
import { api, qk } from '../api/client';
import { emails, type TeachScope } from '../lib/teach';
import { useIsPhone } from '../lib/useIsPhone';
import { Kbd } from './Kbd';
import { senderOf } from './ThreadRow';

export interface ScopeOption { scope: TeachScope; label: string }

const counted = (label: string, n: number | undefined) => (n === undefined ? label : `${label} · ${n}`);

/** The choices for a thread. Before the counts arrive, or if they fail, the sender and this email still work. */
export function useScopeOptions(t: ThreadSummaryDTO): ScopeOption[] {
  const { data: p } = useQuery<TeachPreviewDTO>({ queryKey: qk.teachPreview(t.id), queryFn: () => api.teachPreview(t.id) });
  const sender = p?.sender?.value ?? t.fromEmail;
  return [
    { scope: 'thread', label: 'Only this email' },
    ...(sender ? [{ scope: 'sender' as const, label: counted(`All from ${sender}`, p?.sender?.count) }] : []),
    ...(p?.domain ? [{ scope: 'domain' as const, label: counted(`Everyone at ${p.domain.value}`, p.domain.count) }] : []),
    ...(p?.list ? [{ scope: 'list' as const, label: counted('This mailing list', p.list.count) }] : []),
  ];
}

/** The scope a prompt starts on: the sender, when the thread has one. */
export const defaultScope = (t: ThreadSummaryDTO): TeachScope => (t.fromEmail ? 'sender' : 'thread');

/** A prompt about a selection: how many emails, from how many different senders. */
export interface BulkScope { count: number; senders: number }

/** The choices for a selection: no domain or list, to keep it understandable, and only a teachable number of senders. */
export function bulkScopeOptions({ count, senders }: BulkScope): ScopeOption[] {
  return [
    { scope: 'thread', label: count === 1 ? 'Only this email' : `Only these ${count} emails` },
    ...(senders >= 1 && senders <= MAX_BULK_SENDERS ? [{ scope: 'sender' as const, label: senders === 1 ? 'All from this sender' : `All from the ${senders} senders` }] : []),
  ];
}

/** What the prompt is about, and why the senders are missing when there are too many of them. */
export function BulkHeading({ count, senders }: BulkScope) {
  return (
    <div className="border-b border-line px-4 py-2 md:px-3">
      <p className="truncate font-medium">
        {emails(count)} from {senders} sender{senders === 1 ? '' : 's'}
      </p>
      {senders > MAX_BULK_SENDERS && <p className="text-xs text-muted">{senders} senders is too many to teach at once, so this only moves the emails.</p>}
    </div>
  );
}

/** Which email the prompt is about, on two lines at most. */
export function EmailHeading({ thread }: { thread: ThreadSummaryDTO }) {
  return (
    <div className="border-b border-line px-4 py-2 md:px-3">
      <p className="truncate font-medium">{senderOf(thread)}</p>
      <p className="truncate text-xs text-muted">{thread.subject || '(no subject)'}</p>
    </div>
  );
}

interface ScopeListProps {
  options: ScopeOption[];
  value: TeachScope;
  onSelect(scope: TeachScope): void;
  /** `column`: one row per scope with its number key. `row`: compact chips under a filter field. */
  layout: 'row' | 'column';
  listRef?: RefObject<HTMLDivElement>;
}

/** The scope choice shared by ScopePrompt and GroupPicker. The keys belong to whichever of them hosts it. */
export function ScopeList({ options, value, onSelect, layout, listRef }: ScopeListProps) {
  const phone = useIsPhone();
  return (
    <div ref={listRef} role="radiogroup" aria-label="Apply to" className={layout === 'row' ? 'flex flex-wrap gap-2 px-4 pb-2 md:gap-1 md:px-2' : 'py-1'}>
      {options.map((o, i) => {
        const on = o.scope === value;
        return (
          <button
            key={o.scope}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.label}
            onClick={() => onSelect(o.scope)}
            className={
              layout === 'row'
                ? `h-11 max-w-full cursor-pointer truncate rounded px-3 text-sm transition-colors duration-150 ease-out max-md:active:bg-hover md:h-6 md:px-2 md:text-xs ${on ? 'bg-sel font-medium text-fg' : 'text-muted hover:bg-hover hover:text-fg'}`
                : // On the phone a tap applies the option, so there is no highlighted one to confirm.
                  `flex min-h-12 w-full cursor-pointer items-center gap-2 px-4 py-2 text-left text-base transition-colors duration-150 ease-out max-md:active:bg-hover md:h-8 md:min-h-0 md:px-3 md:py-0 md:text-sm ${on ? 'md:bg-sel md:font-medium md:text-fg' : 'md:text-muted md:hover:bg-hover md:hover:text-fg'}`
            }
          >
            {layout === 'column' && !phone && <Kbd k={String(i + 1)} />}
            <span className="min-w-0 break-words md:truncate">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
