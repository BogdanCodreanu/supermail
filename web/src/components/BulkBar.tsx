import type { LucideIcon } from 'lucide-react';
import { Kbd } from './Kbd';

export interface BulkBarAction { label: string; icon: LucideIcon; keyHint: string | undefined; run(): void }

export interface BulkBarProps {
  count: number;
  /** Ctrl+A is still fetching the rows below. */
  loading: boolean;
  actions: BulkBarAction[];
  onClear(): void;
}

const button = 'inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-1 transition-colors duration-150 ease-out hover:bg-hover';

/**
 * Takes the status strip's place while threads are selected, on the same fixed line so rows never move. The labels
 * give way first on a narrow window, then the key hints; the buttons scroll sideways rather than wrap.
 */
export function BulkBar({ count, loading, actions, onClear }: BulkBarProps) {
  return (
    <div data-testid="bulk-bar" className="flex h-8 shrink-0 items-center gap-2 border-t border-line bg-panel px-4 text-xs text-muted">
      <span className="shrink-0 font-semibold tabular-nums text-fg">{loading ? 'Selecting…' : `${count} selected`}</span>
      <span aria-hidden className="text-faint">
        ·
      </span>
      <button type="button" onClick={onClear} className={`${button} font-medium text-accent`}>
        Clear
      </button>
      {!loading && (
        <div role="toolbar" aria-label="Actions on the selection" className="ml-2 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {actions.map((a) => (
            <button key={a.label} type="button" aria-label={a.label} title={a.keyHint ? `${a.label} (${a.keyHint})` : a.label} onClick={a.run} className={`${button} text-muted hover:text-fg`}>
              <a.icon size={16} strokeWidth={1.75} aria-hidden />
              <span className="hidden xl:inline">{a.label}</span>
              {a.keyHint && (
                <span className="hidden sm:inline-flex">
                  <Kbd k={a.keyHint} />
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
