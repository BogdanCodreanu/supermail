import { Bell, X } from 'lucide-react';
import { useState } from 'react';
import { usePushStatus, useTurnOnPush } from '../../lib/usePush';

const DISMISSED = 'supermail.pushBannerDismissed';

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED) === '1';
  } catch {
    return false;
  }
}

function remember(): void {
  try {
    localStorage.setItem(DISMISSED, '1');
  } catch {
    // Private mode: it comes back next time.
  }
}

/** The one nudge to turn notifications on, at the top of the phone inbox. Once dismissed it stays gone; Settings still has the switch. */
export function PushBanner() {
  const [dismissed, setDismissed] = useState(wasDismissed);
  const { data } = usePushStatus();
  const turnOn = useTurnOnPush();
  if (dismissed || (data?.state !== 'off' && data?.state !== 'again')) return null;
  return (
    <div role="region" aria-label="Notifications" className="shrink-0 border-b border-line bg-panel pl-4 pr-1 text-sm">
      <div className="flex min-h-11 items-center gap-2">
        <Bell size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1">{data.state === 'again' ? 'Turn notifications on again' : 'Get notified about new mail'}</span>
        <button type="button" disabled={turnOn.isPending} onClick={() => turnOn.mutate()} className="inline-flex h-11 shrink-0 cursor-pointer items-center rounded px-2 font-medium text-accent active:bg-hover disabled:opacity-40">
          {turnOn.isPending ? 'Turning on…' : 'Turn on'}
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => {
            remember();
            setDismissed(true);
          }}
          className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded text-muted active:bg-hover"
        >
          <X size={16} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      {turnOn.error && (
        <p role="alert" className="pb-2 pr-3 text-xs text-danger">
          Couldn't turn notifications on: {turnOn.error.message}
        </p>
      )}
    </div>
  );
}
