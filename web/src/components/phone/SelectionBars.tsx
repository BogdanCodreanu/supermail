import { EllipsisVertical, X } from 'lucide-react';
import { useState } from 'react';
import { BottomSheet } from '../BottomSheet';
import type { BulkBarAction } from '../BulkBar';
import { barButton } from './AppBar';

/** Fit across a phone with room for their names; the rest are one tap further, in a sheet. */
const ON_THE_BAR = 4;

const action = 'flex h-14 min-h-11 min-w-0 touch-manipulation flex-col items-center justify-center gap-0.5 rounded text-2xs text-muted active:bg-hover';

/** The app bar in selection mode: leave, how many, and the touch version of Ctrl+A. */
export function SelectionTopBar({ count, loading, onClose, onSelectBelow }: { count: number; loading: boolean; onClose(): void; onSelectBelow(): void }) {
  return (
    <>
      <button type="button" aria-label="Close selection" onClick={onClose} className={barButton}>
        <X size={20} strokeWidth={1.75} aria-hidden />
      </button>
      <span aria-live="polite" className="min-w-0 flex-1 truncate text-base font-semibold tabular-nums">
        {loading ? 'Selecting…' : `${count} selected`}
      </span>
      <button type="button" disabled={loading} onClick={onSelectBelow} className="h-11 shrink-0 touch-manipulation rounded px-2 text-sm font-medium text-accent active:bg-hover disabled:opacity-50">
        Select all below
      </button>
    </>
  );
}

/** The bulk actions on the phone: the bar under the list, above the gesture bar. */
export function SelectionBar({ actions }: { actions: BulkBarAction[] }) {
  const [more, setMore] = useState(false);
  const rest = actions.slice(ON_THE_BAR);
  return (
    <div data-testid="selection-bar" data-bottom-bar className="shrink-0 border-t border-line bg-panel pb-[env(safe-area-inset-bottom)]">
      <div role="toolbar" aria-label="Actions on the selection" className="grid grid-cols-5 gap-2 px-2">
        {actions.slice(0, ON_THE_BAR).map((a) => (
          <button key={a.label} type="button" onClick={a.run} className={action}>
            <a.icon size={20} strokeWidth={1.75} aria-hidden />
            <span className="max-w-full truncate">{a.label}</span>
          </button>
        ))}
        <button type="button" aria-label="More actions" aria-haspopup="dialog" onClick={() => setMore(true)} className={action}>
          <EllipsisVertical size={20} strokeWidth={1.75} aria-hidden />
          <span aria-hidden>More</span>
        </button>
      </div>
      {more && (
        <BottomSheet label="More actions" hideTitle onClose={() => setMore(false)}>
          <div className="pb-1">
            {rest.map((a) => (
              <button
                key={a.label}
                type="button"
                onClick={() => {
                  setMore(false);
                  a.run();
                }}
                className="flex min-h-12 w-full touch-manipulation items-center gap-4 px-4 text-left text-base active:bg-hover"
              >
                <a.icon size={20} strokeWidth={1.75} aria-hidden className="shrink-0 text-muted" />
                {a.label}
              </button>
            ))}
          </div>
        </BottomSheet>
      )}
    </div>
  );
}
