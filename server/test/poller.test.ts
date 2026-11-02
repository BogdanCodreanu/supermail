import type { ServerEvent } from '@supermail/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DB, openDb } from '../src/db/index.js';
import { bus } from '../src/events.js';
import type { GmailApi } from '../src/google/gmailApi.js';
import { initialSync } from '../src/sync/initialSync.js';
import { createPoller, type Poller } from '../src/sync/poller.js';
import { createFakeGmail, type FakeGmail } from './fakes/fakeGmail.js';
import { DAY, FIXTURE_IDS, HOUR, inboxFixtures } from './fixtures/threads.js';

const NOW = Date.UTC(2026, 9, 29, 10, 0, 0);

function addAccount(db: DB, id: string, email: string): void {
  db.prepare("INSERT INTO accounts(id, email, color, status, created_at) VALUES (?, ?, '#2563eb', 'syncing', 1)").run(id, email);
}

const status = (db: DB, id: string) => db.prepare('SELECT status FROM accounts WHERE id = ?').pluck().get(id) as string;
const threadRow = (db: DB, id: string) =>
  db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as { in_inbox: number; done_at: number | null; unread: number; from_email: string; snippet: string } | undefined;
const count = (db: DB, sql: string, ...p: unknown[]) => db.prepare(sql).pluck().get(...p) as number;

