import { fireEvent, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BINDINGS, bindingsFor, type KeyContext } from '../src/keys/keymap';
import { useShortcuts } from '../src/keys/useShortcuts';

const CONTEXTS: KeyContext[] = ['list', 'thread', 'compose', 'skipped', 'settings', 'search', 'spam', 'spamReader'];
const ids = (bs: { id: string }[]) => bs.map((b) => b.id);

describe('keymap', () => {
  it('compose Write has send, and composing offers nothing to triage', () => {
    expect(ids(bindingsFor('compose').Write)).toContain('send');
    expect(bindingsFor('compose').Triage).toEqual([]);
  });

  it.each([
    ['next', 'Navigate'], ['nextMessage', 'Navigate'], ['open', 'Navigate'], ['back', 'Navigate'], ['nextGroup', 'Navigate'],
    ['group9', 'Navigate'], ['cycleAccount', 'Navigate'], ['done', 'Triage'], ['snooze', 'Triage'], ['toggleRead', 'Triage'],
    ['undo', 'Triage'], ['restore', 'Triage'], ['reply', 'Write'], ['replyAll', 'Write'], ['forward', 'Write'], ['compose', 'Write'],
    ['send', 'Write'], ['important', 'Teach'], ['notImportant', 'Teach'], ['groupTo', 'Teach'], ['search', 'Find'], ['palette', 'Find'],
    ['togglePanel', 'View'],
  ])('%s belongs to %s', (id, section) => {
    expect(BINDINGS.find((b) => b.id === id)?.section).toBe(section);
  });

  it.each(CONTEXTS)('has no duplicate keys within the %s context', (ctx) => {
    const keys = BINDINGS.filter((b) => b.contexts.includes(ctx)).flatMap((b) => b.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('x, Ctrl+a and the range keys are Triage keys of the inbox list alone', () => {
    const byId = new Map(BINDINGS.map((b) => [b.id, b]));
    expect(byId.get('select')).toMatchObject({ keys: ['x'], section: 'Triage', contexts: ['list'] });
    expect(byId.get('selectToBottom')).toMatchObject({ keys: ['Ctrl+a'], section: 'Triage', contexts: ['list'] });
    expect(byId.get('extendDown')).toMatchObject({ keys: ['Shift+j'], section: 'Triage', contexts: ['list'] });
    expect(byId.get('extendUp')).toMatchObject({ keys: ['Shift+k'], section: 'Triage', contexts: ['list'] });
    expect(byId.get('clearSelection')).toMatchObject({ keys: ['Escape'], section: 'Triage', contexts: ['list'] });
  });

  it('n / p move between the messages of a thread, listed under Navigate', () => {
    const navigate = bindingsFor('thread').Navigate;
    expect(navigate.find((b) => b.id === 'nextMessage')).toMatchObject({ keys: ['n'], label: 'Next message' });
    expect(navigate.find((b) => b.id === 'prevMessage')).toMatchObject({ keys: ['p'], label: 'Previous message' });
    expect(ids(bindingsFor('list').Navigate)).not.toContain('nextMessage');
  });

  it('has unique ids', () => {
    expect(new Set(ids(BINDINGS)).size).toBe(BINDINGS.length);
  });

  it('lists the decided bindings with their keys', () => {
    const byId = new Map(BINDINGS.map((b) => [b.id, b]));
    expect(byId.get('done')?.keys).toEqual(['e']);
    expect(byId.get('send')?.keys).toEqual(['Ctrl+Enter']);
    expect(byId.get('palette')?.keys).toEqual(['Ctrl+k']);
    expect(byId.get('group9')?.keys).toEqual(['9']);
    expect(byId.get('restore')).toMatchObject({ keys: ['i'], section: 'Triage', contexts: ['skipped'] });
    expect(byId.get('togglePanel')?.contexts).toEqual(CONTEXTS);
  });

  it('skipped context offers move, open and restore but not done', () => {
    const all = Object.values(bindingsFor('skipped')).flat();
    expect(ids(all)).toEqual(expect.arrayContaining(['next', 'prev', 'open', 'restore', 'togglePanel']));
    expect(ids(all)).not.toContain('done');
  });

  it('next / previous group are ] and [, and Tab is never bound (it belongs to the browser)', () => {
    const byId = new Map(BINDINGS.map((b) => [b.id, b]));
    expect(byId.get('nextGroup')?.keys).toEqual([']']);
    expect(byId.get('prevGroup')?.keys).toEqual(['[']);
    expect(BINDINGS.flatMap((b) => b.keys)).not.toContain('Tab');
  });

  it.each(['settings', 'search', 'skipped', 'spam', 'spamReader'] as const)('Escape goes back in the %s context', (ctx) => {
    expect(ids(bindingsFor(ctx).Navigate)).toContain('back');
  });

  it('settings offers no list keys; search offers moving and opening but no actions on mail', () => {
    const settings = ids(Object.values(bindingsFor('settings')).flat());
    expect(settings).toEqual(expect.arrayContaining(['back', 'search', 'compose', 'palette', 'togglePanel']));
    expect(settings).not.toContain('next');
    expect(settings).not.toContain('done');
    const search = ids(Object.values(bindingsFor('search')).flat());
    expect(search).toEqual(expect.arrayContaining(['next', 'prev', 'open', 'back', 'search']));
    expect(search).not.toContain('done');
    expect(search).not.toContain('nextGroup');
  });

  it('the list shows or hides done mail with d', () => {
    expect(BINDINGS.find((b) => b.id === 'toggleDone')).toMatchObject({ keys: ['d'], contexts: ['list'] });
  });

  it('reply, reply all and forward work from the list as well as the thread', () => {
    for (const id of ['reply', 'replyAll', 'forward']) expect(BINDINGS.find((b) => b.id === id)?.contexts).toEqual(['list', 'thread']);
  });

  it('skipped has undo (z) like the inbox', () => {
    expect(ids(bindingsFor('skipped').Triage)).toEqual(expect.arrayContaining(['restore', 'undo']));
  });

  it('! reports spam from the list and the thread, under Triage', () => {
    expect(BINDINGS.find((b) => b.id === 'reportSpam')).toMatchObject({ keys: ['!'], label: 'Report spam', section: 'Triage', contexts: ['list', 'thread'] });
    expect(ids(bindingsFor('list').Triage)).toEqual(['done', 'snooze', 'reportSpam', 'toggleRead', 'undo', 'select', 'selectToBottom', 'extendDown', 'extendUp', 'clearSelection']);
  });

  it('i is Not spam on the Spam screen and in its reader', () => {
    expect(BINDINGS.find((b) => b.id === 'notSpam')).toMatchObject({ keys: ['i'], label: 'Not spam', section: 'Triage', contexts: ['spam', 'spamReader'] });
  });

  it('the Spam screen lists only the keys it has', () => {
    expect(ids(Object.values(bindingsFor('spam')).flat()).sort()).toEqual(['back', 'compose', 'next', 'notSpam', 'open', 'palette', 'prev', 'search', 'togglePanel', 'undo']);
  });

  it('the spam reader lists no moving, reply, Done, snooze or teaching keys', () => {
    expect(ids(Object.values(bindingsFor('spamReader')).flat()).sort()).toEqual(['back', 'compose', 'notSpam', 'palette', 'search', 'togglePanel', 'undo']);
  });

  it('bindingsFor returns every section, possibly empty', () => {
    expect(Object.keys(bindingsFor('compose')).sort()).toEqual(['Find', 'Navigate', 'Teach', 'Triage', 'View', 'Write']);
    expect(bindingsFor('compose').Teach).toEqual([]);
  });
});

describe('useShortcuts', () => {
  function typingArea(tag: 'textarea' | 'input' | 'div' = 'textarea') {
    const el = document.createElement(tag);
    if (tag === 'div') el.setAttribute('contenteditable', 'true');
    document.body.appendChild(el);
    el.focus();
    return el;
  }

  it('fires the handler for a key in the current context', () => {
    const done = vi.fn();
    renderHook(() => useShortcuts('list', { done }));
    fireEvent.keyDown(document.body, { key: 'e' });
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('does not fire done while typing e in a textarea', () => {
    const done = vi.fn();
    renderHook(() => useShortcuts('list', { done }));
    const ta = typingArea();
    fireEvent.keyDown(ta, { key: 'e' });
    expect(done).not.toHaveBeenCalled();
    ta.remove();
  });

  it.each(['input', 'div'] as const)('ignores plain keys in %s fields', (tag) => {
    const next = vi.fn();
    renderHook(() => useShortcuts('list', { next }));
    const el = typingArea(tag);
    fireEvent.keyDown(el, { key: 'j' });
    expect(next).not.toHaveBeenCalled();
    el.remove();
  });

  it('still fires Escape and Ctrl+Enter inside a textarea', () => {
    const back = vi.fn();
    const send = vi.fn();
    renderHook(() => useShortcuts('compose', { back, send }));
    const ta = typingArea();
    fireEvent.keyDown(ta, { key: 'Escape' });
    fireEvent.keyDown(ta, { key: 'Enter', ctrlKey: true });
    expect(back).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    ta.remove();
  });

  it('ignores keys bound only in other contexts', () => {
    const done = vi.fn();
    renderHook(() => useShortcuts('compose', { done }));
    fireEvent.keyDown(document.body, { key: 'e' });
    expect(done).not.toHaveBeenCalled();
  });

  it('tells Shift+j from j where Shift+j is bound, and treats Shift+e as e where it is not', () => {
    const next = vi.fn();
    const extendDown = vi.fn();
    const done = vi.fn();
    renderHook(() => useShortcuts('list', { next, extendDown, done }));
    fireEvent.keyDown(document.body, { key: 'J', shiftKey: true });
    expect(extendDown).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'j' });
    expect(next).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: 'E', shiftKey: true });
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('leaves Ctrl+a to a text field and to every screen but the list', () => {
    const selectToBottom = vi.fn();
    renderHook(() => useShortcuts('list', { selectToBottom }));
    const ta = document.body.appendChild(document.createElement('textarea'));
    const inField = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true });
    ta.dispatchEvent(inField);
    ta.remove();
    expect(inField.defaultPrevented).toBe(false);
    expect(selectToBottom).not.toHaveBeenCalled();
    expect(BINDINGS.filter((b) => b.keys.includes('Ctrl+a')).flatMap((b) => b.contexts)).toEqual(['list']);
  });

  it('distinguishes Ctrl+k from k and Enter from Ctrl+Enter', () => {
    const prev = vi.fn();
    const palette = vi.fn();
    const open = vi.fn();
    renderHook(() => useShortcuts('list', { prev, palette, open }));
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(palette).toHaveBeenCalledTimes(1);
    expect(prev).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Enter', ctrlKey: true });
    expect(open).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('matches shifted symbols and caps-locked letters, and prevents the browser default', () => {
    const togglePanel = vi.fn();
    const important = vi.fn();
    const next = vi.fn();
    renderHook(() => useShortcuts('list', { togglePanel, important, next }));
    fireEvent.keyDown(document.body, { key: '?', shiftKey: true });
    fireEvent.keyDown(document.body, { key: '+', shiftKey: true });
    fireEvent.keyDown(document.body, { key: 'J' });
    expect(togglePanel).toHaveBeenCalledTimes(1);
    expect(important).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    const bracket = new KeyboardEvent('keydown', { key: ']', bubbles: true, cancelable: true });
    const nextGroup = vi.fn();
    renderHook(() => useShortcuts('list', { nextGroup }));
    document.body.dispatchEvent(bracket);
    expect(nextGroup).toHaveBeenCalledTimes(1);
    expect(bracket.defaultPrevented).toBe(true);
  });

  it('leaves Tab to the browser', () => {
    const handlers = Object.fromEntries(BINDINGS.map((b) => [b.id, vi.fn()]));
    renderHook(() => useShortcuts('list', handlers));
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.body.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    for (const fn of Object.values(handlers)) expect(fn).not.toHaveBeenCalled();
  });

  it('leaves Enter to a focused button or link', () => {
    const open = vi.fn();
    renderHook(() => useShortcuts('list', { open }));
    const button = document.createElement('button');
    const link = document.createElement('a');
    link.href = '/settings';
    document.body.append(button, link);
    for (const el of [button, link]) {
      const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      el.dispatchEvent(enter);
      expect(enter.defaultPrevented).toBe(false);
    }
    expect(open).not.toHaveBeenCalled();
    button.remove();
    link.remove();
  });

  it('leaves Alt combinations and unbound Ctrl keys to the browser', () => {
    const done = vi.fn();
    renderHook(() => useShortcuts('list', { done }));
    const copy = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(copy);
    fireEvent.keyDown(document.body, { key: 'e', altKey: true });
    expect(copy.defaultPrevented).toBe(false);
    expect(done).not.toHaveBeenCalled();
  });

  it('uses the latest handlers and stops listening on unmount', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = renderHook(({ fn }) => useShortcuts('list', { done: fn }), {
      initialProps: { fn: first },
    });
    rerender({ fn: second });
    fireEvent.keyDown(document.body, { key: 'e' });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    unmount();
    fireEvent.keyDown(document.body, { key: 'e' });
    expect(second).toHaveBeenCalledTimes(1);
  });
});
