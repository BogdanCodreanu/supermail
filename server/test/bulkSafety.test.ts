import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { google } from 'googleapis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_HEADER, type ActionResult, type BulkResult, type ServerEvent, type ThreadPage } from '@supermail/shared';
import { reconcileIndex, replayPendingWrites, teachBulk } from '../src/actions/bulk.js';
import type { AppConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db/index.js';
import { bus } from '../src/events.js';
import { GmailNoAnswer } from '../src/google/gmailApi.js';
import { createGmailApi, createTokenBucket, GMAIL_QUOTA_COST, GMAIL_QUOTA_UNITS_PER_SEC, type OAuth2Client } from '../src/google/gmailClient.js';
import { ALLOW_ALL, type AppDeps, buildApp } from '../src/http/app.js';
import { spamRoutes } from '../src/http/routes/spam.js';
import { threadsRoutes } from '../src/http/routes/threads.js';
import { SNOOZED_LABEL } from '../src/labels/labelWriter.js';
import { createSnoozeScheduler } from '../src/scheduler/snoozeScheduler.js';
import { listSkipped } from '../src/skipped/skipped.js';
import { createPoller } from '../src/sync/poller.js';
import { LABEL_CONCURRENCY, makeThreadHook } from '../src/threads/classifyThread.js';
import { toSummary } from '../src/threads/queries.js';
import { createFakeGmail, type FakeGmail } from './fakes/fakeGmail.js';
import { DAY, HOUR } from './fixtures/threads.js';

const NOW = Date.UTC(2026, 9, 29, 10, 0, 0);
const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
const OWNER = 'me@gmail.com';
const REPLY = { from: 'Real Person <p@acme.example>', subject: 'Re: Mail', labelIds: ['INBOX', 'UNREAD'] };
const tid = (n: number | string) => `a:t-${n}`;
const ids = (count: number) => Array.from({ length: count }, (_, i) => tid(i));
const apps: FastifyInstance[] = [];
const unsubscribe: (() => void)[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const off of unsubscribe.splice(0)) off();
  for (const app of apps.splice(0)) await app.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function services(db: DB, a: FakeGmail, clock: { now: number }) {
  const gmailFor = () => a;
  const hook = makeThreadHook({ db, gmailFor, now: () => clock.now, log });
  const poller = createPoller({ db, gmailFor, intervalMs: 30_000, onChange: hook, log });
  const deps: AppDeps = { db, config: { ownerEmail: OWNER } as AppConfig, gmailFor, now: () => clock.now, onThreadChange: hook, storage: ALLOW_ALL };
  return { hook, poller, deps };
}

async function setup(count = 8, before?: (a: FakeGmail) => void, file: string | ':memory:' = ':memory:') {
  const db: DB = openDb(file);
  db.prepare("INSERT INTO accounts(id, email, color, status, created_at) VALUES ('a', 'me@gmail.com', '#2563eb', 'syncing', 1)").run();
  const clock = { now: NOW };
  const a = createFakeGmail(OWNER, { now: () => clock.now });
  for (let i = 0; i < count; i++) {
    a.addThread({ id: `t-${i}`, messages: [{ from: `Sender ${i % 3} <s${i % 3}@acme.example>`, subject: `Mail ${i}`, date: NOW - (i + 1) * HOUR, labelIds: ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL'] }] });
  }
  before?.(a);
  const { hook, poller, deps } = services(db, a, clock);
  await poller.tick();
  await hook.idle();
  const app = await buildApp(deps, [threadsRoutes, spamRoutes], { webDir: '/nonexistent' });
  apps.push(app);
  return { db, a, clock, deps, app, hook, poller, file };
}

/** The same mailbox on disk, so `restart` can stop the process halfway through a bulk action. */
function setupOnDisk(count = 8, before?: (a: FakeGmail) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'supermail-bulk-'));
  tempDirs.push(dir);
  return setup(count, before, join(dir, 'supermail.db'));
}

/**
 * What a stop and start does: everything in memory is lost (the queue, the jobs, whatever Gmail had not answered),
 * the database is opened afresh, and main.ts runs reconcile and then the replay.
 */
function restart(world: Awaited<ReturnType<typeof setup>>, held: ReturnType<typeof holdWrites>) {
  held.stop();
  world.db.close();
  const db = openDb(world.file);
  const reconciled = reconcileIndex(db);
  const { hook, poller, deps } = services(db, world.a, world.clock);
  replayPendingWrites(deps, log);
  return { db, hook, poller, deps, reconciled };
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
  const held: { id: string; release(): Promise<void> }[] = [];
  a.modifyThread = (id, add, remove) =>
    new Promise<void>((resolve, reject) => {
      held.push({
        id,
        release: async () => {
          await real(id, add, remove).then(resolve, reject);
          await new Promise((r) => setImmediate(r));
        },
      });
    });
  return Object.assign(held, { real, stop: () => void (a.modifyThread = real) });
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

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 1));
};

const thread = (db: DB, n: number) => db.prepare('SELECT in_inbox, unread, done_at, group_id FROM threads WHERE id = ?').get(tid(n)) as { in_inbox: number; unread: number; done_at: number | null; group_id: string } | undefined;
const inboxIds = async (app: FastifyInstance) => ((await app.inject('/api/threads?limit=200')).json() as ThreadPage).threads.map((t) => t.id);
const snoozeRow = (db: DB, n: number) => db.prepare('SELECT until FROM snoozes WHERE thread_id = ?').get(tid(n)) as { until: number } | undefined;
const overrideRow = (db: DB, n: number) => db.prepare('SELECT group_id, source, suggest_rule FROM overrides WHERE thread_id = ?').get(tid(n)) as { group_id: string; source: string; suggest_rule: number } | undefined;
const journal = (db: DB) => db.prepare('SELECT thread_id, op FROM pending_writes ORDER BY seq').all() as { thread_id: string; op: string }[];
const readCalls = (a: FakeGmail) => a.calls.all.filter((c) => c === 'getThread').length;
const gmailCalls = (a: FakeGmail) => a.calls.all.filter((c) => c === 'getThread' || c === 'modifyThread').length;
const otherGroup = (db: DB, old: string) => db.prepare("SELECT id FROM groups WHERE id != ? AND id != 'unsorted' ORDER BY position LIMIT 1").pluck().get(old) as string;

describe('review #1: a queued write stands down when Gmail has mail the index lacks', () => {
  // Five writes are on their way to Gmail and held there; t-7 is still waiting its turn when the reply lands.
  it('R4 keeps a reply that arrives while a bulk Done waits in the inbox, and reports it as skipped', async () => {
    const { a, app, db, clock, hook, poller } = await setup();
    const held = holdWrites(a);
    const seen = events();
    const { undoId } = (await bulk(app, { ids: ids(8), action: 'done' })).json() as BulkResult;
    clock.now += 10_000;
    a.deliver('t-7', { ...REPLY, date: clock.now });
    await drain(held, hook); // the write's turn comes before the poller saw the reply
    expect(a.threadLabels('t-7')).toEqual(expect.arrayContaining(['INBOX', 'UNREAD']));
    expect(thread(db, 7)).toMatchObject({ in_inbox: 1, done_at: null });
    expect(await inboxIds(app)).toContain(tid(7));
    expect(settled(seen)).toEqual([{ type: 'bulk.settled', undoId, affected: 7, failed: [], skipped: [tid(7)] }]);
    await poller.tick();
    await hook.idle();
    expect(a.threadLabels('t-7')).toContain('INBOX');
    expect(thread(db, 7)).toMatchObject({ in_inbox: 1, unread: 1, done_at: null });
    expect(await inboxIds(app)).toContain(tid(7));
    expect(listSkipped(db, clock.now).threads.some((t) => t.id === tid(7))).toBe(false);
  });

  it.each([
    ['snooze', { action: 'snooze', until: NOW + DAY }],
    ['read', { action: 'read' }],
    ['spam', { action: 'spam' }],
  ])('a reply the poller has not seen stands down a queued %s', async (_name, body) => {
    const { a, app, db, clock, hook, poller } = await setup();
    const held = holdWrites(a);
    const seen = events();
    await bulk(app, { ids: ids(8), ...body });
    clock.now += 10_000;
    a.deliver('t-7', { ...REPLY, date: clock.now });
    await drain(held, hook);
    expect(a.threadLabels('t-7')).toEqual(expect.arrayContaining(['INBOX', 'UNREAD']));
    expect(a.threadLabels('t-7')).not.toContain('SPAM');
    expect(settled(seen)[0]?.skipped).toEqual([tid(7)]);
    await poller.tick();
    await hook.idle();
    expect(thread(db, 7)).toMatchObject({ in_inbox: 1, unread: 1 });
    expect(snoozeRow(db, 7)).toBeUndefined();
  });

  it('leaves a skipped thread out of the bulk undo', async () => {
    const { a, app, db, clock, hook } = await setup();
    const held = holdWrites(a);
    const { undoId } = (await bulk(app, { ids: ids(8), action: 'done' })).json() as BulkResult;
    clock.now += 10_000;
    a.deliver('t-7', { ...REPLY, date: clock.now });
    await drain(held, hook);
    held.stop();
    const res = (await post(app, `/api/undo/${undoId}`)).json() as ActionResult;
    expect(res.affected).toBe(7);
    await hook.idle();
    expect(thread(db, 7)).toMatchObject({ in_inbox: 1 });
  });

  it('a draft in the thread is not new mail: the index never holds drafts', async () => {
    const { a, app, hook } = await setup(2);
    a.deliver('t-1', { from: OWNER, subject: 'Re: Mail 1', labelIds: ['DRAFT'] });
    const seen = events();
    await bulk(app, { ids: [tid(1)], action: 'done' });
    await hook.idle();
    expect(settled(seen)[0]).toMatchObject({ affected: 1, skipped: [] });
    expect(a.threadLabels('t-1')).not.toContain('INBOX');
  });

  it('adds one read to each write that hides mail, and none to a write that does not', async () => {
    const { a, app, hook } = await setup();
    const before = readCalls(a);
    await bulk(app, { ids: ids(4), action: 'done' });
    await hook.idle();
    expect(readCalls(a) - before).toBe(4);
    const after = readCalls(a);
    await bulk(app, { ids: ids(4), action: 'move', groupId: 'dev' });
    await hook.idle();
    expect(readCalls(a)).toBe(after);
  });

  it('a write that puts mail back reads nothing, but a redo that hides it again does', async () => {
    const { a, app, db, clock, hook } = await setup(2);
    const first = (await bulk(app, { ids: [tid(1)], action: 'done' })).json() as BulkResult;
    await hook.idle();
    const reads = readCalls(a);
    const back = (await post(app, `/api/undo/${first.undoId}`)).json() as ActionResult;
    await hook.idle();
    expect(readCalls(a)).toBe(reads);
    clock.now += 10_000;
    a.deliver('t-1', { ...REPLY, date: clock.now });
    await post(app, `/api/undo/${back.undoId}`);
    await hook.idle();
    expect(readCalls(a)).toBe(reads + 1);
    expect(a.threadLabels('t-1')).toContain('INBOX');
    expect(thread(db, 1)).toMatchObject({ in_inbox: 1, done_at: null });
  });

  it('charges the read to the quota: a bulk Done runs at half the pace', async () => {
    const { a, app, deps, hook } = await setup(40);
    const auth = new google.auth.OAuth2();
    (auth as unknown as { request(o: { url: string; method?: string }): Promise<unknown> }).request = async ({ url, method }) => {
      if (method === 'POST') return { data: {} };
      return { data: await a.getThread(/threads\/([^/?]+)/.exec(url)![1]!, 'metadata') };
    };
    let t = 0;
    const clock = { now: () => t, sleep: async (ms: number) => void (t += ms) };
    const gmail = createGmailApi(auth as unknown as OAuth2Client, { quota: createTokenBucket(GMAIL_QUOTA_UNITS_PER_SEC, GMAIL_QUOTA_UNITS_PER_SEC, clock) });
    deps.gmailFor = () => gmail;
    await bulk(app, { ids: ids(40), action: 'done' });
    await hook.idle();
    // A read and a write each: 800 units, 200 of them the burst, then 600 at 200 a second.
    expect(GMAIL_QUOTA_COST.getThread + GMAIL_QUOTA_COST.modifyThread).toBe(20);
    expect(t).toBeGreaterThanOrEqual(2999);
  });
});

describe('review #2: the journal survives a restart', () => {
  it('holds the intended state of each queued write, from the index change until Gmail confirms', async () => {
    const { a, app, db, hook } = await setup();
    const held = holdWrites(a);
    await bulk(app, { ids: [tid(0), tid(1)], action: 'done' });
    expect(journal(db)).toEqual([{ thread_id: tid(0), op: 'done' }, { thread_id: tid(1), op: 'done' }]);
    await drain(held, hook);
    expect(journal(db)).toEqual([]);
  });

  it('clears the row of a write Gmail refused', async () => {
    const { a, app, db, hook } = await setup();
    a.modifyThread = () => Promise.reject(new Error('Gmail said no'));
    await bulk(app, { ids: [tid(0)], action: 'done' });
    await hook.idle();
    expect(journal(db)).toEqual([]);
  });

  it('writes a bulk undo to the journal too, in place of the write it cancels', async () => {
    const { a, app, db, hook } = await setup(8);
    const held = holdWrites(a);
    const { undoId } = (await bulk(app, { ids: ids(8), action: 'done' })).json() as BulkResult;
    await post(app, `/api/undo/${undoId}`);
    expect(journal(db).map((j) => j.op)).toEqual(Array.from({ length: 8 }, () => 'undo'));
    await drain(held, hook);
    expect(journal(db)).toEqual([]);
  });

  it('R1 a snooze Gmail applied just before a restart stays snoozed and comes back when due', async () => {
    const world = await setupOnDisk();
    const { a, app, clock } = world;
    const held = holdWrites(a);
    const due = NOW + 2 * DAY;
    await bulk(app, { ids: [tid(0)], action: 'snooze', until: due });
    await until(() => held.length > 0);
    await held.real('t-0', [a.labelId(SNOOZED_LABEL)!], ['INBOX']); // Gmail did it; the answer never got back
    const { db, deps, hook, poller, reconciled } = restart(world, held);
    expect(reconciled).toBe(0);
    await hook.idle();
    await poller.tick();
    await hook.idle();
    expect(snoozeRow(db, 0)).toEqual({ until: due });
    expect(thread(db, 0)).toMatchObject({ in_inbox: 0 });
    expect(journal(db)).toEqual([]);
    clock.now = due + DAY;
    expect(await createSnoozeScheduler(deps).runDue()).toBe(1);
    expect(a.threadLabels('t-0')).toContain('INBOX');
    expect(a.threadLabels('t-0')).not.toContain(a.labelId(SNOOZED_LABEL)!);
    expect(listSkipped(db, clock.now).threads.some((t) => t.id === tid(0))).toBe(false);
    db.close();
  });

  it('a Done Gmail applied just before a restart stays Done', async () => {
    const world = await setupOnDisk();
    const { a, app } = world;
    const held = holdWrites(a);
    await bulk(app, { ids: [tid(0)], action: 'done' });
    await until(() => held.length > 0);
    await held.real('t-0', [], ['INBOX']);
    const { db, hook, poller } = restart(world, held);
    await hook.idle();
    await poller.tick();
    await hook.idle();
    expect(thread(db, 0)).toMatchObject({ in_inbox: 0, done_at: NOW });
    db.close();
  });

  it.each([
    ['done', { action: 'done' }, (a: FakeGmail) => expect(a.threadLabels('t-7')).not.toContain('INBOX')],
    ['snooze', { action: 'snooze', until: NOW + DAY }, (a: FakeGmail) => expect(a.threadLabels('t-7')).toContain(a.labelId(SNOOZED_LABEL)!)],
    ['read', { action: 'read' }, (a: FakeGmail) => expect(a.threadLabels('t-7')).not.toContain('UNREAD')],
    ['spam', { action: 'spam' }, (a: FakeGmail) => expect(a.threadLabels('t-7')).toContain('SPAM')],
  ])('a restart finishes a %s still in the queue', async (_name, body, check) => {
    const world = await setupOnDisk();
    const held = holdWrites(world.a);
    await bulk(world.app, { ids: ids(8), ...body });
    const { db, hook } = restart(world, held);
    await hook.idle();
    check(world.a);
    expect(journal(db)).toEqual([]);
    db.close();
  });

  it('R9 a restart while undoing a landed bulk snooze finishes the undo', async () => {
    const world = await setupOnDisk();
    const { a, app, clock } = world;
    const due = NOW + 2 * DAY;
    const res = (await bulk(app, { ids: [tid(0)], action: 'snooze', until: due })).json() as BulkResult;
    await world.hook.idle();
    const held = holdWrites(a);
    await post(app, `/api/undo/${res.undoId}`); // the write back to the inbox never reaches Gmail
    const { db, deps, hook, poller } = restart(world, held);
    await hook.idle();
    await poller.tick();
    await hook.idle();
    expect(thread(db, 0)).toMatchObject({ in_inbox: 1 });
    expect(snoozeRow(db, 0)).toBeUndefined();
    expect(a.threadLabels('t-0')).toContain('INBOX');
    expect(a.threadLabels('t-0')).not.toContain(a.labelId(SNOOZED_LABEL)!);
    clock.now = due + DAY;
    expect(await createSnoozeScheduler(deps).runDue()).toBe(0);
    db.close();
  });

  it('R9 a restart while undoing a landed bulk Done puts it back in Gmail too', async () => {
    const world = await setupOnDisk();
    const { a, app } = world;
    const res = (await bulk(app, { ids: [tid(0)], action: 'done' })).json() as BulkResult;
    await world.hook.idle();
    const held = holdWrites(a);
    await post(app, `/api/undo/${res.undoId}`);
    const { db, hook, poller } = restart(world, held);
    await hook.idle();
    await poller.tick();
    await hook.idle();
    expect(a.threadLabels('t-0')).toContain('INBOX');
    expect(thread(db, 0)).toMatchObject({ in_inbox: 1, done_at: null });
    db.close();
  });

  it('an undo in flight when Gmail took the Done it replaced still gets the thread back after a restart', async () => {
    const world = await setupOnDisk();
    const { a, app } = world;
    const held = holdWrites(a);
    const res = (await bulk(app, { ids: [tid(0)], action: 'done' })).json() as BulkResult;
    await until(() => held.length > 0);
    await post(app, `/api/undo/${res.undoId}`); // queued behind the write already on its way
    await held.real('t-0', [], ['INBOX']); // and that write got through
    const { db, hook } = restart(world, held);
    await hook.idle();
    expect(a.threadLabels('t-0')).toContain('INBOX');
    expect(thread(db, 0)).toMatchObject({ in_inbox: 1, done_at: null });
    db.close();
  });

  it('a reply that arrived while the server was down stands the write down', async () => {
    const world = await setupOnDisk();
    const { a, app, clock } = world;
    const held = holdWrites(a);
    await bulk(app, { ids: ids(8), action: 'done' });
    clock.now += HOUR;
    a.deliver('t-7', { ...REPLY, date: clock.now });
    const { db, hook } = restart(world, held);
    await hook.idle();
    expect(a.threadLabels('t-7')).toContain('INBOX');
    expect(thread(db, 7)).toMatchObject({ in_inbox: 1, done_at: null });
    expect(a.threadLabels('t-0')).not.toContain('INBOX');
    db.close();
  });

  it('a replayed write Gmail refuses is put back, so the thread stays visible', async () => {
    const world = await setupOnDisk();
    const { a, app } = world;
    const held = holdWrites(a);
    await bulk(app, { ids: [tid(0)], action: 'done' });
    held.stop();
    a.modifyThread = () => Promise.reject(new Error('Gmail said no'));
    const { db, hook } = restart(world, Object.assign(held, { stop() {} }));
    await hook.idle();
    expect(thread(db, 0)).toMatchObject({ in_inbox: 1, done_at: null });
    expect(journal(db)).toEqual([]);
    db.close();
  });

  it('a replayed write can still be undone', async () => {
    const world = await setupOnDisk();
    const { a, app, clock } = world;
    const held = holdWrites(a);
    const { undoId } = (await bulk(app, { ids: ids(8), action: 'done' })).json() as BulkResult;
    const { db, deps, hook } = restart(world, held);
    const app2 = await buildApp(deps, [threadsRoutes], { webDir: '/nonexistent' });
    apps.push(app2);
    await hook.idle();
    clock.now += 1000;
    expect((await post(app2, `/api/undo/${undoId}`)).statusCode).toBe(200);
    await hook.idle();
    expect(a.threadLabels('t-7')).toContain('INBOX');
    expect(thread(db, 7)).toMatchObject({ in_inbox: 1, done_at: null });
  });

  it('replays nothing when the journal is empty', async () => {
    const { db, deps } = await setup();
    expect(replayPendingWrites(deps, log)).toBe(0);
    expect(journal(db)).toEqual([]);
  });
});

describe('reconcileIndex', () => {
  it('leaves every thread with a journal row to the replay', async () => {
    const { a, app, db } = await setup();
    holdWrites(a);
    await bulk(app, { ids: [tid(0)], action: 'done' });
    await bulk(app, { ids: [tid(1)], action: 'snooze', until: NOW + DAY });
    await bulk(app, { ids: [tid(2)], action: 'read' });
    await bulk(app, { ids: [tid(3)], action: 'spam' });
    expect(reconcileIndex(db)).toBe(0);
    expect(thread(db, 0)).toMatchObject({ in_inbox: 0, done_at: NOW });
    expect(snoozeRow(db, 1)).toEqual({ until: NOW + DAY });
    expect(thread(db, 2)?.unread).toBe(0);
  });

  it('corrects only in_inbox and unread, never done_at or a snooze, for a thread with no journal row', async () => {
    const { db } = await setup();
    db.prepare('UPDATE threads SET in_inbox = 0, unread = 0, done_at = ? WHERE id = ?').run(NOW, tid(0));
    db.prepare('UPDATE threads SET in_inbox = 0 WHERE id = ?').run(tid(1));
    db.prepare('INSERT INTO snoozes(thread_id, until, created_at) VALUES (?, ?, ?)').run(tid(1), NOW + DAY, NOW);
    expect(reconcileIndex(db)).toBe(2);
    expect(thread(db, 0)).toMatchObject({ in_inbox: 1, unread: 1, done_at: NOW });
    expect(snoozeRow(db, 1)).toEqual({ until: NOW + DAY });
    expect(reconcileIndex(db)).toBe(0);
  });
});

describe('review #3: a queued bulk move is never read as the owner moving it in Gmail', () => {
  async function moved(world: Awaited<ReturnType<typeof setup>>) {
    const { app, db, clock } = world;
    clock.now += HOUR;
    const old = thread(db, 0)!.group_id;
    const target = otherGroup(db, old);
    await bulk(app, { ids: [tid(0)], action: 'move', groupId: target });
    return { old, target };
  }

  it('R3 a Gmail event during the wait leaves the move alone and the write still lands', async () => {
    const world = await setup();
    const { a, db, hook, poller } = world;
    const held = holdWrites(a);
    const { old, target } = await moved(world);
    a.setLabels('t-0', [], ['UNREAD']); // the owner reads it on the phone
    await poller.tick();
    await drain(held, hook);
    expect(overrideRow(db, 0)).toMatchObject({ group_id: target, source: 'app', suggest_rule: 0 });
    expect(thread(db, 0)!.group_id).toBe(target);
    const labels = a.threadLabels('t-0');
    expect(labels).toContain(db.prepare("SELECT gmail_label_id FROM group_labels WHERE group_id = ? AND account_id = 'a'").pluck().get(target));
    expect(labels).not.toContain(db.prepare("SELECT gmail_label_id FROM group_labels WHERE group_id = ? AND account_id = 'a'").pluck().get(old));
  });

  it('R2 a bulk move cut off by a restart is finished, and a Gmail event before that does not reverse it', async () => {
    const world = await setupOnDisk();
    const { a, clock } = world;
    const held = holdWrites(a);
    const { target } = await moved(world);
    held.stop();
    world.db.close();
    const db = openDb(world.file);
    reconcileIndex(db);
    const { hook, poller, deps } = services(db, a, clock);
    a.setLabels('t-0', [], ['UNREAD']); // the event gets in before the replay does
    await poller.tick();
    await hook.idle();
    expect(overrideRow(db, 0)).toMatchObject({ group_id: target, source: 'app', suggest_rule: 0 });
    expect(thread(db, 0)!.group_id).toBe(target);
    replayPendingWrites(deps, log);
    await hook.idle();
    expect(journal(db)).toEqual([]);
    expect(a.threadLabels('t-0')).toContain(db.prepare("SELECT gmail_label_id FROM group_labels WHERE group_id = ? AND account_id = 'a'").pluck().get(target));
    db.close();
  });

  it('a move to Unsorted, which has no label to wait for, is safe too', async () => {
    const world = await setup();
    const { a, app, db, clock, hook, poller } = world;
    clock.now += HOUR;
    const held = holdWrites(a);
    await bulk(app, { ids: [tid(0)], action: 'move', groupId: 'unsorted' });
    a.setLabels('t-0', [], ['UNREAD']);
    await poller.tick();
    await drain(held, hook);
    expect(overrideRow(db, 0)).toMatchObject({ group_id: 'unsorted', source: 'app', suggest_rule: 0 });
  });

  it('still accepts the owner moving the thread in Gmail once the bulk move has landed', async () => {
    const world = await setup();
    const { a, db, clock, hook, poller } = world;
    const { old, target } = await moved(world);
    await hook.idle();
    clock.now += HOUR;
    const oldLabel = db.prepare("SELECT gmail_label_id FROM group_labels WHERE group_id = ? AND account_id = 'a'").pluck().get(old) as string;
    const targetLabel = db.prepare("SELECT gmail_label_id FROM group_labels WHERE group_id = ? AND account_id = 'a'").pluck().get(target) as string;
    a.setLabels('t-0', [oldLabel], [targetLabel]);
    await poller.tick();
    await hook.idle();
    expect(overrideRow(db, 0)).toMatchObject({ group_id: old, source: 'gmail', suggest_rule: 1 });
    expect(a.threadLabels('t-0')).toContain(oldLabel);
  });
});

describe('review #4: bulk spam cannot stall Gmail', () => {
  it('R10 the poller does not announce a thread already gone from the index', async () => {
    const { app, hook, poller } = await setup(30);
    const seen = events();
    await bulk(app, { ids: ids(30), action: 'spam' });
    await hook.idle();
    expect(seen.filter((e) => e.type === 'thread.removed')).toHaveLength(30);
    seen.length = 0;
    await poller.tick();
    expect(seen.filter((e) => e.type === 'thread.removed')).toEqual([]);
  });

  it('the poller still announces a thread leaving the index', async () => {
    const { a, poller } = await setup(2);
    const seen = events();
    a.deleteThread('t-1');
    await poller.tick();
    expect(seen).toContainEqual({ type: 'thread.removed', id: tid(1) });
  });

  const spamList = async (app: FastifyInstance) => ((await app.inject('/api/spam')).json() as ThreadPage).threads.map((t) => t.id);
  const addSpam = (a: FakeGmail) => a.addThread({ id: 's-1', messages: [{ from: 'Prize <prize@spam.example>', subject: 'You won', date: NOW - HOUR, labelIds: ['SPAM'] }] });

  it('reads Gmail once for repeat calls within 10 s, per account', async () => {
    const { a, app, clock } = await setup(1, addSpam);
    const calls = () => a.calls.all.filter((c) => c === 'listThreads' || c === 'getThread').length;
    expect(await spamList(app)).toEqual(['a:s-1']);
    const once = calls();
    for (let i = 0; i < 20; i++) await spamList(app);
    expect(calls()).toBe(once);
    clock.now += 9_999;
    await spamList(app);
    expect(calls()).toBe(once);
    clock.now += 2;
    await spamList(app);
    expect(calls()).toBeGreaterThan(once);
  });

  it('shares one read between requests that overlap', async () => {
    const { a, app } = await setup(1, addSpam);
    const before = a.calls.all.filter((c) => c === 'listThreads').length;
    await Promise.all(Array.from({ length: 5 }, () => spamList(app)));
    expect(a.calls.all.filter((c) => c === 'listThreads').length - before).toBe(1);
  });

  it('forgets the list on report spam and on Not spam', async () => {
    const { a, app, hook } = await setup(3, addSpam);
    await spamList(app);
    await post(app, `/api/threads/${encodeURIComponent(tid(0))}/spam`);
    expect((await spamList(app)).sort()).toEqual([tid(0), 'a:s-1'].sort());
    await bulk(app, { ids: [tid(1)], action: 'spam' });
    await hook.idle();
    expect(await spamList(app)).toContain(tid(1));
    await post(app, `/api/spam/${encodeURIComponent('a:s-1')}/not-spam`);
    expect(await spamList(app)).not.toContain('a:s-1');
    expect(a.threadLabels('s-1')).toContain('INBOX');
  });

  it('never keeps a failed read', async () => {
    const { a, app } = await setup(1, addSpam);
    const real = a.listThreads.bind(a);
    a.listThreads = () => Promise.reject(new Error('Gmail said no'));
    expect((await app.inject('/api/spam')).statusCode).toBe(500);
    a.listThreads = real;
    expect(await spamList(app)).toEqual(['a:s-1']);
  });
});

describe('review #5: read and spam stand down on a reply the index has', () => {
  it('R5 a queued bulk read leaves a reply unread', async () => {
    const { a, app, db, clock, hook, poller } = await setup();
    const held = holdWrites(a);
    const seen = events();
    await bulk(app, { ids: ids(8), action: 'read' });
    clock.now += 10_000;
    a.deliver('t-7', { ...REPLY, date: clock.now });
    await poller.tick();
    expect(thread(db, 7)!.unread).toBe(1);
    await drain(held, hook);
    expect(a.threadLabels('t-7')).toContain('UNREAD');
    expect(thread(db, 7)!.unread).toBe(1);
    expect(settled(seen)[0]?.skipped).toEqual([tid(7)]);
  });

  it('R6 a queued bulk spam leaves a real reply out of spam and on the list', async () => {
    const { a, app, db, clock, hook, poller } = await setup();
    const held = holdWrites(a);
    const seen = events();
    await bulk(app, { ids: ids(8), action: 'spam' });
    clock.now += 10_000;
    a.deliver('t-7', { ...REPLY, date: clock.now });
    await poller.tick();
    await drain(held, hook);
    expect(a.threadLabels('t-7')).not.toContain('SPAM');
    expect(a.threadLabels('t-7')).toContain('INBOX');
    expect(thread(db, 7)).toMatchObject({ in_inbox: 1 });
    expect(await inboxIds(app)).toContain(tid(7));
    expect(settled(seen)[0]?.skipped).toEqual([tid(7)]);
  });
});

describe('review #7: bulk undo works per row', () => {
  it('R7 skips a thread whose old group was deleted, finishes the others, and spends the undo id only at the end', async () => {
    const { a, app, db, hook } = await setup(120);
    db.prepare("INSERT INTO groups(id, name, position, color, kind) VALUES ('gone', 'Gone', 50, '#000', 'custom')").run();
    db.prepare("INSERT INTO overrides(thread_id, group_id, source, created_at) VALUES (?, 'gone', 'app', 1)").run(tid(70));
    const before = thread(db, 100)!.group_id;
    const { undoId } = (await bulk(app, { ids: ids(120), action: 'move', groupId: 'dev' })).json() as BulkResult;
    await hook.idle();
    db.prepare("DELETE FROM groups WHERE id = 'gone'").run();
    const res = await post(app, `/api/undo/${undoId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ affected: 119, skipped: 1 });
    await hook.idle();
    expect(thread(db, 100)!.group_id).toBe(before);
    expect(overrideRow(db, 100)).toBeUndefined();
    expect(thread(db, 70)!.group_id).toBe('dev');
    expect(a.threadLabels('t-0')).not.toContain(a.labelId('SuperMail/Dev')!);
    expect((await post(app, `/api/undo/${undoId}`)).statusCode).toBe(404);
  });

  it('skips a thread that left the index, and counts it', async () => {
    const { a, app, db, hook, poller } = await setup();
    const { undoId } = (await bulk(app, { ids: [tid(0), tid(1), tid(2)], action: 'done' })).json() as BulkResult;
    await hook.idle();
    a.deleteThread('t-1');
    await poller.tick();
    expect((await post(app, `/api/undo/${undoId}`)).json()).toMatchObject({ affected: 2, skipped: 1 });
    await hook.idle();
    expect(thread(db, 0)).toMatchObject({ in_inbox: 1 });
    expect(thread(db, 2)).toMatchObject({ in_inbox: 1 });
  });

  it('R8 undoes every teaching even when one anchor thread left the index', async () => {
    const { a, app, db, hook, poller } = await setup();
    const res = await post(app, '/api/teach/bulk', { ids: [tid(0), tid(1)], action: 'not_important' });
    await hook.idle();
    expect(db.prepare('SELECT count(*) FROM sender_marks').pluck().get()).toBe(2);
    a.deleteThread('t-0');
    await poller.tick();
    await hook.idle();
    const { undoId } = res.json() as BulkResult;
    const u = await post(app, `/api/undo/${undoId}`);
    expect(u.statusCode).toBe(200);
    expect(db.prepare('SELECT count(*) FROM sender_marks').pluck().get()).toBe(0);
    expect((await post(app, `/api/undo/${undoId}`)).statusCode).toBe(404);
  });

  it('a row the database refuses is reported, and every other row still goes through and to Gmail', async () => {
    const { a, app, db, hook } = await setup();
    db.exec(`CREATE TRIGGER boom BEFORE UPDATE OF done_at ON threads WHEN NEW.id = '${tid(1)}' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    const res = await bulk(app, { ids: [tid(0), tid(1), tid(2)], action: 'done' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ affected: 2, failed: [tid(1)] });
    await hook.idle();
    expect(a.threadLabels('t-0')).not.toContain('INBOX');
    expect(a.threadLabels('t-2')).not.toContain('INBOX');
    expect(a.threadLabels('t-1')).toContain('INBOX');
    expect(thread(db, 1)).toMatchObject({ in_inbox: 1, done_at: null });
    expect(journal(db)).toEqual([]);
  });

  it('a row that fails inside an undo is counted, and the rest finish', async () => {
    const { app, db, hook } = await setup();
    const { undoId } = (await bulk(app, { ids: [tid(0), tid(1), tid(2)], action: 'done' })).json() as BulkResult;
    await hook.idle();
    db.exec(`CREATE TRIGGER boom BEFORE UPDATE OF in_inbox ON threads WHEN NEW.id = '${tid(1)}' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    const res = await post(app, `/api/undo/${undoId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ affected: 2, skipped: 1 });
    await hook.idle();
    expect(thread(db, 0)).toMatchObject({ in_inbox: 1 });
    expect(thread(db, 2)).toMatchObject({ in_inbox: 1 });
  });
});

describe('item 9: Gmail calls that hang', () => {
  const stub = (request: (o: { url: string; method?: string }) => Promise<unknown>): OAuth2Client => {
    const auth = new google.auth.OAuth2();
    (auth as unknown as { request: typeof request }).request = request;
    return auth as unknown as OAuth2Client;
  };

  it('gives up on a request after the timeout, and the worker is free again', async () => {
    let answer = false;
    const api = createGmailApi(stub(async () => (answer ? { data: { emailAddress: 'x', historyId: '1' } } : new Promise(() => {}))), { timeoutMs: 10 });
    const hung = await Promise.allSettled(Array.from({ length: 6 }, () => api.modifyThread('t', [], [])));
    expect(hung.every((r) => r.status === 'rejected' && r.reason instanceof GmailNoAnswer)).toBe(true);
    answer = true;
    await expect(api.getProfile()).resolves.toMatchObject({ emailAddress: 'x' });
  });

  it('aborts the hung request', async () => {
    let signal: AbortSignal | undefined;
    const api = createGmailApi(stub((o) => {
      signal = (o as { signal?: AbortSignal }).signal;
      return new Promise(() => {});
    }), { timeoutMs: 10 });
    await expect(api.getThread('t', 'metadata')).rejects.toBeInstanceOf(GmailNoAnswer);
    expect(signal?.aborted).toBe(true);
  });

  it('counts a dropped connection as no answer, but not an answer from Gmail', async () => {
    const dropped = createGmailApi(stub(async () => Promise.reject(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))));
    await expect(dropped.modifyThread('t', [], [])).rejects.toBeInstanceOf(GmailNoAnswer);
    const refused = createGmailApi(stub(async () => Promise.reject(Object.assign(new Error('nope'), { response: { status: 500 } }))));
    await expect(refused.modifyThread('t', [], [])).rejects.not.toBeInstanceOf(GmailNoAnswer);
  });

  const noAnswer = (a: FakeGmail, landed: boolean) => {
    const real = a.modifyThread.bind(a);
    a.modifyThread = async (id, add, remove) => {
      if (landed) await real(id, add, remove);
      throw new GmailNoAnswer('Gmail did not answer');
    };
    return real;
  };

  it('a timed-out write that Gmail did apply counts as landed', async () => {
    const { a, app, db, hook } = await setup(2);
    noAnswer(a, true);
    const seen = events();
    await bulk(app, { ids: [tid(0)], action: 'snooze', until: NOW + DAY });
    await hook.idle();
    expect(settled(seen)[0]).toMatchObject({ affected: 1, failed: [] });
    expect(snoozeRow(db, 0)).toEqual({ until: NOW + DAY });
    expect(thread(db, 0)).toMatchObject({ in_inbox: 0 });
    expect(journal(db)).toEqual([]);
  });

  it('a timed-out write that Gmail did not apply is put back', async () => {
    const { a, app, db, hook } = await setup(2);
    noAnswer(a, false);
    const seen = events();
    await bulk(app, { ids: [tid(0)], action: 'done' });
    await hook.idle();
    expect(settled(seen)[0]).toMatchObject({ affected: 0, failed: [tid(0)] });
    expect(thread(db, 0)).toMatchObject({ in_inbox: 1, done_at: null });
    expect(a.threadLabels('t-0')).toContain('INBOX');
  });

  it('reads the thread once to learn the truth, and a failed read leaves the thread visible', async () => {
    const { a, app, db, hook } = await setup(2);
    noAnswer(a, false);
    const real = a.getThread.bind(a);
    let reads = 0;
    a.getThread = (id, format) => (++reads === 1 ? real(id, format) : Promise.reject(new Error('Gmail said no')));
    await bulk(app, { ids: [tid(0)], action: 'done' });
    await hook.idle();
    expect(reads).toBe(2); // the check for new mail, then the one look after the timeout
    expect(thread(db, 0)).toMatchObject({ in_inbox: 1, done_at: null });
  });

  it('single-thread actions learn the truth the same way', async () => {
    const { a, app, db } = await setup(2);
    noAnswer(a, true);
    const res = await post(app, `/api/threads/${encodeURIComponent(tid(0))}/done`);
    expect(res.statusCode).toBe(200);
    expect(thread(db, 0)).toMatchObject({ in_inbox: 0, done_at: NOW });
  });
});

describe('item 10: an account that needs reconnecting', () => {
  const status = (db: DB) => db.prepare("SELECT status FROM accounts WHERE id = 'a'").pluck().get();

  it('R11 stops calling Gmail once the account needs reconnecting, and restores every thread', async () => {
    const { a, app, db, hook } = await setup(30);
    a.revoke();
    const before = gmailCalls(a);
    const seen = events();
    await bulk(app, { ids: ids(30), action: 'done' });
    await hook.idle();
    expect(status(db)).toBe('reconnect_needed');
    expect(gmailCalls(a) - before).toBeLessThanOrEqual(LABEL_CONCURRENCY);
    expect(settled(seen)[0]).toMatchObject({ affected: 0 });
    expect(settled(seen)[0]?.failed).toHaveLength(30);
    expect(await inboxIds(app)).toHaveLength(30);
    expect(journal(db)).toEqual([]);
  });

  it('fails every thread straight away, without asking for a client, when the account already needs reconnecting', async () => {
    const { app, db, deps, hook } = await setup(8);
    db.prepare("UPDATE accounts SET status = 'reconnect_needed' WHERE id = 'a'").run();
    const gmailFor = vi.fn(deps.gmailFor);
    deps.gmailFor = gmailFor;
    const seen = events();
    await bulk(app, { ids: ids(8), action: 'snooze', until: NOW + DAY });
    await hook.idle();
    expect(gmailFor).not.toHaveBeenCalled();
    expect(settled(seen)[0]?.failed).toHaveLength(8);
    expect(await inboxIds(app)).toHaveLength(8);
    expect(toSummary(db, tid(0)).snoozedUntil).toBeNull();
  });
});

describe('item 12: teachBulk', () => {
  it('yields to the event loop between senders', async () => {
    const senders = (g: FakeGmail) => {
      for (let i = 0; i < 20; i++) g.addThread({ id: `s-${i}`, messages: [{ from: `P${i} <p${i}@acme.example>`, subject: 'Hi', date: NOW - HOUR, labelIds: ['INBOX'] }] });
    };
    const { deps, hook } = await setup(1, senders);
    let turns = 0;
    let running = true;
    const tick = () => {
      turns++;
      if (running) setImmediate(tick);
    };
    setImmediate(tick);
    await teachBulk(deps, { ids: Array.from({ length: 20 }, (_, i) => `a:s-${i}`), action: 'important' });
    running = false;
    await hook.idle();
    expect(turns).toBeGreaterThanOrEqual(19);
  });
});
