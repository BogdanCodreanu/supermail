import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_HEADER, type ActionResult, type BulkResult, type ServerEvent, type ThreadPage } from '@supermail/shared';
import { reconcileIndex } from '../src/actions/bulk.js';
import { undo, UNDO_TTL_MS } from '../src/actions/undo.js';
import { createSession, requireSession, SESSION_COOKIE } from '../src/auth/sessions.js';
import type { AppConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db/index.js';
import { bus } from '../src/events.js';
import { ALLOW_ALL, type AppDeps, buildApp, type RoutePlugin } from '../src/http/app.js';
import { threadsRoutes } from '../src/http/routes/threads.js';
import { SNOOZED_LABEL } from '../src/labels/labelWriter.js';
import { createPoller } from '../src/sync/poller.js';
import { labelWritesIdle, makeThreadHook } from '../src/threads/classifyThread.js';
import { toSummary } from '../src/threads/queries.js';
import { createFakeGmail, type FakeGmail } from './fakes/fakeGmail.js';
import { DAY, HOUR } from './fixtures/threads.js';

const NOW = Date.UTC(2026, 9, 29, 10, 0, 0);
const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
const OWNER = 'me@gmail.com';
const tid = (n: number | string) => `a:t-${n}`;
const apps: FastifyInstance[] = [];
const unsubscribe: (() => void)[] = [];

afterEach(async () => {
  for (const off of unsubscribe.splice(0)) off();
  for (const app of apps.splice(0)) await app.close();
});

async function setup(count = 8, before?: (a: FakeGmail) => void) {
  const db: DB = openDb(':memory:');
  db.prepare("INSERT INTO accounts(id, email, color, status, created_at) VALUES ('a', 'me@gmail.com', '#2563eb', 'syncing', 1)").run();
  const clock = { now: NOW };
  const a = createFakeGmail(OWNER, { now: () => clock.now });
  for (let i = 0; i < count; i++) {
    a.addThread({ id: `t-${i}`, messages: [{ from: `Sender ${i % 3} <s${i % 3}@acme.example>`, subject: `Mail ${i}`, date: NOW - (i + 1) * HOUR, labelIds: ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL'] }] });
  }
  before?.(a);
  const gmailFor = () => a;
  const hook = makeThreadHook({ db, gmailFor, now: () => clock.now, log });
  const poller = createPoller({ db, gmailFor, intervalMs: 30_000, onChange: hook, log });
  await poller.tick();
  await hook.idle();
  const deps: AppDeps = { db, config: { ownerEmail: OWNER } as AppConfig, gmailFor, now: () => clock.now, onThreadChange: hook, storage: ALLOW_ALL };
  const app = await buildApp(deps, [threadsRoutes], { webDir: '/nonexistent' });
  apps.push(app);
  return { db, a, clock, deps, app, hook, poller };
}

const post = (app: FastifyInstance, url: string, body?: unknown) =>
  app.inject({ method: 'POST', url, headers: { [API_HEADER]: '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
const bulk = (app: FastifyInstance, body: unknown) => post(app, '/api/threads/bulk', body);

function events() {
  const seen: ServerEvent[] = [];
  unsubscribe.push(bus.subscribe((e) => seen.push(e)));
  return seen;
}
const settled = (seen: ServerEvent[]) => seen.filter((e): e is Extract<ServerEvent, { type: 'bulk.settled' }> => e.type === 'bulk.settled');

/** Holds every modifyThread until released, so a test can look at the world while the writes are in flight. */
function holdWrites(a: FakeGmail) {
  const real = a.modifyThread.bind(a);
  const held: { id: string; release(): Promise<void>; fail(): Promise<void> }[] = [];
  a.modifyThread = (id, add, remove) =>
    new Promise<void>((resolve, reject) => {
      const turn = () => new Promise((r) => setImmediate(r));
      held.push({
        id,
        release: async () => {
          await real(id, add, remove).then(resolve, reject);
          await turn();
        },
        fail: async () => {
          reject(new Error('Gmail said no'));
          await turn();
        },
      });
    });
  return held;
}

/** Lets everything held go through, the writes that follow from them too, until the server is idle. */
async function drain(held: ReturnType<typeof holdWrites>, hook: { idle(): Promise<void> }) {
  let idle = false;
  void hook.idle().then(() => (idle = true));
  while (!idle) {
    for (const h of held.splice(0)) await h.release();
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** Gmail refuses these threads; every other write goes through. */
function failWrites(a: FakeGmail, ids: string[]) {
  const real = a.modifyThread.bind(a);
  a.modifyThread = (id, add, remove) => (ids.includes(id) ? Promise.reject(new Error('Gmail said no')) : real(id, add, remove));
}

const thread = (db: DB, n: number) => db.prepare('SELECT in_inbox, unread, done_at, group_id FROM threads WHERE id = ?').get(tid(n)) as { in_inbox: number; unread: number; done_at: number | null; group_id: string } | undefined;
const inboxIds = async (app: FastifyInstance) => ((await app.inject('/api/threads?limit=200')).json() as ThreadPage).threads.map((t) => t.id);

describe('POST /api/threads/bulk', () => {
  it('done takes every thread out of the inbox in the index and in Gmail', async () => {
    const { a, app, db, hook } = await setup();
    const res = await bulk(app, { ids: [tid(0), tid(1), tid(2)], action: 'done' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ affected: 3, failed: [] });
    expect((res.json() as BulkResult).undoId).toEqual(expect.any(String));
    expect(await inboxIds(app)).not.toEqual(expect.arrayContaining([tid(0)]));
    expect(thread(db, 1)).toMatchObject({ in_inbox: 0, done_at: NOW });
    await hook.idle();
    for (const n of [0, 1, 2]) expect(a.threadLabels(`t-${n}`)).not.toContain('INBOX');
    expect(a.threadLabels('t-3')).toContain('INBOX');
  });

  it('answers and publishes the threads before Gmail writes finish', async () => {
    const { a, app, db, hook } = await setup();
    const held = holdWrites(a);
    const seen = events();
    const res = await bulk(app, { ids: [tid(0), tid(1), tid(2)], action: 'done' });
    expect(res.statusCode).toBe(200);
    expect(a.threadLabels('t-0')).toContain('INBOX'); // Gmail has not been written yet
    expect(thread(db, 0)).toMatchObject({ in_inbox: 0, done_at: NOW });
    const updated = seen.filter((e) => e.type === 'thread.updated').map((e) => (e as { thread: { id: string } }).thread.id);
    expect(updated).toEqual(expect.arrayContaining([tid(0), tid(1), tid(2)]));
    expect(settled(seen)).toEqual([]);
    for (let i = 0; i < 3; i++) await held[i]!.release();
    await hook.idle();
    expect(settled(seen)).toEqual([{ type: 'bulk.settled', undoId: (res.json() as BulkResult).undoId, affected: 3, failed: [], skipped: [] }]);
  });

  it('snooze parks every thread until the same time, with the label on in Gmail', async () => {
    const { a, app, db, hook } = await setup();
    const until = NOW + DAY;
    const res = await bulk(app, { ids: [tid(0), tid(1)], action: 'snooze', until });
    expect(res.json()).toMatchObject({ affected: 2, failed: [] });
    expect(db.prepare('SELECT until FROM snoozes WHERE thread_id = ?').pluck().get(tid(1))).toBe(until);
    expect(toSummary(db, tid(0))).toMatchObject({ inInbox: false, snoozedUntil: until });
    await hook.idle();
    const label = a.labelId(SNOOZED_LABEL)!;
    expect(a.threadLabels('t-0')).toEqual(expect.arrayContaining([label]));
    expect(a.threadLabels('t-0')).not.toContain('INBOX');
  });

  it('read and unread change the index at once and Gmail after', async () => {
    const { a, app, db, hook } = await setup();
    await bulk(app, { ids: [tid(0), tid(1)], action: 'read' });
    expect(thread(db, 0)?.unread).toBe(0);
    await hook.idle();
    expect(a.threadLabels('t-0')).not.toContain('UNREAD');
    await bulk(app, { ids: [tid(0)], action: 'unread' });
    expect(thread(db, 0)?.unread).toBe(1);
    await hook.idle();
    expect(a.threadLabels('t-0')).toContain('UNREAD');
  });

  it('move regroups the selected threads as one-off moves, no rule, and relabels them in Gmail', async () => {
    const { a, app, db, hook } = await setup();
    const res = await bulk(app, { ids: [tid(0), tid(1)], action: 'move', groupId: 'dev' });
    expect(res.json()).toMatchObject({ affected: 2, failed: [] });
    expect(toSummary(db, tid(0))).toMatchObject({ groupId: 'dev', reason: { source: 'override' } });
    await hook.idle();
    const label = a.labelId('SuperMail/Dev')!;
    expect(a.threadLabels('t-1')).toContain(label);
    expect(a.threadLabels('t-3')).not.toContain(label); // same sender as t-0, not selected
    expect(db.prepare('SELECT count(*) FROM rules').pluck().get()).toBe(0);
  });

  it('move relabels an archived thread the owner picked, since it was selected on purpose', async () => {
    const { a, app, hook } = await setup(4, (g) => g.addThread({ id: 't-old', messages: [{ from: 'Old <old@acme.example>', subject: 'Archived', date: NOW - 9 * DAY, labelIds: ['CATEGORY_PERSONAL'] }] }));
    await bulk(app, { ids: ['a:t-old'], action: 'move', groupId: 'dev' });
    await hook.idle();
    expect(a.threadLabels('t-old')).toContain(a.labelId('SuperMail/Dev')!);
  });

  it('spam leaves the screen at once, then the index once Gmail has it', async () => {
    const { a, app, db, hook } = await setup();
    const held = holdWrites(a);
    const seen = events();
    await bulk(app, { ids: [tid(0), tid(1)], action: 'spam' });
    expect(seen).toContainEqual({ type: 'thread.removed', id: tid(0) });
    expect(await inboxIds(app)).not.toContain(tid(0));
    expect(thread(db, 0)).toBeDefined(); // kept until Gmail agrees, so a failure can put it back
    for (const h of held.splice(0)) await h.release();
    await hook.idle();
    expect(thread(db, 0)).toBeUndefined();
    expect(a.threadLabels('t-0')).toContain('SPAM');
    expect(a.threadLabels('t-0')).not.toContain('INBOX');
  });

  it('keeps to the label writer concurrency, however big the selection', async () => {
    const { a, app, hook } = await setup(30);
    const held = holdWrites(a);
    await bulk(app, { ids: Array.from({ length: 30 }, (_, i) => tid(i)), action: 'done' });
    await new Promise((r) => setTimeout(r, 10));
    expect(held).toHaveLength(5);
    while (held.length > 0) await held.shift()!.release();
    await hook.idle();
    expect(a.threadLabels('t-29')).not.toContain('INBOX');
  });

  it('labelWritesIdle waits for a bulk action still writing, for a clean shutdown', async () => {
    const { a, app, db } = await setup();
    const held = holdWrites(a);
    await bulk(app, { ids: [tid(0)], action: 'done' });
    let idle = false;
    void labelWritesIdle(db).then(() => (idle = true));
    await new Promise((r) => setImmediate(r));
    expect(idle).toBe(false);
    await held[0]!.release();
    await labelWritesIdle(db);
    expect(idle).toBe(true);
  });

  it('reports threads the index does not have, and acts on the rest', async () => {
    const { app } = await setup();
    const res = await bulk(app, { ids: [tid(0), 'a:nope', tid(0)], action: 'done' });
    expect(res.json()).toMatchObject({ affected: 1, failed: ['a:nope'] });
  });

  it.each([
    ['more than the limit of ids', { ids: Array.from({ length: 1001 }, (_, i) => tid(i)), action: 'done' }],
    ['no ids', { ids: [], action: 'done' }],
    ['ids that are not strings', { ids: [1], action: 'done' }],
    ['an unknown action', { ids: ['a:t-0'], action: 'explode' }],
    ['a snooze with no time', { ids: ['a:t-0'], action: 'snooze' }],
    ['a snooze in the past', { ids: ['a:t-0'], action: 'snooze', until: NOW - 1 }],
    ['a move to an unknown group', { ids: ['a:t-0'], action: 'move', groupId: 'nope' }],
  ])('refuses %s with 400, changing nothing', async (_name, body) => {
    const { app, db } = await setup();
    expect((await bulk(app, body)).statusCode).toBe(400);
    expect(thread(db, 0)).toMatchObject({ in_inbox: 1, done_at: null });
  });

  it('accepts exactly 1000 ids', async () => {
    const { app, hook } = await setup(2);
    const res = await bulk(app, { ids: [tid(0), ...Array.from({ length: 999 }, (_, i) => `a:none-${i}`)], action: 'read' });
    expect(res.statusCode).toBe(200);
    await hook.idle();
  });

  it('needs the CSRF header and a session', async () => {
    const { deps } = await setup();
    const guard: RoutePlugin = async (a, d) => {
      a.addHook('preHandler', requireSession(d.db, d.config, d.now));
    };
    const app = await buildApp(deps, [guard, threadsRoutes], { webDir: '/nonexistent' });
    apps.push(app);
    const payload = { ids: [tid(0)], action: 'done' };
    expect((await app.inject({ method: 'POST', url: '/api/threads/bulk', payload })).statusCode).toBe(403);
    expect((await bulk(app, payload)).statusCode).toBe(401);
    const cookie = `${SESSION_COOKIE}=${createSession(deps.db, OWNER, NOW)}`;
    const res = await app.inject({ method: 'POST', url: '/api/threads/bulk', headers: { [API_HEADER]: '1', cookie, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
    expect(res.statusCode).toBe(200);
  });
});

describe('a failure in Gmail', () => {
  it('restores those threads on screen and in the index, and reports them', async () => {
    const { a, app, db, hook } = await setup();
    failWrites(a, ['t-1', 't-2']);
    const seen = events();
    const res = await bulk(app, { ids: [tid(0), tid(1), tid(2), tid(3)], action: 'done' });
    expect(res.json()).toMatchObject({ affected: 4, failed: [] });
    await hook.idle();
    expect(settled(seen)).toEqual([{ type: 'bulk.settled', undoId: (res.json() as BulkResult).undoId, affected: 2, failed: [tid(1), tid(2)], skipped: [] }]);
    expect(thread(db, 1)).toMatchObject({ in_inbox: 1, done_at: null });
    expect(thread(db, 0)).toMatchObject({ in_inbox: 0 });
    expect(a.threadLabels('t-1')).toContain('INBOX');
    const last = seen.filter((e) => e.type === 'thread.updated' && e.thread.id === tid(1)).at(-1) as { thread: { inInbox: boolean } };
    expect(last.thread.inInbox).toBe(true);
  });

  it.each([
    ['snooze', { action: 'snooze', until: NOW + DAY }, (db: DB) => expect(toSummary(db, tid(1))).toMatchObject({ inInbox: true, snoozedUntil: null })],
    ['read', { action: 'read' }, (db: DB) => expect(toSummary(db, tid(1)).unread).toBe(true)],
    ['move', { action: 'move', groupId: 'dev' }, (db: DB) => expect(toSummary(db, tid(1)).groupId).not.toBe('dev')],
    ['spam', { action: 'spam' }, (db: DB) => expect(toSummary(db, tid(1)).inInbox).toBe(true)],
  ])('never leaves a failed %s claimed in the index', async (_name, body, check) => {
    const { a, app, db, hook } = await setup();
    failWrites(a, ['t-1']);
    const seen = events();
    await bulk(app, { ids: [tid(0), tid(1)], ...body });
    await hook.idle();
    expect(settled(seen)[0]?.failed).toEqual([tid(1)]);
    check(db);
  });

  it('a revoked account restores every thread and asks for a reconnect', async () => {
    const { a, app, db, hook } = await setup();
    a.revoke();
    const seen = events();
    await bulk(app, { ids: [tid(0), tid(1)], action: 'done' });
    await hook.idle();
    expect(settled(seen)[0]).toMatchObject({ affected: 0, failed: [tid(0), tid(1)] });
    expect(thread(db, 0)).toMatchObject({ in_inbox: 1 });
    expect(db.prepare("SELECT status FROM accounts WHERE id = 'a'").pluck().get()).toBe('reconnect_needed');
  });

  it('a thread Gmail deleted is reported and stays gone', async () => {
    const { a, app, db, hook } = await setup();
    a.deleteThread('t-1');
    const seen = events();
    await bulk(app, { ids: [tid(1)], action: 'done' });
    await hook.idle();
    expect(settled(seen)[0]?.failed).toEqual([tid(1)]);
    expect(thread(db, 1)).toBeUndefined();
  });

  it('undo after a partial failure touches only the threads that landed', async () => {
    const { a, app, db, hook } = await setup();
    failWrites(a, ['t-1']);
    const res = (await bulk(app, { ids: [tid(0), tid(1)], action: 'done' })).json() as BulkResult;
    await hook.idle();
    expect((await post(app, `/api/undo/${res.undoId}`)).json()).toMatchObject({ thread: null, affected: 1 });
    await hook.idle();
    expect(thread(db, 0)).toMatchObject({ in_inbox: 1, done_at: null });
    expect(thread(db, 1)).toMatchObject({ in_inbox: 1, done_at: null });
    expect(a.threadLabels('t-0')).toContain('INBOX');
  });

  it('reconcileIndex leaves threads Gmail agrees with alone', async () => {
    const { app, db, hook } = await setup();
    await bulk(app, { ids: [tid(0)], action: 'done' });
    await hook.idle();
    expect(reconcileIndex(db)).toBe(0);
    expect(thread(db, 0)).toMatchObject({ in_inbox: 0, done_at: NOW });
  });
});

describe('undo of a bulk action', () => {
  it('one undo restores every thread, in the index at once and in Gmail after', async () => {
    const { a, app, db, hook } = await setup();
    const { undoId } = (await bulk(app, { ids: [tid(0), tid(1), tid(2)], action: 'done' })).json() as BulkResult;
    await hook.idle();
    expect(db.prepare('SELECT kind FROM undo WHERE id = ?').pluck().get(undoId)).toBe('bulk');
    const held = holdWrites(a);
    const res = await post(app, `/api/undo/${undoId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ thread: null, affected: 3 });
    expect(thread(db, 0)).toMatchObject({ in_inbox: 1, done_at: null }); // before Gmail
    for (const h of held.splice(0)) await h.release();
    await hook.idle();
    for (const n of [0, 1, 2]) expect(a.threadLabels(`t-${n}`)).toContain('INBOX');
    expect((await post(app, `/api/undo/${undoId}`)).statusCode).toBe(404);
  });

  it.each([
    ['snooze', { action: 'snooze', until: NOW + DAY }],
    ['read', { action: 'read' }],
    ['move', { action: 'move', groupId: 'dev' }],
    ['spam', { action: 'spam' }],
  ])('restores after a %s', async (_name, body) => {
    const { a, app, db, hook } = await setup();
    const before = toSummary(db, tid(0));
    const labels = a.threadLabels('t-0').filter((l) => l !== 'IMPORTANT');
    const { undoId } = (await bulk(app, { ids: [tid(0), tid(1)], ...body })).json() as BulkResult;
    await hook.idle();
    await post(app, `/api/undo/${undoId}`);
    await hook.idle();
    expect(toSummary(db, tid(0))).toMatchObject({ inInbox: true, unread: true, groupId: before.groupId, snoozedUntil: null });
    expect(a.threadLabels('t-0')).toEqual(expect.arrayContaining(labels));
    expect(a.threadLabels('t-0')).not.toContain('SPAM');
  });

  it('an undo while writes are queued cancels them: Gmail is never told', async () => {
    const { a, app, db, hook } = await setup(20);
    const held = holdWrites(a);
    const { undoId } = (await bulk(app, { ids: Array.from({ length: 20 }, (_, i) => tid(i)), action: 'done' })).json() as BulkResult;
    await new Promise((r) => setTimeout(r, 5));
    expect(held).toHaveLength(5); // the first five are on their way to Gmail, the rest wait
    await post(app, `/api/undo/${undoId}`);
    for (let n = 0; n < 20; n++) expect(thread(db, n)).toMatchObject({ in_inbox: 1, done_at: null });
    await drain(held, hook);
    for (let n = 0; n < 20; n++) expect(a.threadLabels(`t-${n}`)).toContain('INBOX');
    expect(thread(db, 0)).toMatchObject({ in_inbox: 1, done_at: null });
    expect(thread(db, 19)).toMatchObject({ in_inbox: 1, done_at: null });
    const touchedInbox = a.calls.modifyThread.filter(([id, add, remove]) => ['t-10', 't-19'].includes(id) && [...add, ...remove].includes('INBOX'));
    expect(touchedInbox).toEqual([]);
  });

  it('an undo of spam while it is queued keeps the thread out of Gmail spam', async () => {
    const { a, app, db, hook } = await setup(8);
    const held = holdWrites(a);
    const { undoId } = (await bulk(app, { ids: Array.from({ length: 8 }, (_, i) => tid(i)), action: 'spam' })).json() as BulkResult;
    await new Promise((r) => setTimeout(r, 5));
    await post(app, `/api/undo/${undoId}`);
    expect(thread(db, 7)).toMatchObject({ in_inbox: 1 });
    await drain(held, hook);
    for (let n = 0; n < 8; n++) {
      expect(thread(db, n)).toMatchObject({ in_inbox: 1 });
      expect(a.threadLabels(`t-${n}`)).not.toContain('SPAM');
      expect(a.threadLabels(`t-${n}`)).toContain('INBOX');
    }
    expect(a.calls.modifyThread.filter(([id, add]) => id === 't-7' && add.includes('SPAM'))).toEqual([]);
  });

  it('an undo of read while it is queued costs Gmail nothing', async () => {
    const { a, app, db, hook } = await setup(8);
    const held = holdWrites(a);
    const { undoId } = (await bulk(app, { ids: Array.from({ length: 8 }, (_, i) => tid(i)), action: 'read' })).json() as BulkResult;
    await new Promise((r) => setTimeout(r, 5));
    await post(app, `/api/undo/${undoId}`);
    expect(thread(db, 7)?.unread).toBe(1);
    await drain(held, hook);
    expect(thread(db, 7)?.unread).toBe(1);
    expect(a.calls.modifyThread.filter(([id, , remove]) => id === 't-7' && remove.includes('UNREAD'))).toEqual([]);
  });

  it('a failed undo keeps the thread as Gmail has it, and reports it', async () => {
    const { a, app, db, hook } = await setup();
    const { undoId } = (await bulk(app, { ids: [tid(0), tid(1)], action: 'done' })).json() as BulkResult;
    await hook.idle();
    failWrites(a, ['t-1']);
    const seen = events();
    const res = (await post(app, `/api/undo/${undoId}`)).json() as ActionResult;
    await hook.idle();
    expect(settled(seen)).toEqual([{ type: 'bulk.settled', undoId: res.undoId, affected: 1, failed: [tid(1)], skipped: [] }]);
    expect(thread(db, 0)).toMatchObject({ in_inbox: 1 });
    expect(thread(db, 1)).toMatchObject({ in_inbox: 0, done_at: NOW });
  });

  it('the undo of an undo redoes it', async () => {
    const { a, app, db, hook } = await setup();
    const first = (await bulk(app, { ids: [tid(0), tid(1)], action: 'done' })).json() as BulkResult;
    await hook.idle();
    const second = (await post(app, `/api/undo/${first.undoId}`)).json() as ActionResult;
    await hook.idle();
    await post(app, `/api/undo/${second.undoId}`);
    await hook.idle();
    expect(thread(db, 1)).toMatchObject({ in_inbox: 0 });
    expect(a.threadLabels('t-1')).not.toContain('INBOX');
  });

  it('a redone spam is spam again', async () => {
    const { a, app, db, hook } = await setup();
    const first = (await bulk(app, { ids: [tid(0)], action: 'spam' })).json() as BulkResult;
    await hook.idle();
    const second = (await post(app, `/api/undo/${first.undoId}`)).json() as ActionResult;
    await hook.idle();
    expect(thread(db, 0)).toBeDefined();
    await post(app, `/api/undo/${second.undoId}`);
    await hook.idle();
    expect(thread(db, 0)).toBeUndefined();
    expect(a.threadLabels('t-0')).toContain('SPAM');
  });

  it('expires like every other undo', async () => {
    const { app, clock, hook } = await setup();
    const { undoId } = (await bulk(app, { ids: [tid(0)], action: 'done' })).json() as BulkResult;
    await hook.idle();
    clock.now += UNDO_TTL_MS + 1;
    expect((await post(app, `/api/undo/${undoId}`)).statusCode).toBe(410);
  });
});

describe('a reply while a bulk write waits', () => {
  it('keeps a thread a new reply brought back from being archived', async () => {
    const { a, app, db, hook, poller } = await setup(8);
    const held = holdWrites(a);
    await bulk(app, { ids: Array.from({ length: 8 }, (_, i) => tid(i)), action: 'done' });
    await new Promise((r) => setTimeout(r, 5));
    a.deliver('t-7', { from: 'Sender 1 <s1@acme.example>', subject: 'Re: Mail 7', date: NOW + 1000, labelIds: ['INBOX', 'UNREAD'] });
    await poller.tick();
    await drain(held, hook);
    expect(thread(db, 7)).toMatchObject({ in_inbox: 1, done_at: null });
    expect(a.threadLabels('t-7')).toContain('INBOX');
  });
});

describe('POST /api/teach/bulk', () => {
  const teachBulk = (app: FastifyInstance, body: unknown) => post(app, '/api/teach/bulk', body);

  it('teaches each unique sender once, with one undo for all of them', async () => {
    const { app, db, hook } = await setup();
    const res = await teachBulk(app, { ids: [tid(0), tid(3), tid(1)], action: 'always_group', groupId: 'dev' }); // t-0 and t-3 share a sender
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ failed: [] });
    expect(db.prepare('SELECT match_value FROM rules ORDER BY match_value').pluck().all()).toEqual(['s0@acme.example', 's1@acme.example']);
    expect(toSummary(db, tid(6)).groupId).toBe('dev'); // same sender as t-0, not selected
    await hook.idle();

    const { undoId } = res.json() as BulkResult;
    expect(db.prepare('SELECT kind FROM undo WHERE id = ?').pluck().get(undoId)).toBe('bulk');
    expect((await post(app, `/api/undo/${undoId}`)).statusCode).toBe(200);
    await hook.idle();
    expect(db.prepare('SELECT count(*) FROM rules').pluck().get()).toBe(0);
    expect(toSummary(db, tid(6)).groupId).not.toBe('dev');
  });

  it('marks senders important', async () => {
    const { app, db, hook } = await setup();
    await teachBulk(app, { ids: [tid(0), tid(1)], action: 'important' });
    await hook.idle();
    expect(db.prepare('SELECT mark FROM sender_marks').pluck().all()).toEqual(['important', 'important']);
    expect(toSummary(db, tid(1)).groupId).toBe('important');
  });

  it('never relabels archived mail from those senders', async () => {
    const { a, app, hook } = await setup(4, (g) => g.addThread({ id: 't-old', messages: [{ from: 'Sender 0 <s0@acme.example>', subject: 'Archived', date: NOW - 9 * DAY, labelIds: ['CATEGORY_PERSONAL'] }] }));
    await teachBulk(app, { ids: [tid(0)], action: 'always_group', groupId: 'dev' });
    await hook.idle();
    expect(a.threadLabels('t-0')).toContain(a.labelId('SuperMail/Dev')!);
    expect(a.threadLabels('t-old')).not.toContain(a.labelId('SuperMail/Dev')!);
  });

  it('refuses more than 50 senders and an unknown action', async () => {
    const senders = (g: FakeGmail) => {
      for (let i = 0; i < 51; i++) g.addThread({ id: `s-${i}`, messages: [{ from: `P${i} <p${i}@acme.example>`, subject: 'Hi', date: NOW - HOUR, labelIds: ['INBOX'] }] });
    };
    const { app, db } = await setup(1, senders);
    const ids = Array.from({ length: 51 }, (_, i) => `a:s-${i}`);
    expect((await teachBulk(app, { ids, action: 'important' })).statusCode).toBe(400);
    expect(db.prepare('SELECT count(*) FROM sender_marks').pluck().get()).toBe(0);
    expect((await teachBulk(app, { ids: [ids[0]], action: 'explode' })).statusCode).toBe(400);
    expect((await teachBulk(app, { ids: [], action: 'important' })).statusCode).toBe(400);
  });

  it('reports threads it could not teach on, and needs the CSRF header', async () => {
    const { app } = await setup();
    const res = await teachBulk(app, { ids: [tid(0), 'a:nope'], action: 'important' });
    expect(res.json()).toMatchObject({ failed: ['a:nope'] });
    expect((await app.inject({ method: 'POST', url: '/api/teach/bulk', payload: { ids: [tid(0)], action: 'important' } })).statusCode).toBe(403);
  });
});

describe('undo() stays compatible', () => {
  it('a per-thread undo row inside a bulk action still works alone', async () => {
    const { app, db, deps, hook } = await setup();
    const { undoId } = (await bulk(app, { ids: [tid(0)], action: 'done' })).json() as BulkResult;
    await hook.idle();
    const { undoIds } = JSON.parse(db.prepare('SELECT payload_json FROM undo WHERE id = ?').pluck().get(undoId) as string) as { undoIds: string[] };
    await undo(deps, undoIds[0]!);
    expect(thread(db, 0)).toMatchObject({ in_inbox: 1 });
  });
});
