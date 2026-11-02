import type { PushDeviceDTO, PushKeyDTO } from '@supermail/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSession, requireSession, SESSION_COOKIE } from '../src/auth/sessions.js';
import type { AppConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db/index.js';
import { ALLOW_ALL, type AppDeps, buildApp, NOOP_HOOK, type RoutePlugin } from '../src/http/app.js';
import { pushRoutes } from '../src/http/routes/push.js';
import { threadsRoutes } from '../src/http/routes/threads.js';
import { createPushService, type PushSender, type PushService } from '../src/push/service.js';
import { createFakeGmail } from './fakes/fakeGmail.js';

const NOW = Date.UTC(2026, 9, 31, 10, 0, 0);
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc';
const OTHER = 'https://fcm.googleapis.com/fcm/send/def';
const body = (endpoint = ENDPOINT, over: object = {}) => ({ endpoint, keys: { p256dh: 'BPub', auth: 'sec' }, userAgent: 'Mozilla/5.0 (Linux; Android 10; K) Chrome/140', ...over });
const write = { 'x-supermail': '1' };

let app: FastifyInstance | undefined;
let push: PushService | undefined;
let db: DB | undefined;
afterEach(async () => {
  push?.stop();
  await app?.close();
  db?.close();
  app = push = db = undefined;
});

async function build(sender: PushSender = vi.fn(async () => {})) {
  db = openDb(':memory:');
  const config = { ownerEmail: 'me@gmail.com', publicUrl: 'https://mail.example.com', secureCookies: false } as AppConfig;
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  push = createPushService({ db, publicKey: 'the-public-key', sender, now: () => NOW, log });
  const gmail = createFakeGmail('me@gmail.com', { now: () => NOW });
  const deps: AppDeps = { db, config, gmailFor: () => gmail, now: () => NOW, onThreadChange: NOOP_HOOK, storage: ALLOW_ALL, push };
  const guard: RoutePlugin = async (a, d) => {
    a.addHook('preHandler', requireSession(d.db, d.config, d.now));
  };
  app = await buildApp(deps, [guard, pushRoutes, threadsRoutes], { webDir: '/nonexistent' });
  const cookie = `${SESSION_COOKIE}=${createSession(db, 'me@gmail.com', NOW)}`;
  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) => app!.inject({ method, url, headers: { cookie, ...(method === 'GET' ? {} : write) }, ...(payload ? { payload } : {}) });
  return { db, app, call, cookie };
}

describe('push routes: guards', () => {
  const ROUTES: ['GET' | 'POST' | 'DELETE', string][] = [
    ['GET', '/api/push/key'],
    ['POST', '/api/push/subscribe'],
    ['DELETE', '/api/push/subscribe'],
    ['GET', '/api/push/devices'],
    ['DELETE', '/api/push/devices/x'],
    ['POST', '/api/push/test'],
  ];

  it.each(ROUTES)('%s %s needs a session', async (method, url) => {
    const { app } = await build();
    const res = await app.inject({ method, url, headers: write, ...(method === 'GET' ? {} : { payload: body() }) });
    expect(res.statusCode).toBe(401);
  });

  it.each(ROUTES.filter(([m]) => m !== 'GET'))('%s %s needs the x-supermail header', async (method, url) => {
    const { app, cookie } = await build();
    const res = await app.inject({ method, url, headers: { cookie }, payload: body() });
    expect(res.statusCode).toBe(403);
  });
});

