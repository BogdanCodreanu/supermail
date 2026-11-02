import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_HEADER, type GmailLabelDTO, type GroupDTO, type ThreadPage } from '@supermail/shared';
import type { AppConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db/index.js';
import { ALLOW_ALL, type AppDeps, buildApp } from '../src/http/app.js';
import { groupsRoutes } from '../src/http/routes/groups.js';
import { threadsRoutes } from '../src/http/routes/threads.js';
import { createPoller } from '../src/sync/poller.js';
import { makeThreadHook } from '../src/threads/classifyThread.js';
import { createFakeGmail, type FakeGmail } from './fakes/fakeGmail.js';
import { DAY, FIXTURE_IDS, HOUR, inboxFixtures } from './fixtures/threads.js';

const NOW = Date.UTC(2026, 9, 29, 10, 0, 0);
const LEGAL = 'Legal - Example Studio SRL';
const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function setup() {
  const db: DB = openDb(':memory:');
  db.prepare("INSERT INTO accounts(id, email, color, status, created_at) VALUES ('a', 'me@gmail.com', '#2563eb', 'syncing', 1)").run();
  db.prepare("INSERT INTO accounts(id, email, color, status, created_at) VALUES ('b', 'work@gmail.com', '#16a34a', 'syncing', 2)").run();
  const clock = { now: NOW };
  const a = createFakeGmail('me@gmail.com', { now: () => clock.now });
  const b = createFakeGmail('work@gmail.com', { now: () => clock.now });
  for (const t of inboxFixtures(NOW)) a.addThread(t);
  a.addThread({ id: 'f-legal', messages: [{ from: 'Avocat <office@lawfirm.ro>', subject: 'Contract draft', date: NOW - 10 * HOUR, labelIds: ['INBOX', LEGAL, 'CATEGORY_PERSONAL'] }] });
  b.addThread({ id: 'b-dev', messages: [{ from: 'GitHub <notifications@github.com>', subject: '[work/api] PR merged', date: NOW - HOUR, labelIds: ['INBOX', 'CATEGORY_UPDATES'] }] });
  b.addThread({ id: 'b-news', messages: [{ from: 'Weekly <hello@weekly.dev>', subject: 'This week', date: NOW - 2 * DAY, listUnsubscribe: '<https://weekly.dev/u>', labelIds: ['INBOX'] }] });
  const gmailFor = vi.fn((accountId: string): FakeGmail => (accountId === 'a' ? a : b));
  const hook = makeThreadHook({ db, gmailFor, now: () => clock.now, log });
  const poller = createPoller({ db, gmailFor, intervalMs: 30_000, onChange: hook, log });
  await poller.tick();
  await hook.idle();
  const deps: AppDeps = { db, config: {} as AppConfig, gmailFor, now: () => clock.now, onThreadChange: hook, storage: ALLOW_ALL };
  const app = await buildApp(deps, [threadsRoutes, groupsRoutes], { webDir: '/nonexistent' });
  apps.push(app);
  return { db, a, b, app, hook };
}

const post = (app: FastifyInstance, url: string, body: unknown) =>
  app.inject({ method: 'POST', url, headers: { [API_HEADER]: '1', 'content-type': 'application/json' }, payload: JSON.stringify(body) });

describe('groups routes', () => {
  it('POST /api/groups with an existing Gmail label uses it in place and routes its mail there', async () => {
    const { a, b, app } = await setup();
    const res = await post(app, '/api/groups', { existingLabelName: LEGAL });
    expect(res.statusCode).toBe(200);
    const group = res.json() as GroupDTO;
    expect(group).toMatchObject({ name: LEGAL, kind: 'existing_label', inboxCount: 1 });

    const page = (await app.inject(`/api/threads?groupId=${group.id}`)).json() as ThreadPage;
    expect(page.threads.map((t) => t.id)).toEqual(['a:f-legal']);
    expect(page.threads[0]?.reason).toMatchObject({ source: 'existing_label' });
    expect(a.calls.createLabel).not.toContain(LEGAL);
    expect(b.calls.createLabel).not.toContain(LEGAL); // nothing from b was routed there
    const legalLabels = (await a.listLabels()).filter((l) => l.name === LEGAL);
    expect(legalLabels).toHaveLength(1); // never renamed, never duplicated
    expect(a.threadLabels('f-legal')).toContain(legalLabels[0]?.id);
  });

  it('GET /api/groups lists the 7 built-in groups with counts; POST, PATCH and DELETE manage custom ones', async () => {
    const { app } = await setup();
    const groups = (await app.inject('/api/groups')).json() as GroupDTO[];
    expect(groups.map((g) => g.id)).toEqual(['important', 'money_security', 'dev', 'purchases', 'news', 'low_priority', 'unsorted']);
    expect(groups.find((g) => g.id === 'dev')?.inboxCount).toBe(3);

    const created = (await post(app, '/api/groups', { name: 'Clients', color: '#000000' })).json() as GroupDTO;
    expect(created).toMatchObject({ name: 'Clients', kind: 'custom', color: '#000000', position: 7 });
    expect((await post(app, '/api/groups', { name: 'Clients' })).statusCode).toBe(409);
    expect((await post(app, '/api/groups', {})).statusCode).toBe(400);

    const patched = await app.inject({ method: 'PATCH', url: `/api/groups/${created.id}`, headers: { [API_HEADER]: '1' }, payload: { name: 'Key clients', notify: false } });
    expect(patched.json()).toMatchObject({ name: 'Key clients', notify: false });

    const builtinDelete = await app.inject({ method: 'DELETE', url: '/api/groups/dev', headers: { [API_HEADER]: '1' } });
    expect(builtinDelete.statusCode).toBe(400);
    const del = await app.inject({ method: 'DELETE', url: `/api/groups/${created.id}`, headers: { [API_HEADER]: '1' } });
    expect(del.statusCode).toBe(200);
    expect(((await app.inject('/api/groups')).json() as GroupDTO[]).some((g) => g.id === created.id)).toBe(false);
  });

  it('deleting a custom group sends its threads back to classification', async () => {
    const { db, app } = await setup();
    const created = (await post(app, '/api/groups', { name: 'Clients' })).json() as GroupDTO;
    const moved = await post(app, `/api/threads/a:${FIXTURE_IDS.personal}/move`, { groupId: created.id });
    expect(moved.json().thread).toMatchObject({ groupId: created.id });
    await app.inject({ method: 'DELETE', url: `/api/groups/${created.id}`, headers: { [API_HEADER]: '1' } });
    expect(db.prepare('SELECT group_id FROM threads WHERE id = ?').pluck().get(`a:${FIXTURE_IDS.personal}`)).toBe('important');
  });

  it('GET /api/labels lists user labels across accounts, without SuperMail/*', async () => {
    const { a, b, app } = await setup();
    b.addLabel(LEGAL);
    a.addLabel('Receipts');
    const labels = (await app.inject('/api/labels')).json() as GmailLabelDTO[];
    expect(labels).toContainEqual({ name: LEGAL, accountIds: ['a', 'b'] });
    expect(labels).toContainEqual({ name: 'Receipts', accountIds: ['a'] });
    expect(labels.some((l) => l.name.startsWith('SuperMail/'))).toBe(false);
  });
});

describe('threads routes', () => {
  it('GET /api/threads?groupId=dev returns only Dev inbox threads, newest first', async () => {
    const { app } = await setup();
    const page = (await app.inject('/api/threads?groupId=dev')).json() as ThreadPage;
    expect(page.threads.map((t) => t.id)).toEqual(['b:b-dev', `a:${FIXTURE_IDS.github}`, `a:${FIXTURE_IDS.vercel}`]);
    expect(page.threads.every((t) => t.groupId === 'dev' && t.inInbox)).toBe(true);
  });

  it('GET /api/threads?includeDone=1 adds done threads; the default leaves them out', async () => {
    const { app } = await setup();
    const id = `a:${FIXTURE_IDS.github}`;
    expect((await post(app, `/api/threads/${encodeURIComponent(id)}/done`, {})).statusCode).toBe(200);

    const plain = (await app.inject('/api/threads?groupId=dev')).json() as ThreadPage;
    expect(plain.threads.map((t) => t.id)).not.toContain(id);

    const shown = (await app.inject('/api/threads?groupId=dev&includeDone=1')).json() as ThreadPage;
    expect(shown.threads.map((t) => t.id)).toEqual(['b:b-dev', id, `a:${FIXTURE_IDS.vercel}`]);
    expect(shown.threads.find((t) => t.id === id)).toMatchObject({ inInbox: false, doneAt: NOW });
  });

  it('filters by accountId', async () => {
    const { app } = await setup();
    const page = (await app.inject('/api/threads?groupId=dev&accountId=a')).json() as ThreadPage;
    expect(page.threads.map((t) => t.id)).toEqual([`a:${FIXTURE_IDS.github}`, `a:${FIXTURE_IDS.vercel}`]);
    const onlyB = (await app.inject('/api/threads?accountId=b')).json() as ThreadPage;
    expect(onlyB.threads.every((t) => t.accountId === 'b')).toBe(true);
    expect(onlyB.threads).toHaveLength(2);
  });

  it('paginates with limit=2 and a cursor, without duplicates', async () => {
    const { app } = await setup();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/api/threads?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = (await app.inject(url)).json() as ThreadPage;
      expect(page.threads.length).toBeLessThanOrEqual(2);
      seen.push(...page.threads.map((t) => t.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 20);
    expect(pages).toBeGreaterThan(1);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(11); // 9 from a, 2 from b
  });

  it('POST action routes return ActionResult and validate bodies', async () => {
    const { app, a } = await setup();
    const doneRes = await post(app, `/api/threads/a:${FIXTURE_IDS.github}/done`, {});
    expect(doneRes.statusCode).toBe(200);
    expect(doneRes.json()).toMatchObject({ undoId: expect.any(String), thread: { inInbox: false } });
    expect(a.threadLabels(FIXTURE_IDS.github)).not.toContain('INBOX');

    const undoRes = await post(app, `/api/undo/${doneRes.json().undoId}`, {});
    expect(undoRes.json()).toMatchObject({ thread: { inInbox: true } });

    expect((await post(app, `/api/threads/a:${FIXTURE_IDS.github}/snooze`, { until: 'tomorrow' })).statusCode).toBe(400);
    expect((await post(app, `/api/threads/a:${FIXTURE_IDS.github}/snooze`, { until: NOW - 1 })).statusCode).toBe(400);
    const snoozed = await post(app, `/api/threads/a:${FIXTURE_IDS.github}/snooze`, { until: NOW + DAY });
    expect(snoozed.json()).toMatchObject({ thread: { snoozedUntil: NOW + DAY } });
    expect((await post(app, `/api/threads/a:${FIXTURE_IDS.github}/unsnooze`, {})).json()).toMatchObject({ thread: { inInbox: true, snoozedUntil: null } });

    expect((await post(app, `/api/threads/a:${FIXTURE_IDS.github}/read`, { read: 'yes' })).statusCode).toBe(400);
    expect((await post(app, `/api/threads/a:${FIXTURE_IDS.github}/read`, { read: true })).json()).toMatchObject({ thread: { unread: false } });
    expect((await post(app, `/api/threads/a:${FIXTURE_IDS.github}/move`, {})).statusCode).toBe(400);
    expect((await post(app, '/api/threads/a:missing/done', {})).statusCode).toBe(404);

    const taught = await post(app, '/api/teach', { threadId: `a:${FIXTURE_IDS.github}`, action: 'always_group', scope: 'list', groupId: 'news' });
    expect(taught.json()).toMatchObject({ thread: { groupId: 'news', reason: { source: 'rule' } } });
    expect((await post(app, '/api/teach', { threadId: `a:${FIXTURE_IDS.github}`, action: 'nope', scope: 'sender' })).statusCode).toBe(400);
  });
});
