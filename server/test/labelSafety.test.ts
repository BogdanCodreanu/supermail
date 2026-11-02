import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db/index.js';
import { ALLOW_ALL, type AppDeps } from '../src/http/app.js';
import { done, snooze, teach } from '../src/actions/actions.js';
import { lastWriteOf, SNOOZED_LABEL } from '../src/labels/labelWriter.js';
import { createSnoozeScheduler } from '../src/scheduler/snoozeScheduler.js';
import { indexThread, ownEmailsOf } from '../src/sync/indexer.js';
import { createPoller } from '../src/sync/poller.js';
import { makeThreadHook, type ThreadChangeHook } from '../src/threads/classifyThread.js';
import { toSummary } from '../src/threads/queries.js';
import { createFakeGmail, type FakeGmail } from './fakes/fakeGmail.js';
import { DAY, FIXTURE_IDS, HOUR, inboxFixtures } from './fixtures/threads.js';

const NOW = Date.UTC(2026, 9, 29, 10, 0, 0);
const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

interface SetupOptions { archived?: number; canIndexMore?: () => boolean }

async function setup(opts: SetupOptions = {}) {
  const db: DB = openDb(':memory:');
  db.prepare("INSERT INTO accounts(id, email, color, status, created_at) VALUES ('a', 'me@gmail.com', '#2563eb', 'syncing', 1)").run();
  const clock = { now: NOW };
  const a = createFakeGmail('me@gmail.com', { now: () => clock.now });
  for (const t of inboxFixtures(NOW)) a.addThread(t);
  for (let i = 0; i < (opts.archived ?? 0); i++) {
    a.addThread({ id: `old-${i}`, messages: [{ from: `Shop ${i} <news@shop${i}.example>`, subject: `Old receipt ${i}`, date: NOW - 200 * DAY - i * HOUR, labelIds: ['CATEGORY_UPDATES'] }] });
  }
  const gmailFor = () => a;
  const inner = makeThreadHook({ db, gmailFor, now: () => clock.now, log });
  const reasons = new Map<string, 'new' | 'changed'>();
  const hook: ThreadChangeHook = Object.assign((threadId: string, reason: 'new' | 'changed') => {
    reasons.set(threadId, reason);
    inner(threadId, reason);
  }, { idle: () => inner.idle() });
  const poller = createPoller({ db, gmailFor, intervalMs: 30_000, onChange: hook, log, canIndexMore: opts.canIndexMore });
  const deps: AppDeps = { db, config: {} as AppConfig, gmailFor, now: () => clock.now, onThreadChange: hook, storage: ALLOW_ALL };
  const tick = async () => {
    await poller.tick();
    await hook.idle();
  };
  await tick();
  const scheduler = createSnoozeScheduler(deps, 60_000);
  stops.push(() => scheduler.stop());
  return { db, a, clock, deps, hook, reasons, tick, scheduler };
}

const callsFor = (a: FakeGmail, gmailThreadId: string) => a.calls.modifyThread.filter(([t]) => t === gmailThreadId);
const snoozeRows = (db: DB, id: string) => db.prepare('SELECT count(*) FROM snoozes WHERE thread_id = ?').pluck().get(id) as number;
const overrideOf = (db: DB, id: string) => db.prepare('SELECT group_id, source FROM overrides WHERE thread_id = ?').get(id);

