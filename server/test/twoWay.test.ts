import { describe, expect, it, vi } from 'vitest';
import { type DB, openDb } from '../src/db/index.js';
import { recordLabelWrite } from '../src/labels/labelWriter.js';
import { createPoller } from '../src/sync/poller.js';
import { makeThreadHook } from '../src/threads/classifyThread.js';
import { toSummary } from '../src/threads/queries.js';
import { createFakeGmail, type FakeGmail } from './fakes/fakeGmail.js';
import { FIXTURE_IDS, inboxFixtures } from './fixtures/threads.js';

const NOW = Date.UTC(2026, 9, 29, 10, 0, 0);
const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

async function setup() {
  const db: DB = openDb(':memory:');
  db.prepare("INSERT INTO accounts(id, email, color, status, created_at) VALUES ('a', 'me@gmail.com', '#2563eb', 'syncing', 1)").run();
  const clock = { now: NOW };
  const a = createFakeGmail('me@gmail.com', { now: () => clock.now });
  for (const t of inboxFixtures(NOW)) a.addThread(t);
  const gmailFor = () => a;
  const hook = makeThreadHook({ db, gmailFor, now: () => clock.now, log });
  const poller = createPoller({ db, gmailFor, intervalMs: 30_000, onChange: hook, log });
  const tick = async () => {
    await poller.tick();
    await hook.idle();
  };
  await tick();
  return { db, a, clock, tick };
}

const id = `a:${FIXTURE_IDS.courseNewsletter}`;
const callsFor = (a: FakeGmail, gmailThreadId: string) => a.calls.modifyThread.filter(([t]) => t === gmailThreadId);

describe('label changes made in the Gmail app', () => {
  it('moving a thread from SuperMail/News to SuperMail/Dev becomes a one-off override, never reverted', async () => {
    const { db, a, clock, tick } = await setup();
    expect(toSummary(db, id).groupId).toBe('news');
    // Make sure SuperMail/Dev exists (the GitHub thread was labelled Dev during sync).
    expect(a.labelId('SuperMail/Dev')).toBeDefined();

    clock.now = NOW + 10 * 60_000;
    a.setLabels(FIXTURE_IDS.courseNewsletter, ['SuperMail/Dev'], ['SuperMail/News']); // the owner, in the Gmail app
    const before = callsFor(a, FIXTURE_IDS.courseNewsletter).length;
    await tick();

    expect(db.prepare('SELECT group_id, source, suggest_rule FROM overrides WHERE thread_id = ?').get(id)).toEqual({ group_id: 'dev', source: 'gmail', suggest_rule: 1 });
    expect(toSummary(db, id)).toMatchObject({ groupId: 'dev', suggestRule: true, reason: expect.objectContaining({ source: 'override' }) });
    expect(callsFor(a, FIXTURE_IDS.courseNewsletter)).toHaveLength(before); // nothing reverted
    expect(a.threadLabels(FIXTURE_IDS.courseNewsletter)).toContain(a.labelId('SuperMail/Dev'));
    expect(a.threadLabels(FIXTURE_IDS.courseNewsletter)).not.toContain(a.labelId('SuperMail/News'));

    // Later changes on the thread keep the override and still don't revert anything.
    clock.now += 60_000;
    a.setLabels(FIXTURE_IDS.courseNewsletter, [], ['UNREAD']);
    await tick();
    expect(toSummary(db, id).groupId).toBe('dev');
    expect(callsFor(a, FIXTURE_IDS.courseNewsletter)).toHaveLength(before);
  });

  it('a label change we wrote ourselves 5 s earlier is not an override', async () => {
    const { db, a, clock, tick } = await setup();
    clock.now = NOW + 10 * 60_000;
    const dev = a.labelId('SuperMail/Dev')!;
    const news = a.labelId('SuperMail/News')!;
    a.setLabels(FIXTURE_IDS.courseNewsletter, [dev], [news], false); // our own modifyThread...
    recordLabelWrite(db, 'a', FIXTURE_IDS.courseNewsletter, [dev], [news], clock.now); // ...logged as ours
    clock.now += 5_000;
    await tick();
    expect(db.prepare('SELECT count(*) FROM overrides').pluck().get()).toBe(0);
    expect(toSummary(db, id).suggestRule).toBe(false);
  });

  it('removing the group label in Gmail is not reverted', async () => {
    const { db, a, clock, tick } = await setup();
    clock.now = NOW + 10 * 60_000;
    a.setLabels(FIXTURE_IDS.courseNewsletter, [], ['SuperMail/News']);
    const before = callsFor(a, FIXTURE_IDS.courseNewsletter).length;
    await tick();
    expect(callsFor(a, FIXTURE_IDS.courseNewsletter)).toHaveLength(before);
    expect(db.prepare('SELECT count(*) FROM overrides').pluck().get()).toBe(0);
  });
});
