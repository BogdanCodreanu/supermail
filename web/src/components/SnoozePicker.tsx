import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { formatWhen, parseSnooze, presets } from '../lib/snoozeTimes';
import { useIsPhone } from '../lib/useIsPhone';
import { BottomSheet } from './BottomSheet';
import { Kbd } from './Kbd';

/**
 * The modal shell shared by the pickers. Escape closes it and never reaches the page's shortcuts
 * (so Escape in a thread closes the picker instead of going back); a click outside closes it too.
 * On the phone it is a bottom sheet.
 */
export function PickerDialog({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const phone = useIsPhone();
  if (phone) {
    return (
      <BottomSheet label={label} onClose={onClose}>
        <div className="pb-2">{children}</div>
      </BottomSheet>
    );
  }
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center px-4 pt-[15vh]">
      <div aria-hidden className="absolute inset-0 bg-bg opacity-60" onMouseDown={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="relative w-full max-w-[360px] overflow-hidden rounded-lg border border-line bg-bg shadow-xl"
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }}
      >
        <div className="border-b border-line px-3 py-2 text-2xs font-semibold uppercase tracking-wider text-faint">{label}</div>
        {children}
      </div>
    </div>
  );
}

/** Moves a highlighted index with the arrow keys, wrapping at both ends. */
export function arrowStep(e: KeyboardEvent, index: number, count: number): number | null {
  if (count === 0) return null;
  if (e.key === 'ArrowDown') return (index + 1) % count;
  if (e.key === 'ArrowUp') return (index - 1 + count) % count;
  return null;
}

export interface SnoozePickerProps { open: boolean; onPick(at: Date): void; onClose(): void }

/** The rows of a picker: full width and 48px on the phone. */
export const PICKER_ROW = 'flex h-12 w-full cursor-pointer items-center px-4 text-left text-base max-md:active:bg-hover md:h-8 md:px-3 md:text-sm';

/** The field of a picker. The phone's is 16px, so Android doesn't zoom in on it. */
export const PICKER_INPUT = 'h-12 w-full rounded border border-line bg-bg px-3 text-[16px] focus:border-accent md:h-8 md:px-2 md:text-sm';

/** Snooze presets plus a typed natural time ("fri 9am"). Arrows pick a preset, Enter confirms, Esc closes. */
export function SnoozePicker({ open, onPick, onClose }: SnoozePickerProps) {
  if (!open) return null;
  return <SnoozeBody onPick={onPick} onClose={onClose} />;
}

function SnoozeBody({ onPick, onClose }: Omit<SnoozePickerProps, 'open'>) {
  const options = useMemo(() => presets(new Date()), []);
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const typed = text.trim() ? parseSnooze(text, new Date()) : null;
  const phone = useIsPhone();

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const step = text.trim() ? null : arrowStep(e, active, options.length);
    if (step !== null) {
      e.preventDefault();
      setActive(step);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!text.trim()) onPick(options[active]!.at);
      else if (typed) onPick(typed);
    }
  };

  return (
    <PickerDialog label="Snooze until…" onClose={onClose}>
      <div className="px-4 py-2 md:p-2">
        <input
          // The presets come first on the phone: the keyboard opens only for someone typing a time.
          autoFocus={!phone}
          enterKeyHint="done"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type a time: fri 9am, in 2 hours…"
          aria-label="Snooze until"
          className={PICKER_INPUT}
        />
        {text.trim() && !(phone && typed) && (
          <p className={`px-1 pt-1.5 text-xs ${typed ? 'text-accent' : 'text-muted'}`}>
            {typed ? `${formatWhen(typed)} — press Enter` : "Can't read that as a future time"}
          </p>
        )}
      </div>
      {phone && typed && (
        <button type="button" onClick={() => onPick(typed)} className={`${PICKER_ROW} text-accent`}>
          Snooze until {formatWhen(typed)}
        </button>
      )}
      <ul className="pb-1">
        {options.map((o, i) => (
          <li key={o.label}>
            <button
              type="button"
              onClick={() => onPick(o.at)}
              onMouseEnter={() => setActive(i)}
              className={`${PICKER_ROW} justify-between ${!text.trim() && i === active ? 'md:bg-sel' : 'md:hover:bg-hover'}`}
            >
              <span>{o.label}</span>
              <span className="text-xs text-muted">{formatWhen(o.at)}</span>
            </button>
          </li>
        ))}
      </ul>
      {!phone && (
        <div className="flex gap-3 border-t border-line px-3 py-2 text-2xs text-faint">
          <span className="flex items-center gap-1"><Kbd k="Enter" /> snooze</span>
          <span className="flex items-center gap-1"><Kbd k="Escape" /> cancel</span>
        </div>
      )}
    </PickerDialog>
  );
}
