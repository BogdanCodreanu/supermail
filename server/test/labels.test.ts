import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db/index.js';
import { ALLOW_ALL, type AppDeps } from '../src/http/app.js';
import { applyThreadLabels, groupLabelName, recordLabelWrite, SNOOZED_LABEL, wasWrittenByUs } from '../src/labels/labelWriter.js';
import { createPoller, type Poller } from '../src/sync/poller.js';
import { makeThreadHook } from '../src/threads/classifyThread.js';
import { toSummary } from '../src/threads/queries.js';
import { createFakeGmail, type FakeGmail } from './fakes/fakeGmail.js';
import { allFixtures, FIXTURE_IDS, HOUR } from './fixtures/threads.js';

const NOW = Date.UTC(2026, 9, 29, 10, 0, 0);
const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

interface Env { db: DB; a: FakeGmail; clock: { now: number }; deps: AppDeps; poller: Poller; hook: ReturnType<typeof makeThreadHook>; tick(): Promise<void> }

async function setup(before?: (a: FakeGmail) => void): Promise<Env> {
  const db = openDb(':memory:');
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
  return { db, a, clock, deps, poller, hook, tick };
}

const callsFor = (a: FakeGmail, gmailThreadId: string) => a.calls.modifyThread.filter(([id]) => id === gmailThreadId);

