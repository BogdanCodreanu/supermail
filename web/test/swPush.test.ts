// @vitest-environment node
process.env.TZ = 'Europe/Bucharest'; // before any Date: DST ends 2026-10-25 04:00 and starts 2027-03-28 03:00

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../public/sw.js'), 'utf8');
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/this-phone';
const THREAD = 'acc1:18f2';
const URL_OF_THREAD = '/t/acc1%3A18f2';

interface Shown { title: string; options: Record<string, unknown>; close: ReturnType<typeof vi.fn>; tag: string; body: string; data: unknown }
type Handler = (e: object) => void;

/** The real sw.js in a fake ServiceWorkerGlobalScope. */
function loadWorker(over: { windows?: object[]; openWindow?: () => Promise<unknown>; fetched?: (path: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json?: () => Promise<unknown> }>; subscription?: object | null } = {}) {
  const listeners = new Map<string, Handler>();
  const shown: Shown[] = [];
  const registration = {
    showNotification: vi.fn(async (title: string, options: { tag?: string; body?: string; data?: unknown }) => {
      for (const old of shown.filter((n) => n.tag === options.tag)) shown.splice(shown.indexOf(old), 1);
      shown.push({ title, options, close: vi.fn(() => void shown.splice(shown.indexOf(entry), 1)), tag: options.tag ?? '', body: options.body ?? '', data: options.data } as Shown);
      const entry = shown.at(-1)!;
    }),
    getNotifications: vi.fn(async (filter?: { tag?: string }) => shown.filter((n) => !filter?.tag || n.tag === filter.tag)),
    pushManager: {
      getSubscription: vi.fn(async () => (over.subscription === undefined ? { endpoint: ENDPOINT } : over.subscription)),
      subscribe: vi.fn(async (o: object) => ({ options: o, toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/new', keys: { p256dh: 'p', auth: 'a' } }) })),
    },
  };
  const clients = {
    matchAll: vi.fn(async () => over.windows ?? []),
    openWindow: vi.fn(over.openWindow ?? (async () => ({}))),
    claim: vi.fn(async () => {}),
  };
  const net = vi.fn(over.fetched ?? (async () => ({ ok: true, status: 200 })));
  const self = { addEventListener: (t: string, l: Handler) => listeners.set(t, l), location: { origin: 'https://mail.example.com' }, registration, clients, navigator: { userAgent: 'Test UA' }, skipWaiting: async () => {} };
  new Function('self', 'caches', 'fetch', source)(self, {}, net);
  const run = async (type: string, extra: object) => {
    const waits: Promise<unknown>[] = [];
    listeners.get(type)!({ ...extra, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    return waits.length;
  };
  return {
    shown, registration, clients, net, run,
    push: (message: unknown) => run('push', { data: { json: () => message } }),
    click: (n: object, action = '') => run('notificationclick', { notification: n, action }),
  };
}

const mail = { type: 'mail', threadId: THREAD, title: 'Ana Pop', body: 'Lunch?\nFriday', accountLabel: 'me', group: 'Important', sentAt: 1_790_000_000_000 };
const notification = () => ({ title: 'Ana Pop', body: 'Lunch?\nFriday', tag: THREAD, data: { threadId: THREAD, sentAt: mail.sentAt }, close: vi.fn() });
const lastCall = (net: ReturnType<typeof vi.fn>) => net.mock.calls.at(-1) as unknown as [string, RequestInit & { headers: Record<string, string> }];

describe('sw.js: push', () => {
  it('shows a mail with everything the notification needs', async () => {
    const w = loadWorker();
    await w.push(mail);
    expect(w.registration.showNotification).toHaveBeenCalledWith('Ana Pop', {
      body: `To ${mail.accountLabel} · Lunch?\nFriday`,
      tag: THREAD,
      renotify: true,
      icon: '/icon-192.png',
      badge: '/badge-72.png',
      timestamp: mail.sentAt,
      data: { threadId: THREAD, sentAt: mail.sentAt },
      actions: [{ action: 'done', title: 'Done' }, { action: 'snooze', title: 'Snooze' }],
    });
  });

  it('a new reply replaces the old notification', async () => {
    const w = loadWorker();
    await w.push(mail);
    await w.push({ ...mail, body: 'Re: Lunch?' });
    expect(w.shown.map((n) => n.body)).toEqual([`To ${mail.accountLabel} · Re: Lunch?`]);
  });

  it('shows a summary under its own tag, with no actions and nothing to open but the inbox', async () => {
    const w = loadWorker();
    await w.push({ type: 'summary', tag: 'summary:acc1', title: '12 new emails', body: 'me' });
    expect(w.shown[0]).toMatchObject({ title: '12 new emails', tag: 'summary:acc1' });
    expect(w.shown[0]!.options.actions).toBeUndefined();
  });

  it('shows a test', async () => {
    const w = loadWorker();
    await w.push({ type: 'test', title: 'SuperMail', body: 'Notifications work on this device.' });
    expect(w.shown[0]).toMatchObject({ title: 'SuperMail', body: 'Notifications work on this device.' });
  });

  it.each([
    ['unreadable data', { data: { json: () => { throw new SyntaxError('no'); } } }],
    ['no data at all', {}],
  ])('still shows something for %s: a push must never pass silently', async (_, event) => {
    const w = loadWorker();
    await w.run('push', event);
    expect(w.shown).toHaveLength(1);
  });
});

describe('sw.js: clear', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it('closes the matching notification and leaves the others', async () => {
    const w = loadWorker();
    await w.push(mail);
    await w.push({ ...mail, threadId: 'acc1:other', title: 'Other' });
    await w.push({ type: 'clear', threadId: THREAD });
    await vi.advanceTimersByTimeAsync(2000);
    expect(w.shown.map((n) => n.tag)).toEqual(['acc1:other']);
  });

  it('closes every thread of a bulk clear', async () => {
    const w = loadWorker();
    await w.push(mail);
    await w.push({ ...mail, threadId: 'acc1:other' });
    await w.push({ ...mail, threadId: 'acc1:third' });
    await w.push({ type: 'clear', threadIds: [THREAD, 'acc1:other'] });
    await vi.advanceTimersByTimeAsync(2000);
    expect(w.shown.map((n) => n.tag)).toEqual(['acc1:third']);
  });

  it('shows nothing itself', async () => {
    const w = loadWorker();
    await w.push({ type: 'clear', threadId: THREAD });
    await vi.advanceTimersByTimeAsync(2000);
    expect(w.registration.showNotification).not.toHaveBeenCalled();
  });

  it('closes only after the push event has ended: Chrome counts what is showing at that moment', async () => {
    const w = loadWorker();
    await w.push(mail);
    const waits = await w.push({ type: 'clear', threadId: THREAD });
    expect(waits).toBe(0);
    expect(w.shown).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(w.shown).toHaveLength(0);
  });

  it('takes away Chrome\'s own "updated in the background" notice if one got shown', async () => {
    const w = loadWorker();
    w.shown.push({ title: 'Site updated', tag: 'user_visible_auto_notification', options: {}, body: '', data: undefined, close: vi.fn(() => void w.shown.splice(0, 1)) });
    await w.push({ type: 'clear', threadId: THREAD });
    await vi.advanceTimersByTimeAsync(2000);
    expect(w.shown).toEqual([]);
  });
});

describe('sw.js: tapping a notification', () => {
  it('opens the thread when no window is open', async () => {
    const w = loadWorker();
    const n = notification();
    await w.click(n);
    expect(n.close).toHaveBeenCalled();
    expect(w.clients.openWindow).toHaveBeenCalledWith(URL_OF_THREAD);
    expect(w.net).not.toHaveBeenCalled();
  });

  it('uses a window that is already open', async () => {
    const win = { focus: vi.fn(async () => {}), postMessage: vi.fn() };
    const w = loadWorker({ windows: [win] });
    await w.click(notification());
    expect(win.focus).toHaveBeenCalled();
    expect(win.postMessage).toHaveBeenCalledWith({ type: 'open', url: URL_OF_THREAD });
    expect(w.clients.openWindow).not.toHaveBeenCalled();
  });

  it('asks about windows the worker does not control yet too', async () => {
    const w = loadWorker();
    await w.click(notification());
    expect(w.clients.matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
  });

  it('goes to the window the owner is looking at, not just the first one (an app window and a Chrome tab)', async () => {
    const tab = { focused: false, visibilityState: 'hidden', focus: vi.fn(async () => {}), postMessage: vi.fn() };
    const app = { focused: true, visibilityState: 'visible', focus: vi.fn(async () => {}), postMessage: vi.fn() };
    const w = loadWorker({ windows: [tab, app] });
    await w.click(notification());
    expect(app.focus).toHaveBeenCalled();
    expect(tab.focus).not.toHaveBeenCalled();
    expect(app.postMessage).toHaveBeenCalledWith({ type: 'open', url: URL_OF_THREAD });
    // Every open window follows, so whichever one is in front shows the email.
    expect(tab.postMessage).toHaveBeenCalledWith({ type: 'open', url: URL_OF_THREAD });
  });

  it('shows who the mail is for in the notification', async () => {
    const w = loadWorker();
    await w.push({ ...mail, accountLabel: 'ops' });
    expect(w.shown.at(-1)?.body.startsWith('To ops · ')).toBe(true);
  });

  it('opens a new window when the open one refuses focus', async () => {
    const win = { focus: vi.fn(async () => { throw new Error('not allowed'); }), postMessage: vi.fn() };
    const w = loadWorker({ windows: [win] });
    await w.click(notification());
    expect(w.clients.openWindow).toHaveBeenCalledWith(URL_OF_THREAD);
  });

  it('a summary opens the inbox', async () => {
    const w = loadWorker();
    await w.click({ data: {}, close: vi.fn() });
    expect(w.clients.openWindow).toHaveBeenCalledWith('/');
  });
});

describe('sw.js: Done', () => {
  it('posts it the way the app does, and opens nothing', async () => {
    const w = loadWorker();
    const n = notification();
    await w.click(n, 'done');
    expect(n.close).toHaveBeenCalled();
    const [path, init] = lastCall(w.net);
    expect(path).toBe('/api/threads/acc1%3A18f2/done');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(init.headers['x-supermail']).toBe('1');
    expect(w.clients.openWindow).not.toHaveBeenCalled();
    expect(w.registration.showNotification).not.toHaveBeenCalled();
  });

  it('names this device, so the server sends it no clear for a notification it already closed', async () => {
    const w = loadWorker();
    await w.click(notification(), 'done');
    expect(lastCall(w.net)[1].headers['x-supermail-push']).toBe(ENDPOINT);
  });

  it('works with no subscription to name', async () => {
    const w = loadWorker({ subscription: null });
    await w.click(notification(), 'done');
    expect(lastCall(w.net)[1].headers['x-supermail-push']).toBeUndefined();
  });

  it.each([
    ['offline', async () => { throw new TypeError('Failed to fetch'); }],
    ['an expired session', async () => ({ ok: false, status: 401 })],
    ['a server error', async () => ({ ok: false, status: 502 })],
  ])('on %s it opens the thread and shows that it did not happen', async (_, fetched) => {
    const w = loadWorker({ fetched });
    await w.click(notification(), 'done');
    expect(w.clients.openWindow).toHaveBeenCalledWith(URL_OF_THREAD);
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0]!.title).toMatch(/couldn.t mark .*done/i);
    expect(w.shown[0]).toMatchObject({ tag: THREAD });
    expect(w.shown[0]!.body).toContain('Ana Pop');
    expect(w.shown[0]!.options.actions).toHaveLength(2); // so it can be tried again
  });

  it('keeps the notice when even the window cannot be opened', async () => {
    const w = loadWorker({ fetched: async () => { throw new TypeError('Failed to fetch'); }, openWindow: async () => { throw new Error('no gesture left'); } });
    await w.click(notification(), 'done');
    expect(w.shown).toHaveLength(1);
  });

  it('a second failure does not pile up in the text', async () => {
    const w = loadWorker({ fetched: async () => ({ ok: false, status: 502 }) });
    await w.click(notification(), 'done');
    const again = w.shown[0]!;
    await w.click({ ...again, close: vi.fn() }, 'done');
    expect(w.shown[0]!.body).toBe(again.body);
  });
});

describe('sw.js: Snooze', () => {
  beforeEach(() => void vi.useFakeTimers({ toFake: ['Date'] }));
  afterEach(() => void vi.useRealTimers());

  const untilAt = async (now: string) => {
    vi.setSystemTime(new Date(now));
    const w = loadWorker();
    await w.click(notification(), 'snooze');
    const [path, init] = lastCall(w.net);
    expect(path).toBe('/api/threads/acc1%3A18f2/snooze');
    expect(init.headers['content-type']).toBe('application/json');
    return (JSON.parse(init.body as string) as { until: number }).until;
  };

  it('runs in the timezone it was written for', () => {
    expect(new Date('2026-07-01T00:00:00Z').getTimezoneOffset()).toBe(-180);
    expect(new Date('2026-12-01T00:00:00Z').getTimezoneOffset()).toBe(-120);
  });

  it('asks for tomorrow at 08:00 local time', async () => {
    expect(await untilAt('2026-07-15T09:30:00+03:00')).toBe(Date.parse('2026-07-16T08:00:00+03:00'));
  });

  it('counts tomorrow from the local date, late in the evening and just after midnight', async () => {
    expect(await untilAt('2026-07-15T23:59:00+03:00')).toBe(Date.parse('2026-07-16T08:00:00+03:00'));
    expect(await untilAt('2026-07-15T00:30:00+03:00')).toBe(Date.parse('2026-07-16T08:00:00+03:00'));
  });

  it('stays at 08:00 when the clocks go back tonight (a 25 hour day)', async () => {
    const until = await untilAt('2026-10-24T09:00:00+03:00');
    expect(until).toBe(Date.parse('2026-10-25T08:00:00+02:00'));
    expect((until - Date.parse('2026-10-24T09:00:00+03:00')) / 3_600_000).toBe(24);
  });

  it('stays at 08:00 when the clocks go forward tonight (a 23 hour day)', async () => {
    const until = await untilAt('2027-03-27T09:00:00+02:00');
    expect(until).toBe(Date.parse('2027-03-28T08:00:00+03:00'));
    expect((until - Date.parse('2027-03-27T09:00:00+02:00')) / 3_600_000).toBe(22);
  });

  it('rolls over the end of a month and a year', async () => {
    expect(await untilAt('2026-12-31T12:00:00+02:00')).toBe(Date.parse('2027-01-01T08:00:00+02:00'));
  });

  it('shows that a failed snooze did not happen', async () => {
    const w = loadWorker({ fetched: async () => ({ ok: false, status: 401 }) });
    await w.click(notification(), 'snooze');
    expect(w.shown[0]!.title).toMatch(/couldn.t snooze/i);
    expect(w.clients.openWindow).toHaveBeenCalledWith(URL_OF_THREAD);
  });
});

describe('sw.js: pushsubscriptionchange', () => {
  it('stores the new subscription and forgets the old', async () => {
    const w = loadWorker();
    const newSubscription = { toJSON: () => ({ endpoint: 'https://push.example/new', keys: { p256dh: 'p', auth: 'a' } }) };
    await w.run('pushsubscriptionchange', { oldSubscription: { endpoint: 'https://push.example/old' }, newSubscription });
    const [[first, firstInit], [second, secondInit]] = w.net.mock.calls as unknown as [[string, RequestInit], [string, RequestInit]];
    expect(first).toBe('/api/push/subscribe');
    expect(firstInit).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(JSON.parse(firstInit.body as string)).toEqual({ endpoint: 'https://push.example/new', keys: { p256dh: 'p', auth: 'a' }, userAgent: 'Test UA' });
    expect(second).toBe('/api/push/subscribe');
    expect(secondInit.method).toBe('DELETE');
    expect(JSON.parse(secondInit.body as string)).toEqual({ endpoint: 'https://push.example/old' });
  });

  it('subscribes again with the old options when the browser gives no new one', async () => {
    const w = loadWorker();
    await w.run('pushsubscriptionchange', { oldSubscription: { endpoint: 'https://push.example/old', options: { applicationServerKey: 'KEY' } } });
    expect(w.registration.pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: 'KEY' });
    expect(lastCall(w.net)[1].method).toBe('DELETE');
  });

  it('asks the server for the key when the browser gives neither', async () => {
    const w = loadWorker({ fetched: async () => ({ ok: true, status: 200, json: async () => ({ publicKey: 'SERVER-KEY' }) }) });
    await w.run('pushsubscriptionchange', {});
    expect(w.registration.pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: 'SERVER-KEY' });
    expect(w.net.mock.calls[0]![0]).toBe('/api/push/key');
  });
});