describe('history poller', () => {
  let db: DB;
  let a: FakeGmail;
  let b: FakeGmail;
  let gmailFor: (id: string) => GmailApi;
  let events: ServerEvent[];
  let off: () => void;
  let poller: Poller;
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

  beforeEach(async () => {
    db = openDb(':memory:');
    addAccount(db, 'a', 'me@gmail.com');
    addAccount(db, 'b', 'work@gmail.com');
    a = createFakeGmail('me@gmail.com', { now: () => NOW });
    b = createFakeGmail('work@gmail.com', { now: () => NOW });
    for (const t of inboxFixtures(NOW)) a.addThread(t);
    b.addThread({ id: 'b-1', messages: [{ from: 'Boss <boss@corp.com>', subject: 'Status', date: NOW - DAY }] });
    gmailFor = vi.fn((id: string) => (id === 'a' ? a : b));
    poller = createPoller({ db, gmailFor, intervalMs: 30_000, log });
    await poller.tick(); // initial sync of both accounts
    events = [];
    off = bus.subscribe((e) => events.push(e));
    log.error.mockClear();
  });

  afterEach(() => {
    off();
    poller.stop();
  });

  it('indexes a newly delivered message on the next tick and publishes thread.updated', async () => {
    const onChange = vi.fn();
    poller = createPoller({ db, gmailFor, intervalMs: 30_000, onChange, log });
    a.deliver('new-1', { from: 'Ana <ana@friends.ro>', subject: 'Hi there', snippet: 'Long time no see', date: NOW + 1000 });
    await poller.tick();

    const row = threadRow(db, 'a:new-1');
    expect(row).toMatchObject({ in_inbox: 1, unread: 1, from_email: 'ana@friends.ro', snippet: 'Long time no see' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'thread.updated', thread: expect.objectContaining({ id: 'a:new-1', subject: 'Hi there' }) }));
    expect(events.some((e) => e.type === 'groups.updated')).toBe(true);
    expect(onChange).toHaveBeenCalledWith('a:new-1', 'new');
    expect(db.prepare("SELECT history_id FROM accounts WHERE id = 'a'").pluck().get()).toBe(String(a.currentHistoryId()));
  });

  it('applies label changes and deletions from history', async () => {
    const onChange = vi.fn();
    poller = createPoller({ db, gmailFor, intervalMs: 30_000, onChange, log });
    a.setLabels(FIXTURE_IDS.github, [], ['INBOX']);
    a.deleteThread(FIXTURE_IDS.vercel);
    await poller.tick();
    expect(threadRow(db, `a:${FIXTURE_IDS.github}`)?.in_inbox).toBe(0);
    expect(onChange).toHaveBeenCalledWith(`a:${FIXTURE_IDS.github}`, 'changed');
    expect(threadRow(db, `a:${FIXTURE_IDS.vercel}`)).toBeUndefined();
    expect(events).toContainEqual({ type: 'thread.removed', id: `a:${FIXTURE_IDS.vercel}` });
  });

  it('mail moved to spam or trash leaves the index and the UI, and comes back if rescued in Gmail', async () => {
    poller = createPoller({ db, gmailFor, intervalMs: 30_000, log });
    a.setLabels(FIXTURE_IDS.github, ['SPAM'], ['INBOX']);
    a.setLabels(FIXTURE_IDS.vercel, ['TRASH'], ['INBOX']);
    await poller.tick();
    expect(threadRow(db, `a:${FIXTURE_IDS.github}`)).toBeUndefined();
    expect(threadRow(db, `a:${FIXTURE_IDS.vercel}`)).toBeUndefined();
    expect(events).toContainEqual({ type: 'thread.removed', id: `a:${FIXTURE_IDS.github}` });

    a.setLabels(FIXTURE_IDS.github, ['INBOX'], ['SPAM']);
    await poller.tick();
    expect(threadRow(db, `a:${FIXTURE_IDS.github}`)?.in_inbox).toBe(1);
  });

  it('a tick with no history makes no thread fetches and publishes nothing', async () => {
    const before = a.calls.all.length;
    await poller.tick();
    expect(a.calls.all.slice(before)).toEqual(['listHistory']);
    expect(events).toEqual([]);
  });

  it('Review Focus 1: a revoked account flips to reconnect_needed while the other keeps syncing', async () => {
    a.revoke();
    b.deliver('b-2', { from: 'Boss <boss@corp.com>', subject: 'Re: Status', date: NOW + 1000 });
    await poller.tick();

    expect(status(db, 'a')).toBe('reconnect_needed');
    expect(status(db, 'b')).toBe('ok');
    expect(threadRow(db, 'b:b-2')?.in_inbox).toBe(1);
    expect(events).toContainEqual({ type: 'account.updated', account: { id: 'a', email: 'me@gmail.com', color: '#2563eb', status: 'reconnect_needed' } });

    const callsA = a.calls.all.length;
    vi.mocked(gmailFor).mockClear();
    await poller.tick();
    expect(a.calls.all.length).toBe(callsA);
    expect(gmailFor).not.toHaveBeenCalledWith('a');
    expect(status(db, 'a')).toBe('reconnect_needed');
  });

  it('Review Focus 1: an account whose client cannot be built (undecryptable token) does not stop the others', async () => {
    poller = createPoller({
      db,
      gmailFor: (id) => {
        if (id === 'a') throw Object.assign(new Error('cannot decrypt'), { name: 'TokenDecryptError' });
        return b;
      },
      intervalMs: 30_000,
      log,
    });
    b.deliver('b-3', { from: 'boss@corp.com', subject: 'ping', date: NOW + 1000 });
    await poller.tick();
    expect(status(db, 'a')).toBe('reconnect_needed');
    expect(threadRow(db, 'b:b-3')?.in_inbox).toBe(1);
  });

  it('a transient error is logged and retried on the next tick without losing history', async () => {
    const historyBefore = db.prepare("SELECT history_id FROM accounts WHERE id = 'a'").pluck().get();
    a.deliver('new-2', { from: 'x@y.com', subject: 'retry me', date: NOW + 1000 });
    const original = a.getThread.bind(a);
    a.getThread = async () => {
      throw Object.assign(new Error('backend error'), { code: 503 });
    };
    await poller.tick();
    expect(log.error).toHaveBeenCalled();
    expect(status(db, 'a')).toBe('ok');
    expect(db.prepare("SELECT history_id FROM accounts WHERE id = 'a'").pluck().get()).toBe(historyBefore);
    expect(threadRow(db, 'a:new-2')).toBeUndefined();

    a.getThread = original;
    await poller.tick();
    expect(threadRow(db, 'a:new-2')?.in_inbox).toBe(1);
  });

  it('Review Focus 2: expired history triggers a full resync without duplicates, keeping overrides and snoozes', async () => {
    const threadsBefore = count(db, 'SELECT count(*) FROM threads');
    const messagesBefore = count(db, 'SELECT count(*) FROM messages');
    const snoozed = `a:${FIXTURE_IDS.courseNewsletter}`;
    const overridden = `a:${FIXTURE_IDS.alibaba}`;
    db.prepare("UPDATE threads SET group_id = 'news', reason_source = 'override' WHERE id = ?").run(overridden);
    db.prepare("INSERT INTO overrides(thread_id, group_id, source, created_at) VALUES (?, 'news', 'app', ?)").run(overridden, NOW);
    db.prepare('INSERT INTO snoozes(thread_id, until, created_at) VALUES (?, ?, ?)').run(snoozed, NOW + DAY, NOW);
    a.setLabels(FIXTURE_IDS.courseNewsletter, ['SuperMail/Snoozed'], ['INBOX']);

    a.expireHistory();
    await poller.tick();

    expect(a.calls.all).toContain('getProfile');
    expect(count(db, 'SELECT count(*) FROM threads')).toBe(threadsBefore);
    expect(count(db, 'SELECT count(*) FROM messages')).toBe(messagesBefore);
    expect(db.prepare('SELECT group_id FROM overrides WHERE thread_id = ?').pluck().get(overridden)).toBe('news');
    expect(db.prepare('SELECT group_id FROM threads WHERE id = ?').pluck().get(overridden)).toBe('news');
    expect(db.prepare('SELECT until FROM snoozes WHERE thread_id = ?').pluck().get(snoozed)).toBe(NOW + DAY);
    expect(threadRow(db, snoozed)?.in_inbox).toBe(0);
    expect(status(db, 'a')).toBe('ok');
    expect(db.prepare("SELECT history_id FROM accounts WHERE id = 'a'").pluck().get()).toBe(String(a.currentHistoryId()));

    // Polling resumes normally after the resync.
    a.deliver('after-resync', { from: 'x@y.com', subject: 'after', date: NOW + 1000 });
    await poller.tick();
    expect(threadRow(db, 'a:after-resync')?.in_inbox).toBe(1);
  });

  it('Review Focus 3 (index): a reply from someone else on a Done thread clears done_at and its snooze and puts it back in the inbox', async () => {
    const id = `a:${FIXTURE_IDS.personal}`;
    a.setLabels(FIXTURE_IDS.personal, [], ['INBOX']);
    await poller.tick();
    db.prepare('UPDATE threads SET done_at = ? WHERE id = ?').run(NOW, id);
    db.prepare('INSERT INTO snoozes(thread_id, until, created_at) VALUES (?, ?, ?)').run(id, NOW + DAY, NOW);
    expect(threadRow(db, id)).toMatchObject({ in_inbox: 0, done_at: NOW });

    a.deliver(FIXTURE_IDS.personal, { from: 'Sam Carter <sam@carter.example>', subject: 'Re: Coffee next week?', date: NOW + HOUR, inReplyTo: '<coffee-1@carter.example>' });
    await poller.tick();

    expect(threadRow(db, id)).toMatchObject({ in_inbox: 1, done_at: null });
    expect(count(db, 'SELECT count(*) FROM snoozes WHERE thread_id = ?', id)).toBe(0);
  });

  it('Review Focus 3 (index): the owner\'s own reply does not undo Done', async () => {
    const id = `a:${FIXTURE_IDS.personal}`;
    a.setLabels(FIXTURE_IDS.personal, [], ['INBOX']);
    await poller.tick();
    db.prepare('UPDATE threads SET done_at = ? WHERE id = ?').run(NOW, id);
    a.deliver(FIXTURE_IDS.personal, { from: 'Me <me@gmail.com>', to: 'sam@carter.example', subject: 'Re: Coffee next week?', date: NOW + HOUR, labelIds: ['SENT'] });
    await poller.tick();
    expect(threadRow(db, id)).toMatchObject({ in_inbox: 0, done_at: NOW, from_email: 'sam@carter.example' });
  });

  it('start() polls on the interval and stop() ends it', async () => {
    vi.useFakeTimers();
    try {
      const timed = createPoller({ db, gmailFor, intervalMs: 30_000, log });
      timed.start();
      await vi.advanceTimersByTimeAsync(0);
      const afterStart = a.calls.all.filter((c) => c === 'listHistory').length;
      expect(afterStart).toBeGreaterThanOrEqual(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(a.calls.all.filter((c) => c === 'listHistory').length).toBe(afterStart + 1);
      timed.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(a.calls.all.filter((c) => c === 'listHistory').length).toBe(afterStart + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs a backfill step after history when storage allows it, and skips it when not', async () => {
    db.prepare('UPDATE accounts SET backfill_done = 0, backfill_page_token = NULL').run();
    a.addThread({ id: 'ancient', messages: [{ from: 'x@y.com', subject: 'ancient', date: NOW - 400 * DAY, labelIds: [] }] });
    const blocked = createPoller({ db, gmailFor, intervalMs: 30_000, canIndexMore: () => false, log });
    await blocked.tick();
    expect(threadRow(db, 'a:ancient')).toBeUndefined();

    const onAfterTick = vi.fn();
    const allowed = createPoller({ db, gmailFor, intervalMs: 30_000, canIndexMore: () => true, onAfterTick, log });
    await allowed.tick();
    expect(threadRow(db, 'a:ancient')?.in_inbox).toBe(0);
    expect(db.prepare("SELECT backfill_done FROM accounts WHERE id = 'a'").pluck().get()).toBe(1);
    expect(onAfterTick).toHaveBeenCalledTimes(1);
  });

  it('a reconnected account (status syncing, history_id NULL) is resynced on the next tick', async () => {
    await initialSync(db, 'a', a);
    db.prepare("UPDATE accounts SET status = 'syncing', history_id = NULL WHERE id = 'a'").run();
    const before = a.calls.all.filter((c) => c === 'getProfile').length;
    await poller.tick();
    expect(a.calls.all.filter((c) => c === 'getProfile').length).toBe(before + 1);
    expect(status(db, 'a')).toBe('ok');
  });
});
