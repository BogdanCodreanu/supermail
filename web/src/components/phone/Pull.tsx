import { forwardRef } from 'react';
import { PULL_LABEL, type PullState } from './usePullToRefresh';

/** The small note that slides down with a pull and says how it went, then leaves. */
export const PullIndicator = forwardRef<HTMLDivElement, { state: PullState }>(function PullIndicator({ state }, ref) {
  return (
    <div ref={ref} aria-live="polite" style={{ transform: 'translateY(-48px)' }} className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center">
      {state !== 'idle' && <span className="rounded-full border border-line bg-panel px-3 py-1 text-xs text-muted shadow">{PULL_LABEL[state]}</span>}
    </div>
  );
});
