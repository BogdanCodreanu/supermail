import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { GroupDTO, ThreadSummaryDTO } from '@supermail/shared';
import { api, qk } from '../api/client';
import { createGroup } from '../lib/newGroup';
import type { GroupRef, TeachScope } from '../lib/teach';
import { useIsPhone } from '../lib/useIsPhone';
import { Kbd } from './Kbd';
import { BulkHeading, bulkScopeOptions, defaultScope, EmailHeading, ScopeList, useScopeOptions, type BulkScope, type ScopeOption } from './ScopeList';
import { arrowStep, PICKER_INPUT, PICKER_ROW, PickerDialog } from './SnoozePicker';

export interface GroupPickerProps {
  open: boolean;
  thread: ThreadSummaryDTO | undefined;
  /** Picks for a selection instead of `thread`, starting on "Only these emails". */
  bulk?: BulkScope;
  groups: GroupDTO[];
  onPick(group: GroupRef, scope: TeachScope): void;
  onClose(): void;
}

/**
 * Picks a group for an email, and how far it reaches. Typing filters, up and down move through the groups, left and
 * right through the scopes, Enter picks, Esc closes. A name no group has can be created right here.
 * Given no groups (say, a thread opened from a link before any list loaded), it fetches them.
 */
export function GroupPicker({ open, thread, bulk, ...rest }: GroupPickerProps) {
  if (!open) return null;
  if (bulk) return <GroupBody options={bulkScopeOptions(bulk)} initial="thread" heading={<BulkHeading {...bulk} />} {...rest} />;
  return thread ? <ThreadGroupBody thread={thread} {...rest} /> : null;
}

type BodyProps = Pick<GroupPickerProps, 'groups' | 'onPick' | 'onClose'>;

function ThreadGroupBody({ thread, ...rest }: BodyProps & { thread: ThreadSummaryDTO }) {
  return <GroupBody options={useScopeOptions(thread)} initial={defaultScope(thread)} heading={<EmailHeading thread={thread} />} {...rest} />;
}

function GroupBody({ options, initial, heading, groups: given, onPick, onClose }: BodyProps & { options: ScopeOption[]; initial: TeachScope; heading: ReactNode }) {
  const qc = useQueryClient();
  const fetched = useQuery({ queryKey: qk.groups(null), queryFn: () => api.groups(), enabled: given.length === 0 });
  const groups = given.length > 0 ? given : (fetched.data ?? []);
  const [scope, setScope] = useState(initial);
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const creating = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const phone = useIsPhone();
  const name = text.trim();
  const q = name.toLowerCase();
  const shown = [...groups].sort((a, b) => a.position - b.position).filter((g) => g.name.toLowerCase().includes(q));
  const canCreate = q !== '' && groups.length > 0 && !groups.some((g) => g.name.trim().toLowerCase() === q);
  const rows = shown.length + (canCreate ? 1 : 0);
  const current = Math.max(0, Math.min(active, rows - 1));

  const create = async () => {
    if (creating.current) return;
    creating.current = true;
    setError(null);
    try {
      const g = await createGroup(qc, name, groups);
      onPick({ id: g.id, name: g.name }, scope);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      creating.current = false;
    }
  };

  const stepScope = (delta: 1 | -1) => {
    const at = options.findIndex((o) => o.scope === scope);
    setScope(options[(at + delta + options.length) % options.length]!.scope);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const step = arrowStep(e, current, rows);
    if (step !== null) {
      e.preventDefault();
      setActive(step);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      stepScope(e.key === 'ArrowRight' ? 1 : -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const g = shown[current];
      if (g) onPick({ id: g.id, name: g.name }, scope);
      else if (canCreate) void create();
    }
  };

  return (
    <PickerDialog label="Move to group" onClose={onClose}>
      {heading}
      <div className="px-4 py-2 md:p-2">
        <input
          ref={input}
          // The groups are there to tap on the phone: the keyboard opens only for someone filtering.
          autoFocus={!phone}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setActive(0);
            setError(null);
          }}
          onKeyDown={onKeyDown}
          placeholder="Filter or name a new group…"
          aria-label="Filter groups"
          className={PICKER_INPUT}
        />
      </div>
      <ScopeList
        options={options}
        value={scope}
        layout="row"
        onSelect={(s) => {
          setScope(s);
          if (!phone) input.current?.focus();
        }}
      />
      {error && <p role="alert" className="px-4 pb-2 text-xs text-danger md:px-3">{error}</p>}
      <ul className="max-h-[40dvh] overflow-y-auto border-t border-line py-1 md:max-h-[40vh]">
        {shown.map((g, i) => (
          <li key={g.id}>
            <button
              type="button"
              onClick={() => onPick({ id: g.id, name: g.name }, scope)}
              onMouseEnter={() => setActive(i)}
              className={`${PICKER_ROW} gap-3 md:gap-2 ${i === current ? 'md:bg-sel' : 'md:hover:bg-hover'}`}
            >
              <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: g.color }} />
              {g.name}
            </button>
          </li>
        ))}
        {canCreate && (
          <li>
            <button
              type="button"
              onClick={() => void create()}
              onMouseEnter={() => setActive(shown.length)}
              className={`${PICKER_ROW} gap-3 md:gap-2 ${current === shown.length ? 'md:bg-sel' : 'md:hover:bg-hover'}`}
            >
              <Plus size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-muted" />
              <span className="truncate">Create group "{name}"</span>
            </button>
          </li>
        )}
        {rows === 0 && <li className="px-4 py-2 text-muted md:px-3">{groups.length === 0 ? 'Loading groups…' : 'No group matches'}</li>}
      </ul>
      {!phone && (
        <div className="flex flex-wrap gap-3 border-t border-line px-3 py-2 text-2xs text-faint">
          <span className="flex items-center gap-1"><Kbd k="Enter" /> pick</span>
          <span className="flex items-center gap-1"><Kbd k="←→" raw /> scope</span>
          <span className="flex items-center gap-1"><Kbd k="Escape" /> cancel</span>
        </div>
      )}
    </PickerDialog>
  );
}
