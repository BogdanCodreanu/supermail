import { useEffect, useRef } from 'react';

// What Android's back gesture closes first: sheets, then selection mode, then the screen. Each open layer holds one
// history entry, and only the top layer answers back.
//
// One stack does the history for all of them because `history.go` is asynchronous and aims at the entry it was called
// from: go(-1) then pushState lands on the entry before both (measured in Chrome), which would close the sheet just
// opened. So layers change at once and history follows a tick later, netting everything out: a sheet handing over to
// the next one, or StrictMode's second run of an effect, touches no history at all.

const MARK = 'backLayer';

/** How long a traversal may take before settled work runs anyway. */
const STALL_MS = 500;

export interface BackWindow {
  history: Pick<History, 'state' | 'pushState' | 'go'>;
  addEventListener(type: 'popstate', listener: (e: PopStateEvent) => void): void;
}

interface Layer { onBack(): void }

const depthOf = (state: unknown): number => (state as { [MARK]?: number } | null)?.[MARK] ?? 0;

export function createBackStack(win: BackWindow) {
  const layers: Layer[] = [];
  /** Our entries up to the current one. */
  let entries = 0;
  let queued = false;
  let stall: ReturnType<typeof setTimeout> | null = null;
  const settled: (() => void)[] = [];

  const arrived = () => {
    if (stall !== null) clearTimeout(stall);
    stall = null;
  };

  const sync = () => {
    queued = false;
    if (stall !== null) return; // the popstate comes back here
    // The router went on from one of our entries: it stays under that screen, and back steps over it later.
    entries = Math.min(entries, depthOf(win.history.state));
    while (entries < layers.length) win.history.pushState({ ...(win.history.state as object | null), [MARK]: ++entries }, '');
    if (entries > layers.length) {
      const delta = layers.length - entries;
      entries = layers.length;
      stall = setTimeout(() => {
        arrived();
        schedule();
      }, STALL_MS);
      win.history.go(delta);
      return;
    }
    for (const run of settled.splice(0)) run();
  };

  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(sync);
  };

  win.addEventListener('popstate', (e) => {
    if (stall !== null) {
      arrived();
    } else {
      const depth = depthOf(e.state);
      entries = depth;
      while (layers.length > depth) layers.pop()!.onBack();
    }
    schedule();
  });

  return {
    /** Adds a layer on top; the function returned takes it away when it closes some other way than back. */
    open(onBack: () => void): () => void {
      const layer: Layer = { onBack };
      layers.push(layer);
      schedule();
      return () => {
        const at = layers.indexOf(layer);
        if (at === -1) return;
        layers.splice(at, 1);
        schedule();
      };
    },
    /** Runs `fn` once history has caught up with the layers: navigate from here, never straight after closing a sheet. */
    whenSettled(fn: () => void): void {
      settled.push(fn);
      schedule();
    },
  };
}

const backStack = createBackStack(window);

export const whenBackSettled = backStack.whenSettled;

/** While `active`, Android's back gesture calls `onBack` instead of leaving the screen. */
export function useBackLayer(active: boolean, onBack: () => void): void {
  const latest = useRef(onBack);
  latest.current = onBack;
  useEffect(() => {
    if (!active) return;
    return backStack.open(() => latest.current());
  }, [active]);
}