describe('archived history touched in Gmail (CONFIRMED #1)', () => {
  it('the owner relabels and marks read 1000 archived threads that are not in the index: zero label writes', async () => {
    // Backfill is not done (storage full, or still running), so the old threads are not indexed.
    const { db, a, clock, reasons, tick } = await setup({ archived: 1000, canIndexMore: () => false });
    expect(db.prepare("SELECT count(*) FROM threads WHERE id LIKE 'a:old-%'").pluck().get()).toBe(0);
    const writesBefore = a.calls.modifyThread.length;

    clock.now = NOW + 10 * 60_000;
    a.addLabel('Receipts');
    for (let i = 0; i < 1000; i++) a.setLabels(`old-${i}`, ['Receipts'], ['UNREAD', 'INBOX']); // bulk action in the Gmail app
    // Genuinely new mail that a filter keeps out of the inbox still counts as new.
    a.deliver('new-1', { from: 'GitHub <notifications@github.com>', subject: '[owner/super-mail] Deploy failed', listId: 'owner/super-mail <super-mail.owner.github.com>', labelIds: ['UNREAD', 'CATEGORY_UPDATES'] });
    await tick();

    expect(a.calls.modifyThread.slice(writesBefore).filter(([t]) => t.startsWith('old-'))).toEqual([]);
    expect([...reasons].filter(([id, r]) => id.startsWith('a:old-') && r === 'new')).toEqual([]);
    expect(reasons.get('a:old-0')).toBe('changed');
    expect(reasons.get('a:new-1')).toBe('new');
    expect(a.calls.modifyThread.slice(writesBefore).map(([t]) => t)).toEqual(['new-1']);
  }, 30_000); // 1000 threads through the poller: slow on a busy machine, not a hang

  it('opening an old archived thread that is not indexed writes no labels', async () => {
    const { db, a, hook } = await setup({ archived: 3, canIndexMore: () => false });
    const writesBefore = a.calls.modifyThread.length;
    const full = await a.getThread('old-1', 'full');
    indexThread(db, 'a', full, ownEmailsOf(db), hook, 'live');
    await hook.idle();
    expect(a.calls.modifyThread.length).toBe(writesBefore);
  });
});

describe('Gmail-side group moves stay put (CONFIRMED #3)', () => {
  const id = `a:${FIXTURE_IDS.courseNewsletter}`;

  it('removing a SuperMail label the owner added in Gmail does not get it re-added', async () => {
    const { db, a, clock, tick } = await setup();
    expect(toSummary(db, id).groupId).toBe('news');
    const dev = a.labelId('SuperMail/Dev')!;

    clock.now = NOW + 10 * 60_000;
    a.setLabels(FIXTURE_IDS.courseNewsletter, [dev], []); // the owner adds SuperMail/Dev, leaving News on
    await tick();
    expect(overrideOf(db, id)).toEqual({ group_id: 'dev', source: 'gmail' });
    expect(lastWriteOf(db, 'a', FIXTURE_IDS.courseNewsletter, dev)).toBe('added');

    clock.now += 10 * 60_000;
    a.setLabels(FIXTURE_IDS.courseNewsletter, [], [dev]); // ...and later takes it off again
    const before = callsFor(a, FIXTURE_IDS.courseNewsletter).length;
    await tick();
    expect(callsFor(a, FIXTURE_IDS.courseNewsletter)).toHaveLength(before);
    expect(a.threadLabels(FIXTURE_IDS.courseNewsletter)).not.toContain(dev);
  });
});

