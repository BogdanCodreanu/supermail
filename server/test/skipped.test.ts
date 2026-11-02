import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_HEADER, type ActionResult, type FilterDTO, type ThreadPage } from '@supermail/shared';
import type { AppConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db/index.js';
import { ALLOW_ALL, type AppDeps, buildApp } from '../src/http/app.js';
import { done, snooze } from '../src/actions/actions.js';
import { undo } from '../src/actions/undo.js';
import { skippedRoutes } from '../src/http/routes/skipped.js';
import { listHidingFilters, listSkipped, restore } from '../src/skipped/skipped.js';
import { createPoller } from '../src/sync/poller.js';
import { makeThreadHook } from '../src/threads/classifyThread.js';
import { listInbox, toSummary } from '../src/threads/queries.js';
import { createFakeGmail } from './fakes/fakeGmail.js';
import { DAY, FIXTURE_IDS, HOUR, inboxFixtures } from './fixtures/threads.js';

const NOW = Date.UTC(2026, 9, 29, 10, 0, 0);
const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

const AUTO_ARCHIVED = '[superhuman]/ai/autoarchived';
const SKIPPED = 'f-sh-archived';
const ID = `a:${SKIPPED}`;

async function setup() {
  const db: DB = openDb(':memory:');
  db.prepare("INSERT INTO accounts(id, email, color, status, created_at) VALUES ('a', 'me@gmail.com', '#2563eb', 'syncing', 1)").run();
  db.prepare("INSERT INTO accounts(id, email, color, status, created_at) VALUES ('b', 'work@gmail.com', '#16a34a', 'syncing', 2)").run();
  const clock = { now: NOW };
  const a = createFakeGmail('me@gmail.com', { now: () => clock.now });
  const b = createFakeGmail('work@gmail.com', { now: () => clock.now });
  for (const t of inboxFixtures(NOW)) a.addThread(t);
  // Superhuman's auto-archive took this security notice out of the inbox 3 days ago.
  a.addThread({ id: SKIPPED, messages: [{ from: 'tastytrade <security@tastytrade.com>', subject: 'Account safety notice', date: NOW - 3 * DAY, labelIds: [AUTO_ARCHIVED, 'CATEGORY_UPDATES'] }] });
  a.addThread({ id: 'f-old-archived', messages: [{ from: 'XTB <office@xtb.ro>', subject: 'Raport lunar', date: NOW - 40 * DAY, labelIds: [AUTO_ARCHIVED] }] });
  a.addThread({ id: 'f-sent', messages: [{ from: 'Me <me@gmail.com>', to: 'Ana <ana@friends.ro>', subject: 'Hi Ana', date: NOW - DAY, labelIds: ['SENT'] }] });
  b.addThread({ id: 'b-skipped', messages: [{ from: 'ING Bank <alerte@ing.ro>', subject: 'Alerta frauda', date: NOW - 2 * DAY, labelIds: ['CATEGORY_UPDATES'] }] });
  const gmailFor = vi.fn((accountId: string) => (accountId === 'a' ? a : b));
  const hook = makeThreadHook({ db, gmailFor, now: () => clock.now, log });
  const poller = createPoller({ db, gmailFor, intervalMs: 30_000, onChange: hook, log });
  await poller.tick();
  await hook.idle();
  const deps: AppDeps = { db, config: {} as AppConfig, gmailFor, now: () => clock.now, onThreadChange: hook, storage: ALLOW_ALL };
  return { db, a, b, clock, deps };
}

const ids = (p: ThreadPage) => p.threads.map((t) => t.id);

describe('moving a done thread back to the inbox', () => {
  it('restore adds INBOX and clears done_at; undo marks it done again with the original time', async () => {
    const { db, a, clock, deps } = await setup();
    const id = `a:${FIXTURE_IDS.github}`;
    await done(deps, id);
    clock.now += HOUR;

    const res = await restore(deps, id);
    expect(res.thread).toMatchObject({ inInbox: true, doneAt: null });
    expect(a.threadLabels(FIXTURE_IDS.github)).toContain('INBOX');
    expect(listInbox(db, {}).threads[0]?.id).toBe(id);

    const undone = await undo(deps, res.undoId);
    expect(undone.thread).toMatchObject({ inInbox: false, doneAt: NOW });
    expect(a.threadLabels(FIXTURE_IDS.github)).not.toContain('INBOX');
    expect(listSkipped(db, clock.now).threads.map((t) => t.id)).not.toContain(id);
    expect(db.prepare('SELECT surfaced_at FROM threads WHERE id = ?').pluck().get(id)).toBeNull();
  });
});

describe('listSkipped', () => {
  it('lists recent mail that skipped the inbox, newest first, and leaves out old, Done, snoozed and sent mail', async () => {
    const { db, deps } = await setup();
    await done(deps, `a:${FIXTURE_IDS.github}`);
    await snooze(deps, `a:${FIXTURE_IDS.vercel}`, NOW + HOUR);

    const page = listSkipped(db, NOW);
    expect(ids(page)).toEqual(['b:b-skipped', ID]);
    expect(page.nextCursor).toBeNull();
    expect(page.threads[1]).toMatchObject({ inInbox: false, subject: 'Account safety notice', fromEmail: 'security@tastytrade.com' });
    expect(ids(page)).not.toContain('a:f-old-archived'); // 40 days ago
    expect(ids(page)).not.toContain(`a:${FIXTURE_IDS.github}`); // Done in SuperMail
    expect(ids(page)).not.toContain(`a:${FIXTURE_IDS.vercel}`); // snoozed
    expect(ids(page)).not.toContain('a:f-sent'); // sent only
  });

  it('filters by account', async () => {
    const { db } = await setup();
    expect(ids(listSkipped(db, NOW, 'a'))).toEqual([ID]);
    expect(ids(listSkipped(db, NOW, 'b'))).toEqual(['b:b-skipped']);
  });
});

describe('restore', () => {
  it('puts INBOX back and surfaces the thread at the top; undo takes it out again', async () => {
    const { db, a, clock, deps } = await setup();
    clock.now = NOW + 1000;
    const res = await restore(deps, ID);
    expect(a.calls.modifyThread).toContainEqual([SKIPPED, ['INBOX'], []]);
    expect(a.threadLabels(SKIPPED)).toContain('INBOX');
    expect(res.thread).toMatchObject({ id: ID, inInbox: true, lastMessageAt: NOW - 3 * DAY });
    expect(ids(listSkipped(db, clock.now))).not.toContain(ID);
    expect(ids(listInbox(db, { limit: 1 }))).toEqual([ID]);

    const back = await undo(deps, res.undoId);
    expect(back.thread).toMatchObject({ id: ID, inInbox: false });
    expect(a.threadLabels(SKIPPED)).not.toContain('INBOX');
    expect(ids(listSkipped(db, clock.now))).toContain(ID);
    expect(toSummary(db, ID).inInbox).toBe(false);
  });

  it('refuses a thread that is already in the inbox and an unknown thread', async () => {
    const { deps } = await setup();
    await expect(restore(deps, `a:${FIXTURE_IDS.github}`)).rejects.toMatchObject({ statusCode: 400 });
    await expect(restore(deps, 'a:nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('listHidingFilters', () => {
  it('lists filters that skip the inbox, trash or mark read, and leaves out label-only filters', async () => {
    const { db, a, b, deps } = await setup();
    a.setFilters([
      { id: 'f1', criteria: { from: 'x@y' }, action: { removeLabelIds: ['INBOX'] } },
      { id: 'f2', criteria: { from: 'news@shop.ro' }, action: { addLabelIds: ['Label_7'] } },
      { id: 'f3', criteria: { from: 'promo@z.com', subject: 'Deals' }, action: { addLabelIds: ['TRASH'], removeLabelIds: ['UNREAD'] } },
    ]);
    b.setFilters([{ id: 'g1', criteria: { query: 'unsubscribe', hasAttachment: true }, action: { removeLabelIds: ['UNREAD', 'INBOX'] } }]);
    // An account that needs reconnecting is skipped rather than failing the list.
    db.prepare("INSERT INTO accounts(id, email, color, status, created_at) VALUES ('c', 'old@gmail.com', '#000000', 'reconnect_needed', 3)").run();

    const filters = await listHidingFilters(deps);
    expect(filters).toEqual<FilterDTO[]>([
      { accountId: 'a', filterId: 'f1', criteria: 'from:x@y', hides: ['skip_inbox'], gmailSettingsUrl: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#settings/filters' },
      { accountId: 'a', filterId: 'f3', criteria: 'from:promo@z.com subject:Deals', hides: ['trash', 'mark_read'], gmailSettingsUrl: 'https://mail.google.com/mail/u/?authuser=me@gmail.com#settings/filters' },
      { accountId: 'b', filterId: 'g1', criteria: 'unsubscribe has:attachment', hides: ['skip_inbox', 'mark_read'], gmailSettingsUrl: 'https://mail.google.com/mail/u/?authuser=work@gmail.com#settings/filters' },
    ]);
    expect(deps.gmailFor).not.toHaveBeenCalledWith('c');
  });
});

describe('skipped routes', () => {
  it('GET /api/skipped, POST /api/skipped/:id/restore and GET /api/filters', async () => {
    const { a, deps } = await setup();
    a.setFilters([{ id: 'f1', criteria: { from: 'x@y' }, action: { removeLabelIds: ['INBOX'] } }]);
    const app = await buildApp(deps, [skippedRoutes], { webDir: '/nonexistent' });
    apps.push(app);

    expect(ids((await app.inject('/api/skipped?accountId=a')).json() as ThreadPage)).toEqual([ID]);
    const res = await app.inject({ method: 'POST', url: `/api/skipped/${encodeURIComponent(ID)}/restore`, headers: { [API_HEADER]: '1' } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as ActionResult).thread).toMatchObject({ id: ID, inInbox: true });
    expect(ids((await app.inject('/api/skipped')).json() as ThreadPage)).toEqual(['b:b-skipped']);
    expect(((await app.inject('/api/filters')).json() as FilterDTO[]).map((f) => f.filterId)).toEqual(['f1']);
  });
});
