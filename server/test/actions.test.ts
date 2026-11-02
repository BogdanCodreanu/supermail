import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db/index.js';
import { ALLOW_ALL, type AppDeps } from '../src/http/app.js';
import { done, moveToGroup, setRead, snooze, teach } from '../src/actions/actions.js';
import { UNDO_TTL_MS, undo } from '../src/actions/undo.js';
import { SNOOZED_LABEL } from '../src/labels/labelWriter.js';
import { createPoller } from '../src/sync/poller.js';
import { labelWritesIdle, makeThreadHook } from '../src/threads/classifyThread.js';
import { toSummary } from '../src/threads/queries.js';
import { createFakeGmail, type FakeGmail } from './fakes/fakeGmail.js';
import { allFixtures, DAY, FIXTURE_IDS, HOUR } from './fixtures/threads.js';

const NOW = Date.UTC(2026, 9, 29, 10, 0, 0);
const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

async function setup(before?: (a: FakeGmail) => void) {
  const db: DB = openDb(':memory:');
  db.prepare("INSERT INTO accounts(id, email, color, status, created_at) VALUES ('a', 'me@gmail.com', '#2563eb', 'syncing', 1)").run();
  const clock = { now: NOW };
  const a = createFakeGmail('me@gmail.com', { now: () => clock.now });
  for (const t of allFixtures(NOW)) a.addThread(t);
  before?.(a);
  const gmailFor = () => a;
  const hook = makeThreadHook({ db, gmailFor, now: () => clock.now, log });
  const poller = createPoller({ db, gmailFor, intervalMs: 30_000, onChange: hook, log });
  const deps: AppDeps = { db, config: {} as AppConfig, gmailFor, now: () => clock.now, onThreadChange: hook, storage: ALLOW_ALL };
  const tick = async () => {
    await poller.tick();
    await hook.idle();
  };
  await tick();
  return { db, a, clock, deps, tick };
}

const tid = (gmailId: string) => `a:${gmailId}`;
const callsFor = (a: FakeGmail, gmailThreadId: string) => a.calls.modifyThread.filter(([id]) => id === gmailThreadId);

