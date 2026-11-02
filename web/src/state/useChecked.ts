import { MAX_BULK_IDS, type ThreadId, type ThreadSummaryDTO } from '@supermail/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { readListMemory, writeListMemory } from './listMemory';
import { showToast } from './toasts';

const NONE: ReadonlySet<ThreadId> = new Set();

const tooMany = () => showToast(`One action can take at most ${MAX_BULK_IDS} threads`);

/**
 * The threads ticked for a bulk action in one list (the "selection"; the row under the keyboard is the cursor).
 * A range runs from the anchor, the row last ticked, and is laid over what was ticked before it, so moving back
 * shrinks the range and nothing else. Rows that left the list stop counting.
 */
export function useChecked(threads: ThreadSummaryDTO[], key: string) {
  const [ids, setIds] = useState<ReadonlySet<ThreadId>>(() => new Set(readListMemory(key)?.checked));
  const latest = useRef(ids); // several keys in one tick each build on the last
  const anchor = useRef<{ id: ThreadId; base: ReadonlySet<ThreadId> } | null>(null);
  const commit = (next: ReadonlySet<ThreadId>) => {
    latest.current = next;
    setIds(next);
  };
  useEffect(() => writeListMemory(key, { checked: [...ids] }), [key, ids]);

  const rows = useMemo(() => threads.filter((t) => ids.has(t.id)), [threads, ids]);

  return {
    ids,
    rows,
    toggle(id: ThreadId) {
      const next = new Set(latest.current);
      if (!next.delete(id)) {
        if (next.size >= MAX_BULK_IDS) return tooMany();
        next.add(id);
      }
      anchor.current = { id, base: next };
      commit(next);
    },
    /** Ticks from the anchor to `id`. With no anchor in the list, the range starts at `from`. */
    extendTo(id: ThreadId, from: ThreadId) {
      const order = threads.map((t) => t.id);
      const a = anchor.current && order.includes(anchor.current.id) ? anchor.current : { id: from, base: latest.current };
      anchor.current = a;
      const [start, end] = [order.indexOf(a.id), order.indexOf(id)].sort((x, y) => x - y) as [number, number];
      const next = new Set(a.base);
      for (const t of order.slice(start, end + 1)) next.add(t);
      if (next.size > MAX_BULK_IDS) return tooMany();
      commit(next);
    },
    /** Ticks `list` as far as the limit goes, and says whether all of it fitted. */
    add(list: ThreadId[]): boolean {
      const next = new Set(latest.current);
      for (const t of list) if (next.size < MAX_BULK_IDS) next.add(t);
      anchor.current = list[0] === undefined ? null : { id: list[0], base: next };
      commit(next);
      return list.every((t) => next.has(t));
    },
    clear() {
      anchor.current = null;
      if (latest.current.size > 0) commit(NONE);
    },
  };
}
