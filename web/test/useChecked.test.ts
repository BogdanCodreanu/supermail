import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThreadSummaryDTO } from '@supermail/shared';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../src/state/toasts', () => ({ showToast: toast }));

import { clearListMemory, listKey } from '../src/state/listMemory';
import { useChecked } from '../src/state/useChecked';

const rows = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `a:${i}` }) as ThreadSummaryDTO);
const ids = (from: number, to: number) => rows(to).slice(from).map((t) => t.id);

function checked(count: number) {
  return renderHook(() => useChecked(rows(count), listKey(null, null))).result;
}

beforeEach(() => {
  toast.mockReset();
  clearListMemory();
});

describe('useChecked, at the limit of one action', () => {
  it('add stops at 1000 and says it did not all fit', () => {
    const c = checked(1200);
    let fitted = true;
    act(() => void (fitted = c.current.add(ids(0, 1200))));
    expect(fitted).toBe(false);
    expect(c.current.ids.size).toBe(1000);
  });

  it('add says so when all of it fits', () => {
    const c = checked(10);
    let fitted = false;
    act(() => void (fitted = c.current.add(ids(0, 10))));
    expect(fitted).toBe(true);
  });

  it('x past the limit is refused, with a reason', () => {
    const c = checked(1001);
    act(() => void c.current.add(ids(0, 1000)));
    act(() => c.current.toggle('a:1000'));
    expect(c.current.ids.size).toBe(1000);
    expect(c.current.ids.has('a:1000')).toBe(false);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('1000'));
  });

  it('x still takes a row off at the limit', () => {
    const c = checked(1000);
    act(() => void c.current.add(ids(0, 1000)));
    act(() => c.current.toggle('a:5'));
    expect(c.current.ids.size).toBe(999);
    expect(toast).not.toHaveBeenCalled();
  });

  it('a range past the limit is refused whole', () => {
    const c = checked(1100);
    act(() => void c.current.add(ids(0, 1000)));
    act(() => c.current.extendTo('a:1050', 'a:0'));
    expect(c.current.ids.size).toBe(1000);
    expect(toast).toHaveBeenCalled();
  });

  it('several keys in one tick each build on the last', () => {
    const c = checked(5);
    act(() => {
      c.current.toggle('a:0');
      c.current.toggle('a:1');
    });
    expect([...c.current.ids]).toEqual(['a:0', 'a:1']);
  });
});
