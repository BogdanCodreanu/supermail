import { beforeEach, describe, expect, it } from 'vitest';
import { clearListMemory, forgetOpenedThread, lastOpenedThread, listKey, noteOpenedThread, readListMemory, writeListMemory } from '../src/state/listMemory';

beforeEach(() => clearListMemory());

describe('listMemory', () => {
  it('keys lists by account and group, with null meaning all', () => {
    expect(listKey(null, null)).not.toBe(listKey('a', null));
    expect(listKey('a', null)).not.toBe(listKey(null, 'a'));
    expect(listKey('a', 'dev')).toBe(listKey('a', 'dev'));
  });

  it('remembers the selection and scroll offset per list, merging partial writes', () => {
    writeListMemory(listKey('a', 'dev'), { selId: 'a:2', index: 1 });
    writeListMemory(listKey('a', 'dev'), { scrollTop: 120 });
    writeListMemory(listKey(null, null), { selId: 'b:1', index: 4, scrollTop: 300 });
    expect(readListMemory(listKey('a', 'dev'))).toEqual({ selId: 'a:2', index: 1, scrollTop: 120, checked: [] });
    expect(readListMemory(listKey(null, null))).toEqual({ selId: 'b:1', index: 4, scrollTop: 300, checked: [] });
    expect(readListMemory(listKey('b', null))).toBeUndefined();
  });

  it('keeps the last opened thread until the inbox forgets it', () => {
    expect(lastOpenedThread()).toBeNull();
    noteOpenedThread('a:1');
    noteOpenedThread('a:2');
    expect(lastOpenedThread()).toBe('a:2');
    expect(lastOpenedThread()).toBe('a:2');
    forgetOpenedThread();
    expect(lastOpenedThread()).toBeNull();
  });
});
