import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_HEADER, type ServerEvent, type TeachPreviewDTO } from '@supermail/shared';
import { moveToGroup, teach } from '../src/actions/actions.js';
import { undo } from '../src/actions/undo.js';
import type { AppConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db/index.js';
import { bus } from '../src/events.js';
import { ALLOW_ALL, type AppDeps, buildApp } from '../src/http/app.js';
import { rulesRoutes } from '../src/http/routes/rules.js';
import { threadsRoutes } from '../src/http/routes/threads.js';
import { createPoller } from '../src/sync/poller.js';
import { labelWritesIdle, makeThreadHook, reclassifyThreads } from '../src/threads/classifyThread.js';
import { toSummary } from '../src/threads/queries.js';
import { createFakeGmail, type FakeGmail } from './fakes/fakeGmail.js';
import { DAY, HOUR, inboxFixtures } from './fixtures/threads.js';

const NOW = Date.UTC(2026, 9, 29, 10, 0, 0);
const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
const tid = (gmailId: string) => `a:${gmailId}`;
const apps: FastifyInstance[] = [];
const unsubscribe: (() => void)[] = [];

afterEach(async () => {
  for (const off of unsubscribe.splice(0)) off();
  for (const app of apps.splice(0)) await app.close();
});

/** Three inbox threads and one archived one from the same sender, plus a neighbour at the same domain. */
const jordanThreads = (g: FakeGmail) => {
  for (const [id, hours] of [['al-1', 1], ['al-2', 2], ['al-3', 3]] as const) {
    g.addThread({ id, messages: [{ from: 'Jordan <jordan@acme.example>', subject: `Hello ${id}`, date: NOW - hours * HOUR, labelIds: ['INBOX', 'CATEGORY_PERSONAL'] }] });
  }
  g.addThread({ id: 'al-archived', messages: [{ from: 'Jordan <jordan@acme.example>', subject: 'Old news', date: NOW - 5 * DAY, labelIds: ['CATEGORY_PERSONAL'] }] });
  g.addThread({ id: 'bea-1', messages: [{ from: 'Bea <bea@acme.example>', subject: 'From Bea', date: NOW - 4 * HOUR, labelIds: ['INBOX', 'CATEGORY_PERSONAL'] }] });
  g.addThread({ id: 'friend', messages: [{ from: 'Ana <ana@gmail.com>', subject: 'Hi', date: NOW - 5 * HOUR, labelIds: ['INBOX', 'CATEGORY_PERSONAL'] }] });
  g.addThread({ id: 'list-1', messages: [{ from: 'Dev List <list@lists.example>', subject: 'Issue 1', date: NOW - 6 * HOUR, listId: 'Dev <dev.lists.example>', labelIds: ['INBOX'] }] });
  g.addThread({ id: 'list-2', messages: [{ from: 'Dev List <list@lists.example>', subject: 'Issue 2', date: NOW - 7 * HOUR, listId: 'Dev <dev.lists.example>', labelIds: ['INBOX'] }] });
};

async function setup(before?: (a: FakeGmail, db: DB) => void) {
  const db: DB = openDb(':memory:');
  db.prepare("INSERT INTO accounts(id, email, color, status, created_at) VALUES ('a', 'me@gmail.com', '#2563eb', 'syncing', 1)").run();
  const clock = { now: NOW };
  const a = createFakeGmail('me@gmail.com', { now: () => clock.now });
  for (const t of inboxFixtures(NOW)) a.addThread(t);
  jordanThreads(a);
  before?.(a, db);
  const gmailFor = () => a;
  const hook = makeThreadHook({ db, gmailFor, now: () => clock.now, log });
  const poller = createPoller({ db, gmailFor, intervalMs: 30_000, onChange: hook, log });
  await poller.tick();
  await hook.idle();
  const deps: AppDeps = { db, config: {} as AppConfig, gmailFor, now: () => clock.now, onThreadChange: hook, storage: ALLOW_ALL };
  return { db, a, clock, deps, hook };
}

/** Holds every modifyThread until released, so a test can look at the world while the writes are in flight. */
function holdWrites(a: FakeGmail) {
  const real = a.modifyThread.bind(a);
  const held: { id: string; add: string[]; remove: string[]; release(): Promise<void> }[] = [];
  a.modifyThread = (id, add, remove) =>
    new Promise<void>((resolve, reject) => {
      held.push({
        id, add, remove,
        release: async () => {
          await real(id, add, remove).then(resolve, reject);
          await new Promise((r) => setImmediate(r));
        },
      });
    });
  return held;
}

function events() {
  const seen: ServerEvent[] = [];
  unsubscribe.push(bus.subscribe((e) => seen.push(e)));
  return seen;
}

const nextTurn = () => new Promise((r) => setImmediate(r));
const updatedIds = (seen: ServerEvent[]) => seen.flatMap((e) => (e.type === 'thread.updated' ? [e.thread.id] : []));
const group = (db: DB, gmailId: string) => toSummary(db, tid(gmailId)).groupId;
const rulesOf = (db: DB) => db.prepare('SELECT match_type, match_value, group_id FROM rules').all();
const marksOf = (db: DB) => db.prepare('SELECT match_type, match_value, mark FROM sender_marks').all();
const overrideOf = (db: DB, gmailId: string) => db.prepare('SELECT group_id, source FROM overrides WHERE thread_id = ?').get(tid(gmailId));

describe('instant teaching', () => {
  it('teach resolves and publishes every thread while the Gmail writes are still pending', async () => {
    const { db, a, deps } = await setup();
    a.calls.modifyThread.length = 0;
    const held = holdWrites(a);
    const seen = events();

    const r = await teach(deps, { threadId: tid('al-1'), action: 'always_group', scope: 'sender', groupId: 'news' });
    await nextTurn();

    expect(r.thread?.groupId).toBe('news');
    expect([...new Set(updatedIds(seen))].sort()).toEqual(['al-1', 'al-2', 'al-3', 'al-archived'].map(tid).sort());
    expect(seen.some((e) => e.type === 'groups.updated')).toBe(true);
    expect(a.calls.modifyThread).toEqual([]);
    // Nothing has reached Gmail yet, and the index already has the new group.
    expect(group(db, 'al-2')).toBe('news');
    expect(group(db, 'al-archived')).toBe('news');

    for (const w of held.splice(0)) await w.release();
    await nextTurn();
    while (held.length) await held.shift()!.release();
    await labelWritesIdle(db);
    const news = a.labelId('SuperMail/News')!;
    for (const id of ['al-1', 'al-2', 'al-3']) expect(a.threadLabels(id)).toContain(news);
  });

  it('runs the background writes with the same concurrency limit', async () => {
    const { db, a, deps } = await setup((g) => {
      for (let i = 1; i <= 6; i++) g.addThread({ id: `extra-${i}`, messages: [{ from: 'Jordan <jordan@acme.example>', subject: 'x', date: NOW - HOUR, labelIds: ['INBOX', 'CATEGORY_PERSONAL'] }] });
    });
    const held = holdWrites(a);
    await teach(deps, { threadId: tid('al-1'), action: 'always_group', scope: 'sender', groupId: 'news' });
    await nextTurn();
    await nextTurn();
    expect(held).toHaveLength(5);
    while (held.length) await held.shift()!.release();
    await labelWritesIdle(db);
    expect(a.threadLabels('extra-6')).toContain(a.labelId('SuperMail/News'));
  });

  it('logs a failed background write and keeps the new group', async () => {
    const { db, a, deps } = await setup();
    const real = a.modifyThread.bind(a);
    a.modifyThread = (id, add, remove) => (id === 'al-2' ? Promise.reject(new Error('Gmail said no')) : real(id, add, remove));
    const failures = vi.fn();
    await reclassifyThreads(db, deps.gmailFor, [tid('al-2')], NOW, { labels: 'background', log: { error: failures, warn: vi.fn() } });
    await labelWritesIdle(db);
    expect(failures).not.toHaveBeenCalled(); // nothing changed yet, so nothing to write

    db.prepare("INSERT INTO rules(id, match_type, match_value, group_id, created_at) VALUES ('r', 'sender', 'jordan@acme.example', 'news', 1)").run();
    await reclassifyThreads(db, deps.gmailFor, [tid('al-2')], NOW, { labels: 'background', log: { error: failures, warn: vi.fn() } });
    await labelWritesIdle(db);
    expect(failures).toHaveBeenCalledTimes(1);
    expect(group(db, 'al-2')).toBe('news');
  });

  it('a later teach wins over a write already on its way to Gmail', async () => {
    const { db, a, deps } = await setup();
    const held = holdWrites(a);
    await teach(deps, { threadId: tid('al-1'), action: 'always_group', scope: 'sender', groupId: 'news' });
    await nextTurn();
    const inFlight = held.find((w) => w.id === 'al-1')!;
    expect(inFlight).toBeDefined();

    await teach(deps, { threadId: tid('al-1'), action: 'always_group', scope: 'sender', groupId: 'dev' });
    await nextTurn();

    while (held.length) await held.shift()!.release();
    await labelWritesIdle(db);
    while (held.length) await held.shift()!.release();
    await labelWritesIdle(db);

    expect(group(db, 'al-1')).toBe('dev');
    expect(a.threadLabels('al-1')).toContain(a.labelId('SuperMail/Dev'));
    expect(a.threadLabels('al-1')).not.toContain(a.labelId('SuperMail/News'));
  });

  it('an undo wins over the write of the teaching it undoes', async () => {
    const { db, a, deps } = await setup();
    const before = group(db, 'al-1');
    const held = holdWrites(a);
    const r = await teach(deps, { threadId: tid('al-1'), action: 'always_group', scope: 'sender', groupId: 'news' });
    await nextTurn();
    await undo(deps, r.undoId);
    await nextTurn();

    while (held.length) await held.shift()!.release();
    await labelWritesIdle(db);
    while (held.length) await held.shift()!.release();
    await labelWritesIdle(db);

    expect(group(db, 'al-1')).toBe(before);
    expect(a.threadLabels('al-1')).not.toContain(a.labelId('SuperMail/News'));
    expect(a.threadLabels('al-1')).toContain(a.labelId(`SuperMail/${toSummary(db, tid('al-1')).groupName}`));
  });

  it('deleting a rule answers before Gmail does', async () => {
    const { db, a, deps } = await setup();
    await teach(deps, { threadId: tid('al-1'), action: 'always_group', scope: 'sender', groupId: 'news' });
    await labelWritesIdle(db);
    const app = await buildApp(deps, [rulesRoutes], { webDir: '/nonexistent' });
    apps.push(app);
    const held = holdWrites(a);
    const rule = db.prepare('SELECT id FROM rules').pluck().get() as string;

    const res = await app.inject({ method: 'DELETE', url: `/api/teaching/rule/${rule}`, headers: { [API_HEADER]: '1' } });

    expect(res.statusCode).toBe(200);
    expect(group(db, 'al-1')).not.toBe('news');
    while (held.length) await held.shift()!.release();
    await labelWritesIdle(db);
    while (held.length) await held.shift()!.release();
    await labelWritesIdle(db);
    expect(a.threadLabels('al-1')).not.toContain(a.labelId('SuperMail/News'));
  });

  it('reports how many threads changed group', async () => {
    const { db, deps } = await setup();
    const r = await teach(deps, { threadId: tid('al-1'), action: 'always_group', scope: 'sender', groupId: 'news' });
    expect(r.affected).toBe(3); // the three in the inbox, not the archived one: it matches the prompt's count
    const again = await teach(deps, { threadId: tid('al-1'), action: 'always_group', scope: 'sender', groupId: 'news' });
    expect(again.affected).toBe(0);
    const moved = await moveToGroup(deps, tid('bea-1'), 'dev');
    expect(moved.affected).toBe(1);
    await labelWritesIdle(db);
  });

  it('never relabels archived mail in the background either', async () => {
    const { db, a, deps } = await setup();
    const labels = a.threadLabels('al-archived');
    await teach(deps, { threadId: tid('al-1'), action: 'always_group', scope: 'sender', groupId: 'news' });
    await labelWritesIdle(db);
    expect(a.calls.modifyThread.filter(([id]) => id === 'al-archived')).toEqual([]);
    expect(a.threadLabels('al-archived')).toEqual(labels);
  });
});

describe('the label queue', () => {
  it('does not wait on itself when a queued write adopts an existing label on the same thread', async () => {
    const { db } = await setup((g, database) => {
      database.prepare("INSERT INTO groups(id, name, position, color, notify, kind, existing_label_name) VALUES ('legal', 'Legal', 50, '#000000', 1, 'existing_label', 'Legal')").run();
      g.addThread({ id: 'contract', messages: [{ from: 'Avocat <office@law.example>', subject: 'Contract', date: NOW, labelIds: ['INBOX', g.addLabel('Legal'), 'CATEGORY_PERSONAL'] }] });
    });
    expect(group(db, 'contract')).toBe('legal');
  }, 2_000);

  it('idle waits for a whole background batch, not just the writes running now', async () => {
    const { db, a, deps } = await setup((g) => {
      for (let i = 1; i <= 12; i++) g.addThread({ id: `many-${i}`, messages: [{ from: 'Jordan <jordan@acme.example>', subject: 'x', date: NOW - HOUR, labelIds: ['INBOX', 'CATEGORY_PERSONAL'] }] });
    });
    await teach(deps, { threadId: tid('al-1'), action: 'always_group', scope: 'sender', groupId: 'news' });
    await labelWritesIdle(db);
    const news = a.labelId('SuperMail/News')!;
    for (let i = 1; i <= 12; i++) expect(a.threadLabels(`many-${i}`)).toContain(news);
  });
});

describe('latest teaching wins', () => {
  it('a mark removes the rule on the same sender, and undo puts the rule back', async () => {
    const { db, deps } = await setup();
    await teach(deps, { threadId: tid('al-1'), action: 'always_group', scope: 'sender', groupId: 'news' });
    expect(group(db, 'al-2')).toBe('news');

    const r = await teach(deps, { threadId: tid('al-1'), action: 'not_important', scope: 'sender' });
    expect(rulesOf(db)).toEqual([]);
    expect(marksOf(db)).toEqual([{ match_type: 'sender', match_value: 'jordan@acme.example', mark: 'not_important' }]);
    expect(group(db, 'al-2')).toBe('low_priority');

    await undo(deps, r.undoId);
    expect(rulesOf(db)).toEqual([{ match_type: 'sender', match_value: 'jordan@acme.example', group_id: 'news' }]);
    expect(marksOf(db)).toEqual([]);
    expect(group(db, 'al-2')).toBe('news');
    await labelWritesIdle(db);
  });

  it('a rule removes the mark on the same domain, and undo puts the mark back', async () => {
    const { db, deps } = await setup();
    await teach(deps, { threadId: tid('al-1'), action: 'important', scope: 'domain' });
    expect(marksOf(db)).toHaveLength(1);

    const r = await teach(deps, { threadId: tid('al-1'), action: 'always_group', scope: 'domain', groupId: 'dev' });
    expect(marksOf(db)).toEqual([]);
    expect(group(db, 'bea-1')).toBe('dev');

    await undo(deps, r.undoId);
    expect(rulesOf(db)).toEqual([]);
    expect(marksOf(db)).toEqual([{ match_type: 'domain', match_value: 'acme.example', mark: 'important' }]);
    expect(group(db, 'bea-1')).toBe('important');
    await labelWritesIdle(db);
  });

  it('keeps teaching on a different match', async () => {
    const { db, deps } = await setup();
    await teach(deps, { threadId: tid('al-1'), action: 'important', scope: 'domain' });
    await teach(deps, { threadId: tid('al-1'), action: 'always_group', scope: 'sender', groupId: 'dev' });
    expect(marksOf(db)).toHaveLength(1);
    expect(rulesOf(db)).toHaveLength(1);
    await labelWritesIdle(db);
  });

  it('clears one-off overrides on every matching thread, and undo restores them', async () => {
    const { db, deps } = await setup();
    await moveToGroup(deps, tid('al-2'), 'dev');
    await moveToGroup(deps, tid('al-3'), 'purchases');
    db.prepare("UPDATE overrides SET source = 'gmail', suggest_rule = 1 WHERE thread_id = ?").run(tid('al-3'));
    await moveToGroup(deps, tid('bea-1'), 'news'); // another sender: not touched

    const r = await teach(deps, { threadId: tid('al-1'), action: 'always_group', scope: 'sender', groupId: 'money_security' });
    expect(group(db, 'al-2')).toBe('money_security');
    expect(group(db, 'al-3')).toBe('money_security');
    expect(overrideOf(db, 'al-2')).toBeUndefined();
    expect(overrideOf(db, 'al-3')).toBeUndefined();
    expect(overrideOf(db, 'bea-1')).toEqual({ group_id: 'news', source: 'app' });

    await undo(deps, r.undoId);
    expect(overrideOf(db, 'al-2')).toEqual({ group_id: 'dev', source: 'app' });
    expect(overrideOf(db, 'al-3')).toEqual({ group_id: 'purchases', source: 'gmail' });
    expect(toSummary(db, tid('al-3')).suggestRule).toBe(true);
    expect(group(db, 'al-2')).toBe('dev');
    expect(group(db, 'al-3')).toBe('purchases');
    await labelWritesIdle(db);
  });

  it('undoing the undo teaches again', async () => {
    const { db, deps } = await setup();
    await moveToGroup(deps, tid('al-2'), 'dev');
    await teach(deps, { threadId: tid('al-1'), action: 'important', scope: 'sender' });
    const taught = await teach(deps, { threadId: tid('al-1'), action: 'always_group', scope: 'sender', groupId: 'news' });
    const undone = await undo(deps, taught.undoId);
    expect(marksOf(db)).toHaveLength(1);

    await undo(deps, undone.undoId);
    expect(rulesOf(db)).toEqual([{ match_type: 'sender', match_value: 'jordan@acme.example', group_id: 'news' }]);
    expect(marksOf(db)).toEqual([]);
    expect(overrideOf(db, 'al-2')).toBeUndefined();
    expect(group(db, 'al-2')).toBe('news');
    await labelWritesIdle(db);
  });

  it('undo survives a group or a thread that went away in the meantime', async () => {
    const { db, deps } = await setup();
    db.prepare("INSERT INTO groups(id, name, position, color, notify, kind) VALUES ('temp', 'Temp', 99, '#000000', 1, 'custom')").run();
    await teach(deps, { threadId: tid('al-1'), action: 'always_group', scope: 'sender', groupId: 'temp' });
    await moveToGroup(deps, tid('al-3'), 'temp');
    await moveToGroup(deps, tid('al-2'), 'dev');
    const r = await teach(deps, { threadId: tid('al-1'), action: 'important', scope: 'sender' });

    db.prepare("DELETE FROM groups WHERE id = 'temp'").run();
    db.prepare('DELETE FROM threads WHERE id = ?').run(tid('al-2'));

    const u = await undo(deps, r.undoId);
    expect(u.thread?.id).toBe(tid('al-1'));
    expect(rulesOf(db)).toEqual([]);
    expect(overrideOf(db, 'al-3')).toBeUndefined();
    await labelWritesIdle(db);
  });
});

describe('GET /api/teach/preview', () => {
  async function previewApp() {
    const s = await setup();
    const app = await buildApp(s.deps, [threadsRoutes], { webDir: '/nonexistent' });
    apps.push(app);
    const preview = async (gmailId: string) => (await app.inject(`/api/teach/preview?threadId=${encodeURIComponent(tid(gmailId))}`)).json() as TeachPreviewDTO;
    return { ...s, app, preview };
  }

  it('counts inbox and snoozed threads per scope, and leaves archived mail out', async () => {
    const { db, preview } = await previewApp();
    db.prepare('INSERT INTO snoozes(thread_id, until, created_at) VALUES (?, ?, ?)').run(tid('al-archived'), NOW + DAY, NOW);
    expect(await preview('al-1')).toEqual({
      subject: 'Hello al-1',
      senderName: 'Jordan',
      sender: { value: 'jordan@acme.example', count: 4 },
      domain: { value: 'acme.example', count: 5 },
      list: null,
    });
  });

  it('offers the mailing list when the email has one', async () => {
    const { preview } = await previewApp();
    expect((await preview('list-1')).list).toEqual({ value: 'dev.lists.example', count: 2 });
  });

  it.each(['gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'proton.me', 'protonmail.com'])('has no domain for %s', async (domain) => {
    const s = await setup((g) => g.addThread({ id: 'free', messages: [{ from: `Someone <someone@${domain}>`, subject: 'Hi', date: NOW - HOUR, labelIds: ['INBOX'] }] }));
    const app = await buildApp(s.deps, [threadsRoutes], { webDir: '/nonexistent' });
    apps.push(app);
    const res = (await app.inject(`/api/teach/preview?threadId=${encodeURIComponent(tid('free'))}`)).json() as TeachPreviewDTO;
    expect(res.sender).toEqual({ value: `someone@${domain}`, count: 1 });
    expect(res.domain).toBeNull();
  });

  it('is 400 without a thread and 404 for an unknown one', async () => {
    const { app } = await previewApp();
    expect((await app.inject('/api/teach/preview')).statusCode).toBe(400);
    expect((await app.inject('/api/teach/preview?threadId=nope')).statusCode).toBe(404);
  });
});

describe('thread summaries', () => {
  it('carry the mailing list, so the client can move a whole list at once', async () => {
    const { db } = await setup();
    expect(toSummary(db, tid('list-1')).listId).toBe('dev.lists.example');
    expect(toSummary(db, tid('al-1')).listId).toBeNull();
  });
});
