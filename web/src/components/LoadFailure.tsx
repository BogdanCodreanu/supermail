export const offline = (what: string) => `You're offline, so ${what} couldn't load.`;

/** Why something didn't load, in words: being offline says more than the browser's "Failed to fetch". */
export function loadFailure(what: string, error: Error): string {
  return navigator.onLine === false ? offline(what) : `Couldn't load ${what}: ${error.message}`;
}

/**
 * TanStack Query holds a fetch until the network returns, so a query with nothing cached would sit on "Loading…" for as
 * long as the phone is offline. It carries on by itself once back online.
 */
export const waitingForNetwork = (q: { isPending: boolean; fetchStatus: string }) => q.isPending && q.fetchStatus === 'paused';

export function RetryButton({ onRetry }: { onRetry(): void }) {
  return (
    <button type="button" onClick={onRetry} className="inline-flex min-h-11 cursor-pointer items-center text-accent underline max-md:active:bg-hover md:min-h-0">
      Retry
    </button>
  );
}
