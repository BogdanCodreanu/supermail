import { describe, expect, it, vi } from 'vitest';
import { createBackStack } from '../src/components/phone/backStack';

/**
 * History as real Chrome behaves (measured at 360x740): `go` resolves later, to the entry that was `delta` away when it
 * was called, and pushState meanwhile does not move that target. jsdom drops the traversal instead, so it can't stand in.
 */
function fakeWindow() {
  const entries: unknown[] = [{ idx: 0 }];
  let at = 0;
  const pending: number[] = [];
  const listeners = new Set<(e: PopStateEvent) => void>();
  const win = {
    history: {
      get state() {
        return entries[at];
      },
      pushState: vi.fn((state: unknown) => {
        entries.splice(at + 1, entries.length, state);
        at = entries.length - 1;
      }),
      replaceState: (state: unknown) => {
        entries[at] = state;
      },
      go: vi.fn((delta: number) => void pending.push(at + delta)),
    },
    addEventListener: (_: 'popstate', l: (e: PopStateEvent) => void) => void listeners.add(l),
  };
  const popTo = (i: number) => {
    at = i;
    for (const l of listeners) l({ state: entries[at] } as PopStateEvent);
  };
  return {
    win,
    /** The app's microtasks, then the traversals they queued. */
    async settle() {
      await Promise.resolve();
      await Promise.resolve();
      while (pending.length > 0) {
        popTo(pending.shift()!);
        await Promise.resolve();
        await Promise.resolve();
      }
    },
    /** The Android back gesture. */
    back: () => popTo(at - 1),
    depth: () => at,
  };
}

describe('backStack', () => {
  it('gives an open layer one history entry and keeps the state already there', async () => {
    const f = fakeWindow();
    const stack = createBackStack(f.win);
    stack.open(vi.fn());
    await f.settle();
    expect(f.win.history.pushState).toHaveBeenCalledTimes(1);
    expect(f.win.history.state).toMatchObject({ idx: 0 });
  });

  it('closes the layer on back, without another traversal', async () => {
    const f = fakeWindow();
    const stack = createBackStack(f.win);
    const onBack = vi.fn();
    const release = stack.open(onBack);
    await f.settle();
    f.back();
    release();
    await f.settle();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(f.win.history.go).not.toHaveBeenCalled();
  });

  it('takes the entry away when a layer closes some other way', async () => {
    const f = fakeWindow();
    const stack = createBackStack(f.win);
    const onBack = vi.fn();
    const release = stack.open(onBack);
    await f.settle();
    release();
    await f.settle();
    expect(f.win.history.go).toHaveBeenCalledWith(-1);
    expect(f.depth()).toBe(0);
    expect(onBack).not.toHaveBeenCalled();
  });

  it('touches no history for StrictMode: open, release and open again in one tick', async () => {
    const f = fakeWindow();
    const stack = createBackStack(f.win);
    const first = vi.fn();
    const second = vi.fn();
    stack.open(first)();
    stack.open(second);
    await f.settle();
    expect(f.win.history.pushState).toHaveBeenCalledTimes(1);
    expect(f.win.history.go).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it('passes the entry from one sheet to the next in the same tick', async () => {
    const f = fakeWindow();
    const stack = createBackStack(f.win);
    const firstBack = vi.fn();
    const secondBack = vi.fn();
    const closeFirst = stack.open(firstBack);
    await f.settle();
    closeFirst();
    stack.open(secondBack);
    await f.settle();
    expect(f.win.history.pushState).toHaveBeenCalledTimes(1);
    expect(f.win.history.go).not.toHaveBeenCalled();
    expect(secondBack).not.toHaveBeenCalled();
    f.back();
    expect(secondBack).toHaveBeenCalledTimes(1);
    expect(firstBack).not.toHaveBeenCalled();
  });

  it('keeps a sheet opened while the last close is still travelling back', async () => {
    const f = fakeWindow();
    const stack = createBackStack(f.win);
    const closeFirst = stack.open(vi.fn());
    await f.settle();
    closeFirst();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.win.history.go).toHaveBeenCalledTimes(1);
    const later = vi.fn();
    stack.open(later);
    await f.settle();
    expect(later).not.toHaveBeenCalled();
    expect(f.depth()).toBe(1);
  });

  it('closes only the top layer on back, so a sheet closes before the selection under it', async () => {
    const f = fakeWindow();
    const stack = createBackStack(f.win);
    const selection = vi.fn();
    const sheet = vi.fn();
    stack.open(selection);
    await f.settle();
    stack.open(sheet);
    await f.settle();
    f.back();
    expect(sheet).toHaveBeenCalledTimes(1);
    expect(selection).not.toHaveBeenCalled();
    f.back();
    expect(selection).toHaveBeenCalledTimes(1);
  });

  it('takes one trip back when two layers close together', async () => {
    const f = fakeWindow();
    const stack = createBackStack(f.win);
    const closeSelection = stack.open(vi.fn());
    const closeSheet = stack.open(vi.fn());
    await f.settle();
    closeSheet();
    closeSelection();
    await f.settle();
    expect(f.win.history.go).toHaveBeenCalledTimes(1);
    expect(f.win.history.go).toHaveBeenCalledWith(-2);
    expect(f.depth()).toBe(0);
  });

  it('leaves a screen the router pushed on top alone when a layer under it closes', async () => {
    const f = fakeWindow();
    const stack = createBackStack(f.win);
    const release = stack.open(vi.fn());
    await f.settle();
    f.win.history.pushState({ idx: 1 });
    release();
    await f.settle();
    expect(f.win.history.go).not.toHaveBeenCalled();
    expect(f.depth()).toBe(2);
  });

  it('steps over a leftover entry on the way back', async () => {
    const f = fakeWindow();
    const stack = createBackStack(f.win);
    const release = stack.open(vi.fn());
    await f.settle();
    f.win.history.pushState({ idx: 1 });
    release();
    await f.settle();
    f.back();
    await f.settle();
    expect(f.depth()).toBe(0);
  });

  it('runs settled work only after the entry has gone, so a navigation is not undone by the traversal', async () => {
    const f = fakeWindow();
    const stack = createBackStack(f.win);
    const release = stack.open(vi.fn());
    await f.settle();
    let depthThen = -1;
    release();
    stack.whenSettled(() => (depthThen = f.depth()));
    await f.settle();
    expect(depthThen).toBe(0);
  });

  it('still runs settled work when the traversal never answers', async () => {
    vi.useFakeTimers();
    try {
      const f = fakeWindow();
      f.win.history.go.mockImplementation(() => undefined);
      const stack = createBackStack(f.win);
      const release = stack.open(vi.fn());
      await Promise.resolve();
      await Promise.resolve();
      const then = vi.fn();
      release();
      stack.whenSettled(then);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(then).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
