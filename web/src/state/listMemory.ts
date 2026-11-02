// Where the owner was in each inbox list, so coming back from a thread lands on the same row at the
// same scroll offset. The inbox unmounts while a thread is open, so this lives outside React. It is
// per tab and in memory only: a reload starts at the top, like a fresh visit.

export interface ListPosition {
  /** The selected thread. */
  selId: string | null;
  /** Its row number, so a thread that left the list meanwhile falls back to the row now in its place. */
  index: number;
  scrollTop: number;
  /** The threads ticked for a bulk action, so opening one email does not lose them. */
  checked: string[];
}

const positions = new Map<string, ListPosition>();
let opened: string | null = null;

/** One list per (account filter, group); null means all accounts / the All tab. */
export function listKey(accountId: string | null, groupId: string | null): string {
  return JSON.stringify([accountId, groupId]);
}

export function readListMemory(key: string): ListPosition | undefined {
  return positions.get(key);
}

export function writeListMemory(key: string, patch: Partial<ListPosition>): void {
  positions.set(key, { selId: null, index: 0, scrollTop: 0, checked: [], ...positions.get(key), ...patch });
}

/**
 * The thread view moves between threads (j/k, Done continues to the next one). The app notes each
 * thread it shows, and the inbox selects the last one when it comes back.
 */
export function noteOpenedThread(id: string): void {
  opened = id;
}

/** The last thread shown since the inbox last called `forgetOpenedThread`, or null. */
export function lastOpenedThread(): string | null {
  return opened;
}

export function forgetOpenedThread(): void {
  opened = null;
}

/** For tests. */
export function clearListMemory(): void {
  positions.clear();
  opened = null;
}