describe('snoozes (PLAUSIBLE b, d)', () => {
  const id = `a:${FIXTURE_IDS.github}`;

  it('a stale fetch from before the snooze, landing after it, keeps the snooze', async () => {
    const { db, a, clock, deps, hook, tick, scheduler } = await setup();
    const stale = await a.getThread(FIXTURE_IDS.github, 'metadata'); // the poller's fetch starts...
    await snooze(deps, id, NOW + HOUR); // ...the owner snoozes...
    indexThread(db, 'a', stale, ownEmailsOf(db), hook, 'live'); // ...and the fetch lands, still showing INBOX
    await hook.idle();
    expect(snoozeRows(db, id)).toBe(1);

    await tick(); // the next poll sees the real state
    expect(snoozeRows(db, id)).toBe(1);
    expect(toSummary(db, id).inInbox).toBe(false);

    clock.now = NOW + HOUR + 1;
    expect(await scheduler.runDue()).toBe(1);
    expect(a.threadLabels(FIXTURE_IDS.github)).toContain('INBOX');
  });

  it('a reply on a snoozed thread that a Gmail filter archives still brings the thread back', async () => {
    const { db, a, clock, deps, tick, scheduler } = await setup();
    await snooze(deps, id, NOW + 3 * HOUR);
    await tick();
    const snoozed = a.labelId(SNOOZED_LABEL)!;

    clock.now = NOW + HOUR;
    a.deliver(FIXTURE_IDS.github, { from: 'Ana Pop <ana@friends.ro>', subject: 'Re: [owner/super-mail] CI failed on main', labelIds: ['UNREAD'] }); // filter: skip the inbox
    await tick();
    await scheduler.runDue();

    expect(a.threadLabels(FIXTURE_IDS.github)).toContain('INBOX');
    expect(a.threadLabels(FIXTURE_IDS.github)).not.toContain(snoozed);
    expect(snoozeRows(db, id)).toBe(0);
    expect(toSummary(db, id)).toMatchObject({ inInbox: true, snoozedUntil: null });
  });

  it('a filter-archived reply on a Done thread respects Gmail and stays archived', async () => {
    const { db, a, clock, deps, tick, scheduler } = await setup();
    const vercel = `a:${FIXTURE_IDS.vercel}`;
    await done(deps, vercel);
    await tick();
    clock.now = NOW + HOUR;
    a.deliver(FIXTURE_IDS.vercel, { from: 'Vercel <notifications@vercel.com>', subject: 'Failed production deployment on team', labelIds: ['UNREAD'] });
    await tick();
    await scheduler.runDue();
    expect(a.threadLabels(FIXTURE_IDS.vercel)).not.toContain('INBOX');
    expect(toSummary(db, vercel).inInbox).toBe(false);
  });
});

describe('two-way detection after label_writes age out (PLAUSIBLE e)', () => {
  it('an old SuperMail label we wrote is not mistaken for an owner move after 30+ days', async () => {
    const { db, a, clock, deps, tick, scheduler } = await setup();
    const id = `a:${FIXTURE_IDS.courseNewsletter}`;
    expect(toSummary(db, id).groupId).toBe('news');
    const news = a.labelId('SuperMail/News')!;

    clock.now = NOW + 60_000;
    await done(deps, id); // archived: a newer write that does not mention News
    clock.now += 60_000;
    await teach(deps, { threadId: id, action: 'always_group', scope: 'sender', groupId: 'dev' }); // regrouped while archived
    expect(toSummary(db, id).groupId).toBe('dev');
    expect(a.threadLabels(FIXTURE_IDS.courseNewsletter)).toContain(news); // archived history is not relabelled
    await tick();

    clock.now = NOW + 40 * DAY;
    await scheduler.runDue(); // prunes old label_writes
    a.setLabels(FIXTURE_IDS.courseNewsletter, ['INBOX'], []); // the owner brings it back in Gmail
    await tick();

    expect(overrideOf(db, id)).toBeUndefined();
    expect(toSummary(db, id).groupId).toBe('dev');
  });

  it('pruning keeps the newest write of each label and drops the rest', async () => {
    const { db, clock, scheduler } = await setup();
    const rows = () => db.prepare("SELECT added_json, removed_json FROM label_writes WHERE gmail_thread_id = 'x' ORDER BY id").all();
    const ins = db.prepare("INSERT INTO label_writes(account_id, gmail_thread_id, added_json, removed_json, at) VALUES ('a', 'x', ?, ?, ?)");
    ins.run('["L1"]', '["L2"]', NOW - 50 * DAY);
    ins.run('["L2"]', '["INBOX"]', NOW - 45 * DAY);
    ins.run('[]', '["L1"]', NOW - 40 * DAY);
    ins.run('["L3"]', '[]', NOW); // recent: kept as is
    clock.now = NOW;
    await scheduler.runDue();
    expect(lastWriteOf(db, 'a', 'x', 'L1')).toBe('removed');
    expect(lastWriteOf(db, 'a', 'x', 'L2')).toBe('added');
    expect(lastWriteOf(db, 'a', 'x', 'INBOX')).toBe('removed');
    expect(lastWriteOf(db, 'a', 'x', 'L3')).toBe('added');
    expect(rows()).toHaveLength(2);
  });
});

