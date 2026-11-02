import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db/index.js';
import { ALLOW_ALL, type AppDeps } from '../src/http/app.js';
import { done, snooze } from '../src/actions/actions.js';
import { SNOOZED_LABEL } from '../src/labels/labelWriter.js';
import { createSnoozeScheduler } from '../src/scheduler/snoozeScheduler.js';
import { createPoller } from '../src/sync/poller.js';
import { makeThreadHook } from '../src/threads/classifyThread.js';
import { toSummary } from '../src/threads/queries.js';
import { createFakeGmail, type FakeGmail } from './fakes/fakeGmail.js';
import { FIXTURE_IDS, HOUR, inboxFixtures } from './fixtures/threads.js';

const NOW = Date.UTC(2026, 9, 29, 10, 0, 0);
const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

async function setup() {
  const db: DB = openDb(':memory:');
  db.prepare("INSERT INTO accounts(id, email, color, status, created_at) VALUES ('a', 'me@gmail.com', '#2563eb', 'syncing', 1)").run();
  const clock = { now: NOW };
  const a = createFakeGmail('me@gmail.com', { now: () => clock.now });
  for (const t of inboxFixtures(NOW)) a.addThread(t);
  const gmailFor = () => a;
  const hook = makeThreadHook({ db, gmailFor, now: () => clock.now, log });
  const poller = createPoller({ db, gmailFor, intervalMs: 30_000, onChange: hook, log });
  const deps: AppDeps = { db, config: {} as AppConfig, gmailFor, now: () => clock.now, onThreadChange: hook, storage: ALLOW_ALL };
  const tick = async () => {
    await poller.tick();
    await hook.idle();
  };
  await tick();
  const scheduler = createSnoozeScheduler(deps, 60_000);
  stops.push(() => scheduler.stop());
  return { db, a, clock, deps, tick, scheduler };
}

const id = `a:${FIXTURE_IDS.github}`;
const snoozeRows = (db: DB) => db.prepare('SELECT count(*) FROM snoozes WHERE thread_id = ?').pluck().get(id) as number;
const callsFor = (a: FakeGmail, gmailThreadId: string) => a.calls.modifyThread.filter(([t]) => t === gmailThreadId);

