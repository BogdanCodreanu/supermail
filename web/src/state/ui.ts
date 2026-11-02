import { useCallback, useSyncExternalStore } from 'react';

// Small per-browser UI preferences. They are shared by every component through a module-level store
// (so the panel and its toggle agree) and mirrored to localStorage when it is available. Storage can
// throw (private windows, blocked site data); the in-memory value keeps working then.

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // keep the in-memory value only
  }
}

function persistedStore<T>(key: string, decode: (raw: string | null) => T, encode: (v: T) => string | null) {
  let loaded = false;
  let value: T;
  const listeners = new Set<() => void>();
  return {
    get(): T {
      if (!loaded) {
        value = decode(readStorage(key));
        loaded = true;
      }
      return value;
    },
    set(v: T): void {
      value = v;
      loaded = true;
      writeStorage(key, encode(v));
      for (const l of listeners) l();
    },
    subscribe(l: () => void): () => void {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

const panelCollapsed = persistedStore(
  'sm.panelCollapsed',
  (raw) => raw === '1',
  (v) => (v ? '1' : '0'),
);

const accountFilter = persistedStore<string | null>(
  'sm.accountFilter',
  (raw) => (raw ? raw : null),
  (v) => v,
);

const showDone = persistedStore(
  'sm.showDone',
  (raw) => raw === '1',
  (v) => (v ? '1' : '0'),
);

function useStore<T>(store: ReturnType<typeof persistedStore<T>>): [T, (v: T) => void] {
  const value = useSyncExternalStore(store.subscribe, store.get, store.get);
  const set = useCallback((v: T) => store.set(v), [store]);
  return [value, set];
}

/** Whether the shortcut cheat-sheet panel is collapsed (`?`). Remembered in `sm.panelCollapsed`. */
export function usePanelCollapsed(): [boolean, (v: boolean) => void] {
  return useStore(panelCollapsed);
}

/** The account the inbox is filtered to; null means all accounts. Remembered in `sm.accountFilter`. */
export function useAccountFilter(): [string | null, (id: string | null) => void] {
  return useStore(accountFilter);
}

/** Whether the inbox also lists recently Done threads. Remembered in `sm.showDone`. */
export function useShowDone(): [boolean, (v: boolean) => void] {
  return useStore(showDone);
}

/** True while the window is at most `maxWidth` wide. False where the browser cannot say. */
export function useNarrowWindow(maxWidth: number): boolean {
  const query = `(max-width: ${maxWidth}px)`;
  const subscribe = useCallback(
    (l: () => void) => {
      if (typeof window.matchMedia !== 'function') return () => {};
      const mq = window.matchMedia(query);
      mq.addEventListener('change', l);
      return () => mq.removeEventListener('change', l);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
}