describe('group labels in Gmail', () => {
  it('labels an inbox thread with its group label and logs the write', async () => {
    const { db, a } = await setup();
    const dev = a.labelId('SuperMail/Dev');
    expect(dev).toBeDefined();
    expect(a.calls.modifyThread).toContainEqual([FIXTURE_IDS.github, [dev], []]);
    expect(a.threadLabels(FIXTURE_IDS.github)).toContain(dev);
    expect(db.prepare('SELECT count(*) FROM label_writes WHERE account_id = ? AND gmail_thread_id = ?').pluck().get('a', FIXTURE_IDS.github)).toBe(1);
  });

  it('reclassifying to News removes Dev and adds News', async () => {
    const { db, a, deps } = await setup();
    const id = `a:${FIXTURE_IDS.github}`;
    db.prepare("UPDATE threads SET group_id = 'news' WHERE id = ?").run(id);
    await applyThreadLabels(db, a, id, { now: deps.now() });
    const dev = a.labelId('SuperMail/Dev')!;
    const news = a.labelId('SuperMail/News')!;
    expect(a.calls.modifyThread.at(-1)).toEqual([FIXTURE_IDS.github, [news], [dev]]);
    expect(a.threadLabels(FIXTURE_IDS.github)).toContain(news);
    expect(a.threadLabels(FIXTURE_IDS.github)).not.toContain(dev);
    expect(a.threadLabels(FIXTURE_IDS.github)).toContain('INBOX');
  });

  it('an Unsorted thread gets no label', async () => {
    const { db, a } = await setup((g) =>
      g.addThread({ id: 'f-shop', messages: [{ from: 'Shop <info@shop.ro>', subject: 'Hello', date: NOW - HOUR, labelIds: ['INBOX', 'CATEGORY_UPDATES'] }] }),
    );
    expect(toSummary(db, 'a:f-shop').groupId).toBe('unsorted');
    expect(callsFor(a, 'f-shop')).toEqual([]);
  });

  it('reuses an existing SuperMail/Dev label instead of creating a second one', async () => {
    let existing = '';
    const { a } = await setup((g) => {
      existing = g.addLabel('SuperMail/Dev');
    });
    expect(a.calls.createLabel).not.toContain('SuperMail/Dev');
    expect(a.threadLabels(FIXTURE_IDS.github)).toContain(existing);
    const labels = await a.listLabels();
    expect(labels.filter((l) => l.name.toLowerCase() === 'supermail/dev')).toHaveLength(1);
  });

  it('never writes labels to archived history from initial sync or backfill', async () => {
    const { db, a } = await setup();
    const archived = db.prepare("SELECT id, in_inbox, group_id FROM threads WHERE id IN ('a:f-archived-recent', 'a:f-archived-old')").all() as { in_inbox: number; group_id: string }[];
    expect(archived).toHaveLength(2); // both indexed (90-day sync and backfill) and classified in the index
    for (const t of archived) expect(t).toMatchObject({ in_inbox: 0, group_id: 'money_security' });
    expect(callsFor(a, FIXTURE_IDS.archivedRecent)).toEqual([]);
    expect(callsFor(a, FIXTURE_IDS.archivedOld)).toEqual([]);
  });

  it('names group labels: SuperMail/<name>, the existing label in place, none for Unsorted', () => {
    const base = { labelIdsByAccount: new Map<string, string>() };
    expect(groupLabelName({ ...base, id: 'dev', name: 'Dev', builtinKey: 'dev', kind: 'builtin' })).toBe('SuperMail/Dev');
    expect(groupLabelName({ ...base, id: 'g1', name: 'Clients', builtinKey: null, kind: 'custom' })).toBe('SuperMail/Clients');
    expect(groupLabelName({ ...base, id: 'g2', name: 'Legal', builtinKey: null, kind: 'existing_label', existingLabelName: 'Legal - Example Studio SRL' })).toBe('Legal - Example Studio SRL');
    expect(groupLabelName({ ...base, id: 'unsorted', name: 'Unsorted', builtinKey: 'unsorted', kind: 'builtin' })).toBeNull();
    expect(SNOOZED_LABEL).toBe('SuperMail/Snoozed');
  });

  it('a failed write forgets a SuperMail label the owner deleted in Gmail, and only that one', async () => {
    const { db, a, deps } = await setup();
    const id = `a:${FIXTURE_IDS.github}`;
    const news = a.labelId('SuperMail/News')!;
    const dev = a.labelId('SuperMail/Dev')!;
    const withoutNews = async () => (await a.listLabels()).filter((l) => l.id !== news); // as if deleted in Gmail
    const failing = { ...a, listLabels: withoutNews, modifyThread: vi.fn().mockRejectedValueOnce(Object.assign(new Error('Invalid label'), { code: 400 })) };
    db.prepare("UPDATE threads SET group_id = 'news' WHERE id = ?").run(id);
    await expect(applyThreadLabels(db, failing, id, { now: deps.now() })).rejects.toThrow('Invalid label');
    expect(db.prepare("SELECT count(*) FROM group_labels WHERE group_id = 'news'").pluck().get()).toBe(0);
    expect(db.prepare("SELECT gmail_label_id FROM group_labels WHERE group_id = 'dev'").pluck().get()).toBe(dev);

    await applyThreadLabels(db, a, id, { now: deps.now() });
    expect(a.threadLabels(FIXTURE_IDS.github)).toContain(news);
    expect(a.threadLabels(FIXTURE_IDS.github)).not.toContain(dev);
    expect(db.prepare("SELECT gmail_label_id FROM group_labels WHERE group_id = 'news'").pluck().get()).toBe(news);
  });

  it('a transient write failure keeps every cached label id', async () => {
    const { db, a, deps } = await setup();
    const id = `a:${FIXTURE_IDS.github}`;
    const failing = { ...a, modifyThread: vi.fn().mockRejectedValueOnce(new Error('socket hang up')) };
    db.prepare("UPDATE threads SET group_id = 'news' WHERE id = ?").run(id);
    const before = db.prepare('SELECT count(*) FROM group_labels').pluck().get();
    await expect(applyThreadLabels(db, failing, id, { now: deps.now() })).rejects.toThrow('socket hang up');
    expect(db.prepare('SELECT count(*) FROM group_labels').pluck().get()).toBe(before);
  });

  it('wasWrittenByUs is true only within 120 s of our own write', () => {
    const db = openDb(':memory:');
    recordLabelWrite(db, 'a', 't1', ['Label_1'], ['Label_2'], NOW);
    expect(wasWrittenByUs(db, 'a', 't1', 'Label_1', NOW + 5_000)).toBe(true);
    expect(wasWrittenByUs(db, 'a', 't1', 'Label_2', NOW + 119_000)).toBe(true);
    expect(wasWrittenByUs(db, 'a', 't1', 'Label_1', NOW + 121_000)).toBe(false);
    expect(wasWrittenByUs(db, 'a', 't1', 'Label_3', NOW + 5_000)).toBe(false);
    expect(wasWrittenByUs(db, 'a', 't2', 'Label_1', NOW + 5_000)).toBe(false);
  });
});