describe('push routes', () => {
  it('gives out the public key', async () => {
    const { call } = await build();
    expect((await call('GET', '/api/push/key')).json<PushKeyDTO>()).toEqual({ publicKey: 'the-public-key', keysReset: false });
  });

  it('stores a subscription, and a second POST of the same endpoint updates it', async () => {
    const { call, db } = await build();
    expect((await call('POST', '/api/push/subscribe', body())).json()).toEqual({ ok: true });
    await call('POST', '/api/push/subscribe', body(ENDPOINT, { keys: { p256dh: 'BNew', auth: 'sec2' } }));
    expect(db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions').all()).toEqual([{ endpoint: ENDPOINT, p256dh: 'BNew', auth: 'sec2' }]);
    const devices = (await call('GET', '/api/push/devices')).json<PushDeviceDTO[]>();
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ endpoint: ENDPOINT, userAgent: expect.stringContaining('Android'), createdAt: NOW, lastOkAt: null });
  });

  it.each([
    ['no endpoint', { keys: { p256dh: 'a', auth: 'b' } }],
    ['a plain http endpoint', { endpoint: 'http://push.example.com/1', keys: { p256dh: 'a', auth: 'b' } }],
    ['something that is no URL', { endpoint: 'nonsense', keys: { p256dh: 'a', auth: 'b' } }],
    ['no keys', { endpoint: ENDPOINT }],
    ['an empty key', { endpoint: ENDPOINT, keys: { p256dh: '', auth: 'b' } }],
    ['a key of the wrong type', { endpoint: ENDPOINT, keys: { p256dh: 1, auth: 'b' } }],
    ['an absurdly long endpoint', { endpoint: `https://x.example/${'a'.repeat(3000)}`, keys: { p256dh: 'a', auth: 'b' } }],
  ])('refuses %s', async (_, payload) => {
    const { call, db } = await build();
    expect((await call('POST', '/api/push/subscribe', payload)).statusCode).toBe(400);
    expect(db.prepare('SELECT count(*) FROM push_subscriptions').pluck().get()).toBe(0);
  });

  it('forgets an endpoint on DELETE, and asking twice is fine', async () => {
    const { call, db } = await build();
    await call('POST', '/api/push/subscribe', body());
    expect((await call('DELETE', '/api/push/subscribe', { endpoint: ENDPOINT })).json()).toEqual({ ok: true });
    expect((await call('DELETE', '/api/push/subscribe', { endpoint: ENDPOINT })).statusCode).toBe(200);
    expect(db.prepare('SELECT count(*) FROM push_subscriptions').pluck().get()).toBe(0);
  });

  it('a removed device leaves the list, gets no pushes, and its own check-in is told so', async () => {
    const send = vi.fn(async () => {});
    const { call } = await build(send);
    await call('POST', '/api/push/subscribe', body());
    const [device] = (await call('GET', '/api/push/devices')).json<PushDeviceDTO[]>();
    expect((await call('DELETE', `/api/push/devices/${device!.id}`)).json()).toEqual({ ok: true });
    expect((await call('GET', '/api/push/devices')).json()).toEqual([]);
    expect((await call('POST', '/api/push/test', { endpoint: ENDPOINT })).statusCode).toBe(404);
    expect((await call('POST', '/api/push/subscribe', body(ENDPOINT, { refresh: true }))).json()).toEqual({ ok: true, removed: true });
    expect((await call('GET', '/api/push/devices')).json()).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('the owner turning it on again on that device brings it back', async () => {
    const { call } = await build();
    await call('POST', '/api/push/subscribe', body());
    const [device] = (await call('GET', '/api/push/devices')).json<PushDeviceDTO[]>();
    await call('DELETE', `/api/push/devices/${device!.id}`);
    expect((await call('POST', '/api/push/subscribe', body())).json()).toEqual({ ok: true });
    expect((await call('GET', '/api/push/devices')).json()).toHaveLength(1);
  });

  it('a check-in from a device the server lost signs it back up', async () => {
    const { call } = await build();
    expect((await call('POST', '/api/push/subscribe', body(ENDPOINT, { refresh: true }))).json()).toEqual({ ok: true });
    expect((await call('GET', '/api/push/devices')).json()).toHaveLength(1);
  });

  it('removing an unknown device is a 404', async () => {
    const { call } = await build();
    expect((await call('DELETE', '/api/push/devices/nope')).statusCode).toBe(404);
  });

  it('the test goes to the one endpoint asked for', async () => {
    const send = vi.fn(async () => {});
    const { call } = await build(send);
    await call('POST', '/api/push/subscribe', body());
    await call('POST', '/api/push/subscribe', body(OTHER));
    expect((await call('POST', '/api/push/test', { endpoint: OTHER })).json()).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(1);
    const [sub, payload] = send.mock.calls[0] as unknown as [{ endpoint: string }, string];
    expect(sub.endpoint).toBe(OTHER);
    expect(JSON.parse(payload)).toMatchObject({ type: 'test' });
  });

  it('says so when the test could not be delivered', async () => {
    const { call } = await build(async () => {
      throw Object.assign(new Error('nope'), { statusCode: 500 });
    });
    await call('POST', '/api/push/subscribe', body());
    expect((await call('POST', '/api/push/test', { endpoint: ENDPOINT })).json()).toEqual({ ok: false });
  });

  it('a test that finds the subscription dead removes it', async () => {
    const { call, db } = await build(async () => {
      throw Object.assign(new Error('gone'), { statusCode: 410 });
    });
    await call('POST', '/api/push/subscribe', body());
    expect((await call('POST', '/api/push/test', { endpoint: ENDPOINT })).json()).toEqual({ ok: false });
    expect(db.prepare('SELECT count(*) FROM push_subscriptions').pluck().get()).toBe(0);
  });

  it('turning on after the keys were replaced clears the warning', async () => {
    const { call, db } = await build();
    db.prepare("INSERT INTO kv(key, value) VALUES ('push_keys_reset', '1')").run();
    expect((await call('GET', '/api/push/key')).json<PushKeyDTO>().keysReset).toBe(true);
    await call('POST', '/api/push/subscribe', body(ENDPOINT, { refresh: true }));
    expect((await call('GET', '/api/push/key')).json<PushKeyDTO>().keysReset).toBe(true); // a check-in is not the owner turning it on
    await call('POST', '/api/push/subscribe', body());
    expect((await call('GET', '/api/push/key')).json<PushKeyDTO>().keysReset).toBe(false);
  });

  it('Done from a notification names its device, so that device gets no clear', async () => {
    const { cookie, db } = await build();
    db.prepare("INSERT INTO accounts(id, email, color, status, created_at) VALUES ('a', 'me@gmail.com', '#2563eb', 'ok', 1)").run();
    db.prepare("INSERT INTO threads(id, account_id, gmail_thread_id, last_message_at, in_inbox, unread) VALUES ('a:1', 'a', '1', 1, 1, 1)").run();
    const handled = vi.spyOn(push!, 'handledOn');
    const url = `/api/threads/${encodeURIComponent('a:1')}/done`;
    await app!.inject({ method: 'POST', url, headers: { cookie, ...write, 'x-supermail-push': ENDPOINT } });
    expect(handled).toHaveBeenCalledWith('a:1', ENDPOINT);
  });
});