describe('snooze scheduler', () => {
  it('restores a due snooze: INBOX back, snooze label off, row gone', async () => {
    const { db, a, clock, deps, scheduler } = await setup();
    await snooze(deps, id, NOW + HOUR);
    const snoozed = a.labelId(SNOOZED_LABEL)!;
    expect(await scheduler.runDue()).toBe(0); // not due yet

    clock.now = NOW + HOUR + 1;
    expect(await scheduler.runDue()).toBe(1);
    expect(a.calls.modifyThread.at(-1)).toEqual([FIXTURE_IDS.github, ['INBOX'], [snoozed]]);
    expect(a.threadLabels(FIXTURE_IDS.github)).toContain('INBOX');
    expect(a.threadLabels(FIXTURE_IDS.github)).not.toContain(snoozed);
    expect(snoozeRows(db)).toBe(0);
    expect(toSummary(db, id)).toMatchObject({ inInbox: true, snoozedUntil: null });
    expect(db.prepare('SELECT surfaced_at FROM threads WHERE id = ?').pluck().get(id)).toBe(NOW + HOUR + 1);
    expect(await scheduler.runDue()).toBe(0);
  });

  it('a snooze that fell due while the scheduler was stopped is restored when it starts', async () => {
    const { db, a, clock, deps, scheduler } = await setup();
    await snooze(deps, id, NOW + HOUR);
    clock.now = NOW + 5 * HOUR; // the server was down at the due time
    scheduler.start();
    expect(await scheduler.runDue()).toBe(1); // joins the startup run
    expect(snoozeRows(db)).toBe(0);
    expect(a.threadLabels(FIXTURE_IDS.github)).toContain('INBOX');
  });

  it('Review Focus 3: a reply on a snoozed thread cancels the snooze and brings it back', async () => {
    const { db, a, clock, deps, tick, scheduler } = await setup();
    await snooze(deps, id, NOW + 3 * HOUR);
    await tick();
    expect(snoozeRows(db)).toBe(1); // our own label change is not mistaken for the owner's

    clock.now = NOW + HOUR;
    a.deliver(FIXTURE_IDS.github, { from: 'Ana Pop <ana@friends.ro>', subject: 'Re: [owner/super-mail] CI failed on main', snippet: 'I fixed it, can you check?' });
    await tick();

    expect(snoozeRows(db)).toBe(0);
    // The group is recomputed from the latest message not sent by the owner: a person, so Important.
    expect(toSummary(db, id)).toMatchObject({ inInbox: true, snoozedUntil: null, groupId: 'important' });
    expect(a.threadLabels(FIXTURE_IDS.github)).not.toContain(a.labelId(SNOOZED_LABEL));
    expect(a.threadLabels(FIXTURE_IDS.github)).toContain(a.labelId('SuperMail/Important'));

    clock.now = NOW + 4 * HOUR;
    const before = callsFor(a, FIXTURE_IDS.github).length;
    expect(await scheduler.runDue()).toBe(0);
    expect(callsFor(a, FIXTURE_IDS.github)).toHaveLength(before);
  });

  it('Review Focus 3: a reply on a Done thread brings it back to the inbox', async () => {
    const { db, a, clock, deps, tick } = await setup();
    const vercel = `a:${FIXTURE_IDS.vercel}`;
    await done(deps, vercel);
    await tick();
    clock.now = NOW + HOUR;
    a.deliver(FIXTURE_IDS.vercel, { from: 'Vercel <notifications@vercel.com>', subject: 'Failed production deployment on team', snippet: 'Failed again' });
    await tick();
    expect(toSummary(db, vercel)).toMatchObject({ inInbox: true, groupId: 'dev' });
    expect(db.prepare('SELECT done_at FROM threads WHERE id = ?').pluck().get(vercel)).toBeNull();
  });

  it('Review Focus 4: the owner moves a snoozed thread back to the inbox in Gmail; the scheduler leaves it alone', async () => {
    const { db, a, clock, deps, tick, scheduler } = await setup();
    await snooze(deps, id, NOW + HOUR);
    await tick();
    a.setLabels(FIXTURE_IDS.github, ['INBOX'], []); // the owner, in the Gmail app
    await tick();
    expect(snoozeRows(db)).toBe(0);
    expect(toSummary(db, id)).toMatchObject({ inInbox: true, snoozedUntil: null });
    expect(a.threadLabels(FIXTURE_IDS.github)).toContain('INBOX');

    clock.now = NOW + 2 * HOUR;
    const before = callsFor(a, FIXTURE_IDS.github).length;
    expect(await scheduler.runDue()).toBe(0);
    expect(callsFor(a, FIXTURE_IDS.github)).toHaveLength(before);
  });

  it('Review Focus 4: the owner archives a snoozed thread in Gmail; the scheduler does not resurrect it', async () => {
    const { db, a, clock, deps, tick, scheduler } = await setup();
    await snooze(deps, id, NOW + HOUR);
    await tick();
    a.setLabels(FIXTURE_IDS.github, [], [SNOOZED_LABEL]); // removed the snooze label: archived for good
    await tick();
    expect(snoozeRows(db)).toBe(0);

    clock.now = NOW + 2 * HOUR;
    const before = callsFor(a, FIXTURE_IDS.github).length;
    expect(await scheduler.runDue()).toBe(0);
    expect(callsFor(a, FIXTURE_IDS.github)).toHaveLength(before);
    expect(a.threadLabels(FIXTURE_IDS.github)).not.toContain('INBOX');
    expect(toSummary(db, id).inInbox).toBe(false);
  });
});