describe('Done and undo', () => {
  it('done removes INBOX, and undo puts it back', async () => {
    const { db, a, deps } = await setup();
    const id = tid(FIXTURE_IDS.github);
    const r = await done(deps, id);
    expect(r.undoId).toEqual(expect.any(String));
    expect(r.thread).toMatchObject({ id, inInbox: false });
    expect(a.threadLabels(FIXTURE_IDS.github)).not.toContain('INBOX');
    expect(a.calls.modifyThread.at(-1)).toEqual([FIXTURE_IDS.github, [], ['INBOX']]);
    expect(db.prepare('SELECT done_at FROM threads WHERE id = ?').pluck().get(id)).toBe(NOW);

    const u = await undo(deps, r.undoId);
    expect(u.thread).toMatchObject({ id, inInbox: true });
    expect(a.threadLabels(FIXTURE_IDS.github)).toContain('INBOX');
    expect(db.prepare('SELECT done_at FROM threads WHERE id = ?').pluck().get(id)).toBeNull();
  });

  it('done on a snoozed thread removes the snooze label and row', async () => {
    const { db, a, deps } = await setup();
    const id = tid(FIXTURE_IDS.vercel);
    await snooze(deps, id, NOW + DAY);
    const snoozed = a.labelId(SNOOZED_LABEL)!;
    expect(a.threadLabels(FIXTURE_IDS.vercel)).toContain(snoozed);
    await done(deps, id);
    expect(a.threadLabels(FIXTURE_IDS.vercel)).not.toContain(snoozed);
    expect(a.threadLabels(FIXTURE_IDS.vercel)).not.toContain('INBOX');
    expect(db.prepare('SELECT count(*) FROM snoozes WHERE thread_id = ?').pluck().get(id)).toBe(0);
  });

  it('undo after the TTL is refused with 410', async () => {
    const { deps, clock } = await setup();
    const r = await done(deps, tid(FIXTURE_IDS.github));
    clock.now += UNDO_TTL_MS + 1;
    await expect(undo(deps, r.undoId)).rejects.toMatchObject({ statusCode: 410 });
  });

  it('undo of an unknown id is 404', async () => {
    const { deps } = await setup();
    await expect(undo(deps, 'nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('snooze validation', () => {
  it('rejects a snooze time in the past with 400', async () => {
    const { deps } = await setup();
    await expect(snooze(deps, tid(FIXTURE_IDS.github), NOW - HOUR)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects a snooze less than 60 s ahead with 400', async () => {
    const { deps } = await setup();
    await expect(snooze(deps, tid(FIXTURE_IDS.github), NOW + 30_000)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('snooze removes INBOX, adds the snooze label and records the row', async () => {
    const { db, a, deps } = await setup();
    const id = tid(FIXTURE_IDS.github);
    const r = await snooze(deps, id, NOW + 2 * HOUR);
    expect(r.thread).toMatchObject({ inInbox: false, snoozedUntil: NOW + 2 * HOUR });
    expect(a.threadLabels(FIXTURE_IDS.github)).toContain(a.labelId(SNOOZED_LABEL));
    expect(a.threadLabels(FIXTURE_IDS.github)).not.toContain('INBOX');
    expect(db.prepare('SELECT until FROM snoozes WHERE thread_id = ?').pluck().get(id)).toBe(NOW + 2 * HOUR);

    const u = await undo(deps, r.undoId);
    expect(u.thread).toMatchObject({ inInbox: true, snoozedUntil: null });
    expect(a.threadLabels(FIXTURE_IDS.github)).not.toContain(a.labelId(SNOOZED_LABEL));
  });
});

describe('teaching', () => {
  const alibabaExtras = (g: FakeGmail) => {
    g.addThread({ id: 'f-ali-order', messages: [{ from: 'Alibaba <orders@notice.alibaba.com>', subject: 'Your order has shipped', date: NOW - 9 * HOUR, labelIds: ['INBOX', 'CATEGORY_UPDATES'] }] });
    g.addThread({ id: 'f-ali-archived', messages: [{ from: 'Alibaba <orders@notice.alibaba.com>', subject: 'Your order was delivered', date: NOW - 10 * DAY, labelIds: ['CATEGORY_UPDATES'] }] });
  };

  it('not_important on the domain moves every inbox thread from it to Low priority and leaves archived labels alone', async () => {
    const { db, a, deps } = await setup(alibabaExtras);
    expect(toSummary(db, tid('f-ali-order')).groupId).toBe('purchases');
    const archivedLabels = a.threadLabels('f-ali-archived');

    const r = await teach(deps, { threadId: tid(FIXTURE_IDS.alibaba), action: 'not_important', scope: 'domain' });
    await labelWritesIdle(db);
    expect(r.thread).toMatchObject({ groupId: 'low_priority', reason: expect.objectContaining({ source: 'mark' }) });
    expect(db.prepare('SELECT match_type, match_value, mark FROM sender_marks').all()).toEqual([{ match_type: 'domain', match_value: 'notice.alibaba.com', mark: 'not_important' }]);
    expect(toSummary(db, tid('f-ali-order'))).toMatchObject({ groupId: 'low_priority', reason: expect.objectContaining({ source: 'mark' }) });

    const lowPriority = a.labelId('SuperMail/Low priority')!;
    const purchases = a.labelId('SuperMail/Purchases')!;
    expect(a.threadLabels('f-ali-order')).toContain(lowPriority);
    expect(a.threadLabels('f-ali-order')).not.toContain(purchases);
    expect(callsFor(a, 'f-ali-archived')).toEqual([]);
    expect(a.threadLabels('f-ali-archived')).toEqual(archivedLabels);
  });

  it('always_group creates a rule and the reason says the owner said so', async () => {
    const { db, a, deps } = await setup();
    const id = tid(FIXTURE_IDS.vercel);
    const r = await teach(deps, { threadId: id, action: 'always_group', scope: 'sender', groupId: 'news' });
    await labelWritesIdle(db);
    expect(db.prepare('SELECT match_type, match_value, group_id FROM rules').all()).toEqual([{ match_type: 'sender', match_value: 'notifications@vercel.com', group_id: 'news' }]);
    expect(r.thread?.groupId).toBe('news');
    expect(r.thread?.reason.source).toBe('rule');
    expect(r.thread?.reason.text.startsWith('In News because you said so on')).toBe(true);
    expect(a.threadLabels(FIXTURE_IDS.vercel)).toContain(a.labelId('SuperMail/News'));
    expect(a.threadLabels(FIXTURE_IDS.vercel)).not.toContain(a.labelId('SuperMail/Dev'));

    const u = await undo(deps, r.undoId);
    await labelWritesIdle(db);
    expect(db.prepare('SELECT count(*) FROM rules').pluck().get()).toBe(0);
    expect(u.thread?.groupId).toBe('dev');
    expect(a.threadLabels(FIXTURE_IDS.vercel)).toContain(a.labelId('SuperMail/Dev'));
  });

  it('always_group needs an existing group, and a list scope needs a list', async () => {
    const { deps } = await setup();
    await expect(teach(deps, { threadId: tid(FIXTURE_IDS.vercel), action: 'always_group', scope: 'sender' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(teach(deps, { threadId: tid(FIXTURE_IDS.vercel), action: 'always_group', scope: 'sender', groupId: 'nope' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(teach(deps, { threadId: tid(FIXTURE_IDS.vercel), action: 'important', scope: 'list' })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('move and read', () => {
  it('move writes an app override and relabels; undo restores the previous group', async () => {
    const { db, a, deps } = await setup();
    const id = tid(FIXTURE_IDS.courseNewsletter);
    expect(toSummary(db, id).groupId).toBe('news');
    const r = await moveToGroup(deps, id, 'important');
    expect(r.thread).toMatchObject({ groupId: 'important', reason: expect.objectContaining({ source: 'override' }), suggestRule: false });
    expect(db.prepare('SELECT group_id, source FROM overrides WHERE thread_id = ?').get(id)).toEqual({ group_id: 'important', source: 'app' });
    expect(a.threadLabels(FIXTURE_IDS.courseNewsletter)).toContain(a.labelId('SuperMail/Important'));
    expect(a.threadLabels(FIXTURE_IDS.courseNewsletter)).not.toContain(a.labelId('SuperMail/News'));

    const u = await undo(deps, r.undoId);
    expect(u.thread?.groupId).toBe('news');
    expect(db.prepare('SELECT count(*) FROM overrides').pluck().get()).toBe(0);
    expect(a.threadLabels(FIXTURE_IDS.courseNewsletter)).toContain(a.labelId('SuperMail/News'));
  });

  it('move to an unknown group is 400', async () => {
    const { deps } = await setup();
    await expect(moveToGroup(deps, tid(FIXTURE_IDS.courseNewsletter), 'nope')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('read removes UNREAD and undo restores it', async () => {
    const { a, deps } = await setup();
    const id = tid(FIXTURE_IDS.vercel);
    const r = await setRead(deps, id, true);
    expect(r.thread?.unread).toBe(false);
    expect(a.threadLabels(FIXTURE_IDS.vercel)).not.toContain('UNREAD');
    const u = await undo(deps, r.undoId);
    expect(u.thread?.unread).toBe(true);
    expect(a.threadLabels(FIXTURE_IDS.vercel)).toContain('UNREAD');
  });

  it('an action on an unknown thread is 404', async () => {
    const { deps } = await setup();
    await expect(done(deps, 'a:missing')).rejects.toMatchObject({ statusCode: 404 });
  });
});
