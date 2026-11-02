import { useSyncExternalStore } from 'react';

/** The phone layout's breakpoint: below Tailwind's `md`. Styling should prefer `md:` variants; use this only for behaviour. */
const QUERY = '(max-width: 767px)';

function subscribe(onChange: () => void): () => void {
  const list = window.matchMedia?.(QUERY);
  list?.addEventListener('change', onChange);
  return () => list?.removeEventListener('change', onChange);
}

export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia?.(QUERY)?.matches ?? false, () => false);
}
