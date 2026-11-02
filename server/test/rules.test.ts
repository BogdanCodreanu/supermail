import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_HEADER, type TeachingDTO } from '@supermail/shared';
import { snooze, teach } from '../src/actions/actions.js';
import { requireSession } from '../src/auth/sessions.js';
import type { AppConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db/index.js';
import { ALLOW_ALL, type AppDeps, buildApp, type RoutePlugin } from '../src/http/app.js';
import { rulesRoutes } from '../src/http/routes/rules.js';
import { createPoller } from '../src/sync/poller.js';
import { labelWritesIdle, makeThreadHook } from '../src/threads/classifyThread.js';
import { toSummary } from '../src/threads/queries.js';
import { createFakeGmail } from './fakes/fakeGmail.js';
import { allFixtures, DAY, FIXTURE_IDS } from './fixtures/threads.js';

const NOW = Date.UTC(2026, 9, 29, 10, 0, 0);
const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function setup() {
  const db: DB = openDb(':memory:');
  db.prepare("INSERT INTO accounts(id, email, color, status, created_at) VALUES ('a', 'me@gmail.com', '#2563eb', 'syncing', 1)").run();
  const clock = { now: NOW };
  const a = createFakeGmail('me@gmail.com', { now: () => clock.now });
  for (const t of allFixtures(NOW)) a.addThread(t);
  const gmailFor = () => a;
  const hook = makeThreadHook({ db, gmailFor, now: () => clock.now, log });
  const poller = createPoller({ db, gmailFor, intervalMs: 30_000, onChange: hook, log });
  await poller.tick();
  await hook.idle();
  const deps: AppDeps = { db, config: {} as AppConfig, gmailFor, now: () => clock.now, onThreadChange: hook, storage: ALLOW_ALL };
  const app = await buildApp(deps, [rulesRoutes], { webDir: '/nonexistent' });
  apps.push(app);
  return { db, a, clock, deps, app };
}

const tid = (gmailId: string) => `a:${gmailId}`;
const list = async (app: FastifyInstance) => (await app.inject('/api/teaching')).json() as TeachingDTO[];
const remove = (app: FastifyInstance, kind: string, id: string) => app.inject({ method: 'DELETE', url: `/api/teaching/${kind}/${id}`, headers: { [API_HEADER]: '1' } });
/** Removing one answers first, then writes Gmail. */
const removeAndWrite = async (app: FastifyInstance, db: DB, kind: string, id: string) => {
  const res = await remove(app, kind, id);
  await labelWritesIdle(db);
  return res;
};
const groupOf = (db: DB, gmailId: string) => toSummary(db, tid(gmailId))!.groupId;

describe('GET /api/teaching', () => {
  it('lists rules and marks together, newest first, in the contract shape', async () => {
    const { app, clock, deps } = await setup();
    await teach(deps, { threadId: tid(FIXTURE_IDS.github), action: 'always_group', scope: 'sender', groupId: 'news' });
    clock.now += 1_000;
    await teach(deps, { threadId: tid(FIXTURE_IDS.alibaba), action: 'not_important', scope: 'domain' });

    expect(await list(app)).toEqual([
      {
        id: expect.any(String), kind: 'mark', matchType: 'domain', matchValue: 'notice.alibaba.com',
        groupId: null, groupName: null, mark: 'not_important', createdAt: NOW + 1_000, threadCount: 1,
      },
      {
        id: expect.any(String), kind: 'rule', matchType: 'sender', matchValue: 'notifications@github.com',
        groupId: 'news', groupName: 'News', mark: null, createdAt: NOW, threadCount: 1,
      },
    ]);
  });

  it('counts inbox and snoozed threads but not archived ones', async () => {
    const { app, deps } = await setup();
    await teach(deps, { threadId: tid(FIXTURE_IDS.vercel), action: 'always_group', scope: 'sender', groupId: 'news' });
    await snooze(deps, tid(FIXTURE_IDS.vercel), NOW + DAY);
    await teach(deps, { threadId: tid(FIXTURE_IDS.archivedRecent), action: 'important', scope: 'sender' });

    const rows = await list(app);
    expect(rows.find((r) => r.matchValue === 'notifications@vercel.com')?.threadCount).toBe(1);
    expect(rows.find((r) => r.matchValue === 'alerte@ing.ro')?.threadCount).toBe(0);
  });

  it('is an empty list before anything is taught', async () => {
    const { app } = await setup();
    expect(await list(app)).toEqual([]);
  });
});

describe('DELETE /api/teaching/:kind/:id', () => {
  it('removing a rule puts an inbox thread back in its automatic group and relabels it in Gmail', async () => {
    const { a, app, db, deps } = await setup();
    const id = FIXTURE_IDS.github;
    expect(groupOf(db, id)).toBe('dev');
    await teach(deps, { threadId: tid(id), action: 'always_group', scope: 'sender', groupId: 'news' });
    await labelWritesIdle(db);
    expect(a.threadLabels(id)).toContain(a.labelId('SuperMail/News'));

    const [rule] = await list(app);
    expect((await removeAndWrite(app, db, 'rule', rule!.id)).statusCode).toBe(200);

    expect(await list(app)).toEqual([]);
    expect(toSummary(db, tid(id))).toMatchObject({ groupId: 'dev', reason: { source: 'heuristic' } });
    expect(a.threadLabels(id)).toContain(a.labelId('SuperMail/Dev'));
    expect(a.threadLabels(id)).not.toContain(a.labelId('SuperMail/News'));
  });

  it('removing a mark does the same', async () => {
    const { a, app, db, deps } = await setup();
    const id = FIXTURE_IDS.github;
    await teach(deps, { threadId: tid(id), action: 'important', scope: 'list' });
    await labelWritesIdle(db);
    expect(groupOf(db, id)).toBe('important');

    const [mark] = await list(app);
    expect(mark).toMatchObject({ kind: 'mark', matchType: 'list', matchValue: 'super-mail.owner.github.com' });
    expect((await removeAndWrite(app, db, 'mark', mark!.id)).statusCode).toBe(200);

    expect(groupOf(db, id)).toBe('dev');
    expect(a.threadLabels(id)).not.toContain(a.labelId('SuperMail/Important'));
  });

  it('falls back to the next teaching before the automatic guess', async () => {
    const { app, db, deps } = await setup();
    const id = FIXTURE_IDS.alibaba;
    await teach(deps, { threadId: tid(id), action: 'important', scope: 'domain' });
    await labelWritesIdle(db);
    await teach(deps, { threadId: tid(id), action: 'always_group', scope: 'sender', groupId: 'news' });
    await labelWritesIdle(db);
    expect(groupOf(db, id)).toBe('news');

    const rule = (await list(app)).find((r) => r.kind === 'rule')!;
    await removeAndWrite(app, db, 'rule', rule.id);

    expect(toSummary(db, tid(id))).toMatchObject({ groupId: 'important', reason: { source: 'mark' } });
  });

  it('relabels a snoozed thread too', async () => {
    const { a, app, db, deps } = await setup();
    const id = FIXTURE_IDS.vercel;
    await teach(deps, { threadId: tid(id), action: 'always_group', scope: 'sender', groupId: 'news' });
    await labelWritesIdle(db);
    await snooze(deps, tid(id), NOW + DAY);

    const [rule] = await list(app);
    await removeAndWrite(app, db, 'rule', rule!.id);

    expect(groupOf(db, id)).toBe('dev');
    expect(a.threadLabels(id)).toContain(a.labelId('SuperMail/Dev'));
    expect(a.threadLabels(id)).not.toContain(a.labelId('SuperMail/News'));
  });

  it('never touches an archived thread: no regrouping and no Gmail writes', async () => {
    const { a, app, db, deps } = await setup();
    const id = FIXTURE_IDS.archivedRecent;
    await teach(deps, { threadId: tid(id), action: 'always_group', scope: 'sender', groupId: 'news' });
    await labelWritesIdle(db);
    const before = toSummary(db, tid(id));
    expect(before).toMatchObject({ groupId: 'news', inInbox: false });
    a.calls.modifyThread.length = 0;

    const [rule] = await list(app);
    expect((await removeAndWrite(app, db, 'rule', rule!.id)).statusCode).toBe(200);

    expect(toSummary(db, tid(id))).toEqual(before);
    expect(a.calls.modifyThread).toEqual([]);
  });

  it('keeps a thread the owner moved by hand where they put it', async () => {
    const { app, db, deps } = await setup();
    const id = FIXTURE_IDS.github;
    await teach(deps, { threadId: tid(id), action: 'always_group', scope: 'sender', groupId: 'news' });
    await labelWritesIdle(db);
    db.prepare("INSERT INTO overrides(thread_id, group_id, source, created_at) VALUES (?, 'purchases', 'app', ?)").run(tid(id), NOW);

    const [rule] = await list(app);
    await removeAndWrite(app, db, 'rule', rule!.id);

    expect(toSummary(db, tid(id))).toMatchObject({ groupId: 'purchases', reason: { source: 'override' } });
  });

  it('keeps the removal when a Gmail write fails', async () => {
    const { a, app, db, deps } = await setup();
    const id = FIXTURE_IDS.github;
    await teach(deps, { threadId: tid(id), action: 'always_group', scope: 'sender', groupId: 'news' });
    await labelWritesIdle(db);
    const [rule] = await list(app);
    const spy = vi.spyOn(a, 'modifyThread').mockRejectedValueOnce(new Error('Gmail is down'));

    expect((await removeAndWrite(app, db, 'rule', rule!.id)).statusCode).toBe(200);

    spy.mockRestore();
    expect(await list(app)).toEqual([]);
    expect(groupOf(db, id)).toBe('dev');
  });

  it('is 404 for an unknown id, an unknown kind, and an id of the other kind', async () => {
    const { app, db, deps } = await setup();
    await teach(deps, { threadId: tid(FIXTURE_IDS.github), action: 'important', scope: 'sender' });
    await labelWritesIdle(db);
    const [mark] = await list(app);

    expect((await removeAndWrite(app, db, 'rule', 'nope')).statusCode).toBe(404);
    expect((await removeAndWrite(app, db, 'mark', 'nope')).statusCode).toBe(404);
    expect((await removeAndWrite(app, db, 'constructor', mark!.id)).statusCode).toBe(404);
    expect((await removeAndWrite(app, db, 'rule', mark!.id)).statusCode).toBe(404);
    expect(await list(app)).toHaveLength(1);
  });

  it('needs the x-supermail header', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'DELETE', url: '/api/teaching/rule/x' })).statusCode).toBe(403);
  });
});

describe('session guard', () => {
  it('refuses both routes without a session', async () => {
    const db: DB = openDb(':memory:');
    const deps: AppDeps = {
      db, config: {} as AppConfig, gmailFor: () => { throw new Error('no gmail in this test'); },
      now: () => NOW, onThreadChange: () => {}, storage: ALLOW_ALL,
    };
    // Mirrors main.ts: the session guard first, then the route plugins.
    const guard: RoutePlugin = async (a, d) => {
      a.addHook('preHandler', requireSession(d.db, d.config, d.now));
    };
    const app = await buildApp(deps, [guard, rulesRoutes], { webDir: '/nonexistent' });
    apps.push(app);

    expect((await app.inject('/api/teaching')).statusCode).toBe(401);
    expect((await remove(app, 'rule', 'x')).statusCode).toBe(401);
  });
});
