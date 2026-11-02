import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db/index.js';
import type { GmailApi } from '../src/google/gmailApi.js';
import { ALLOW_ALL, type AppDeps } from '../src/http/app.js';
import { search } from '../src/mail/search.js';
import { initialSync, mapLimit } from '../src/sync/initialSync.js';
import { createPoller } from '../src/sync/poller.js';
import { createFakeGmail, type FakeGmail } from './fakes/fakeGmail.js';
import { allFixtures, DAY, FIXTURE_IDS, inboxFixtures } from './fixtures/threads.js';

const NOW = Date.UTC(2026, 9, 29, 10, 0, 0);
const MINUTE = 60_000;

const config: AppConfig = {
  port: 8787,
  host: '127.0.0.1',
  dataDir: '/tmp/unused',
  publicUrl: 'http://localhost:8787',
  ownerEmail: 'me@gmail.com',
  googleClientFile: '/nonexistent/client_secret.json',
  pollSeconds: 30,
  limits: { bodyCacheMB: 1024, indexMB: 1024, logsMB: 50, totalMB: 3072, minFreeDiskGB: 20 },
  secureCookies: false,
};

function addAccount(db: DB, id: string, email: string, createdAt = 1): void {
  db.prepare("INSERT INTO accounts(id, email, color, status, created_at) VALUES (?, ?, '#2563eb', 'syncing', ?)").run(id, email, createdAt);
}

const acct = (db: DB, id: string) =>
  db.prepare('SELECT status, history_id FROM accounts WHERE id = ?').get(id) as { status: string; history_id: string | null };
const inInbox = (db: DB, id: string) => db.prepare('SELECT in_inbox FROM threads WHERE id = ?').pluck().get(id) as number | undefined;
const count = (db: DB, sql: string, ...p: unknown[]) => db.prepare(sql).pluck().get(...p) as number;
const backendError = () => Object.assign(new Error('backend error'), { code: 503 });

/** Makes `getThread` fail for the given thread ids (all calls), recording every requested id. */
function failThreads(gmail: FakeGmail, bad: Set<string>): string[] {
  const requested: string[] = [];
  const original = gmail.getThread.bind(gmail);
  gmail.getThread = async (id, format) => {
    requested.push(id);
    if (bad.has(id)) throw backendError();
    return original(id, format);
  };
  return requested;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('mapLimit', () => {
  it('stops taking new items after the first failure and lets in-flight ones settle before rejecting', async () => {
    const started: number[] = [];
    let active = 0;
    const items = Array.from({ length: 50 }, (_, i) => i);
    const run = mapLimit(items, 5, async (i) => {
      started.push(i);
      active++;
      await new Promise((r) => setTimeout(r, 2));
      active--;
      if (i === 0) throw new Error('boom');
    });
    await expect(run).rejects.toThrow('boom');
    expect(active).toBe(0);
    const after = started.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(started.length).toBe(after);
    expect(after).toBeLessThanOrEqual(10);
  });
});

describe('#2 resumable initial sync', () => {
  let db: DB;
  let gmail: FakeGmail;
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

  beforeEach(() => {
    db = openDb(':memory:');
    addAccount(db, 'a', 'me@gmail.com');
    gmail = createFakeGmail('me@gmail.com', { now: () => NOW });
    for (const t of allFixtures(NOW)) gmail.addThread(t);
    log.error.mockClear();
    log.warn.mockClear();
  });

  it('an initial sync interrupted mid-way is resumed after a restart, reaches ok and is searchable', async () => {
    // First run: the 4th thread fetch fails (e.g. a 503 after gaxios' retries, or the add-on is restarted).
    const original = gmail.getThread.bind(gmail);
    let fetches = 0;
    gmail.getThread = async (id, format) => {
      if (++fetches === 4) throw backendError();
      return original(id, format);
    };
    await createPoller({ db, gmailFor: () => gmail, intervalMs: 30_000, log }).tick();
    expect(acct(db, 'a')).toMatchObject({ status: 'syncing', history_id: null });
    const indexedFirst = count(db, "SELECT count(*) FROM threads WHERE account_id = 'a'");
    expect(indexedFirst).toBeLessThan(inboxFixtures(NOW).length);

    // Mail that arrives while the sync is interrupted.
    gmail.deliver('late', { from: 'x@y.com', subject: 'arrived during the outage', date: NOW + 1000 });

    // "Restart": a new poller over the same database.
    gmail.getThread = original;
    const requested: string[] = [];
    const counting = gmail.getThread.bind(gmail);
    gmail.getThread = async (id, format) => {
      requested.push(id);
      return counting(id, format);
    };
    await createPoller({ db, gmailFor: () => gmail, intervalMs: 30_000, log }).tick();

    expect(acct(db, 'a')).toMatchObject({ status: 'ok' });
    expect(acct(db, 'a').history_id).not.toBeNull();
    for (const t of inboxFixtures(NOW)) expect(inInbox(db, `a:${t.id}`)).toBe(1);
    expect(inInbox(db, 'a:late')).toBe(1);
    // The resumed first sync does not refetch what the interrupted run already indexed.
    const indexedIds = db.prepare("SELECT gmail_thread_id FROM threads WHERE account_id = 'a'").pluck().all() as string[];
    expect(requested.length).toBeLessThanOrEqual(indexedIds.length - indexedFirst + 1);

    const deps: AppDeps = { db, config, gmailFor: () => gmail, now: () => NOW, onThreadChange: () => {}, storage: ALLOW_ALL };
    const page = await search(deps, 'Bolt');
    expect(page.threads.map((t) => t.id)).toContain(`a:${FIXTURE_IDS.bolt}`);
  });

  it('changes made in Gmail while an interrupted first sync waits are replayed by history after it completes', async () => {
    const original = gmail.getThread.bind(gmail);
    let fetches = 0;
    gmail.getThread = async (id, format) => {
      if (++fetches === 6) throw backendError();
      return original(id, format);
    };
    const poller = createPoller({ db, gmailFor: () => gmail, intervalMs: 30_000, log });
    await poller.tick();
    expect(acct(db, 'a').status).toBe('syncing');
    // Archive a thread the first run already indexed: it must not stay in the inbox.
    const indexed = db.prepare("SELECT gmail_thread_id FROM threads WHERE account_id = 'a' AND in_inbox = 1").pluck().all() as string[];
    expect(indexed.length).toBeGreaterThan(0);
    gmail.setLabels(indexed[0]!, [], ['INBOX']);

    gmail.getThread = original;
    await poller.tick(); // completes the initial sync
    await poller.tick(); // first history poll
    expect(acct(db, 'a').status).toBe('ok');
    expect(inInbox(db, `a:${indexed[0]}`)).toBe(0);
  });

  it('an interrupted resync after expired history is resumed on the next tick', async () => {
    const poller = createPoller({ db, gmailFor: () => gmail, intervalMs: 30_000, log });
    await poller.tick();
    expect(acct(db, 'a').status).toBe('ok');

    gmail.setLabels(FIXTURE_IDS.github, [], ['INBOX']);
    gmail.expireHistory();
    const original = gmail.getThread.bind(gmail);
    let fetches = 0;
    gmail.getThread = async (id, format) => {
      if (++fetches === 2) throw backendError();
      return original(id, format);
    };
    await poller.tick();
    expect(acct(db, 'a').status).toBe('syncing');

    gmail.getThread = original;
    await poller.tick();
    expect(acct(db, 'a')).toMatchObject({ status: 'ok', history_id: String(gmail.currentHistoryId()) });
    expect(inInbox(db, `a:${FIXTURE_IDS.github}`)).toBe(0);
  });
});

describe('#4 bounded retries', () => {
  let db: DB;
  let gmail: FakeGmail;
  let clock: number;
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  const historyId = () => db.prepare("SELECT history_id FROM accounts WHERE id = 'a'").pluck().get() as string;

  beforeEach(async () => {
    db = openDb(':memory:');
    addAccount(db, 'a', 'me@gmail.com');
    gmail = createFakeGmail('me@gmail.com', { now: () => NOW, pageSize: 2 });
    for (const t of inboxFixtures(NOW)) gmail.addThread(t);
    clock = NOW;
    await initialSync(db, 'a', gmail);
    log.error.mockClear();
    log.warn.mockClear();
  });

  it('a thread that keeps failing is skipped after 3 attempts, logged at most once per hour, and history advances', async () => {
    gmail.deliver('bad', { from: 'x@y.com', subject: 'broken', date: NOW + 1000 });
    gmail.deliver('good', { from: 'x@y.com', subject: 'fine', date: NOW + 2000 });
    const requested = failThreads(gmail, new Set(['bad']));
    const poller = createPoller({ db, gmailFor: () => gmail, intervalMs: 30_000, log, now: () => clock });

    const start = historyId();
    await poller.tick();
    await poller.tick();
    expect(historyId()).toBe(start);
    await poller.tick(); // third failure: the thread is parked and history moves on
    expect(historyId()).toBe(String(gmail.currentHistoryId()));
    expect(inInbox(db, 'a:good')).toBe(1);
    const parkedLogs = () => log.warn.mock.calls.filter(([obj]) => (obj as { threadId?: string }).threadId === 'bad');
    expect(parkedLogs()).toHaveLength(1);

    // Later ticks retry it with backoff, without replaying history and logging at most once per hour.
    const badBefore = requested.filter((id) => id === 'bad').length;
    const goodBefore = requested.filter((id) => id === 'good').length;
    for (let i = 0; i < 20; i++) {
      clock += 2 * MINUTE;
      await poller.tick();
    }
    const retries = requested.filter((id) => id === 'bad').length - badBefore;
    expect(retries).toBeGreaterThan(0);
    expect(retries).toBeLessThan(20);
    expect(requested.filter((id) => id === 'good')).toHaveLength(goodBefore);
    expect(parkedLogs()).toHaveLength(1);
    clock += 61 * MINUTE;
    await poller.tick();
    expect(parkedLogs()).toHaveLength(2);
  });

  it('a parked thread is indexed once Gmail serves it again', async () => {
    gmail.deliver('bad', { from: 'x@y.com', subject: 'broken', date: NOW + 1000 });
    const bad = new Set(['bad']);
    failThreads(gmail, bad);
    const poller = createPoller({ db, gmailFor: () => gmail, intervalMs: 30_000, log, now: () => clock });
    for (let i = 0; i < 3; i++) await poller.tick();
    expect(inInbox(db, 'a:bad')).toBeUndefined();

    bad.clear();
    clock += 2 * 60 * MINUTE;
    await poller.tick();
    expect(inInbox(db, 'a:bad')).toBe(1);
  });

  it('history_id advances page by page, so a failure does not replay pages already indexed', async () => {
    // Five history records, two per page: ids p1 p2 | p3 p4 | p5.
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) gmail.deliver(id, { from: 'x@y.com', subject: id, date: NOW + 1000 });
    const start = Number(historyId());
    const requested = failThreads(gmail, new Set(['p5']));
    const poller = createPoller({ db, gmailFor: () => gmail, intervalMs: 30_000, log, now: () => clock });

    await poller.tick();
    expect(Number(historyId())).toBe(start + 4);
    for (const id of ['p1', 'p2', 'p3', 'p4']) expect(inInbox(db, `a:${id}`)).toBe(1);

    await poller.tick();
    expect(requested.filter((id) => id !== 'p5')).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('a backfill page with a persistently failing thread does not get stuck', async () => {
    for (let i = 0; i < 3; i++) gmail.addThread({ id: `old-${i}`, messages: [{ from: 'x@y.com', subject: `old ${i}`, date: NOW - 400 * DAY, labelIds: [] }] });
    db.prepare("UPDATE accounts SET backfill_done = 0, backfill_page_token = NULL WHERE id = 'a'").run();
    failThreads(gmail, new Set(['old-1']));
    const poller = createPoller({ db, gmailFor: () => gmail, intervalMs: 30_000, log, now: () => clock });
    for (let i = 0; i < 4; i++) await poller.tick();
    expect(db.prepare("SELECT backfill_done FROM accounts WHERE id = 'a'").pluck().get()).toBe(1);
    expect(inInbox(db, 'a:old-0')).toBe(0);
    expect(inInbox(db, 'a:old-2')).toBe(0);
  });

  it('a revoked grant still marks the account reconnect_needed instead of parking threads', async () => {
    gmail.deliver('new', { from: 'x@y.com', subject: 'new', date: NOW + 1000 });
    const poller = createPoller({ db, gmailFor: () => gmail, intervalMs: 30_000, log, now: () => clock });
    gmail.revoke();
    await poller.tick();
    expect(acct(db, 'a').status).toBe('reconnect_needed');
  });
});

describe('#5 accounts poll independently', () => {
  let db: DB;
  let a: FakeGmail;
  let b: FakeGmail;
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

  beforeEach(async () => {
    db = openDb(':memory:');
    addAccount(db, 'a', 'me@gmail.com', 1);
    a = createFakeGmail('me@gmail.com', { now: () => NOW });
    b = createFakeGmail('work@gmail.com', { now: () => NOW });
    for (const t of inboxFixtures(NOW)) a.addThread(t);
    b.addThread({ id: 'b-1', messages: [{ from: 'boss@corp.com', subject: 'Status', date: NOW - DAY }] });
    await initialSync(db, 'a', a);
    addAccount(db, 'b', 'work@gmail.com', 2);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("one account's long initial sync does not stall polling of the others", async () => {
    const gate = deferred<void>();
    const profile = b.getProfile.bind(b);
    b.getProfile = vi.fn(async () => {
      await gate.promise;
      return profile();
    });
    const gmailFor = (id: string): GmailApi => (id === 'a' ? a : b);
    vi.useFakeTimers();
    const poller = createPoller({ db, gmailFor, intervalMs: 30_000, log });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    a.deliver('a-new', { from: 'x@y.com', subject: 'while b syncs', date: NOW + 1000 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(inInbox(db, 'a:a-new')).toBe(1);
    a.deliver('a-new-2', { from: 'x@y.com', subject: 'still syncing', date: NOW + 2000 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(inInbox(db, 'a:a-new-2')).toBe(1);
    // b's slow sync is not started twice.
    expect(b.getProfile).toHaveBeenCalledTimes(1);
    expect(acct(db, 'b').status).toBe('syncing');

    poller.stop();
    vi.useRealTimers();
    gate.resolve();
    await poller.tick(); // joins b's sync already in flight
    expect(b.getProfile).toHaveBeenCalledTimes(1);
    expect(acct(db, 'b').status).toBe('ok');
  });

  it('tick() waits for every account and does not start a second poll of an account already in flight', async () => {
    const gate = deferred<void>();
    const profile = b.getProfile.bind(b);
    b.getProfile = vi.fn(async () => {
      await gate.promise;
      return profile();
    });
    const poller = createPoller({ db, gmailFor: (id) => (id === 'a' ? a : b), intervalMs: 30_000, log });
    let done = false;
    const first = poller.tick().then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(done).toBe(false);
    gate.resolve();
    await first;
    expect(b.getProfile).toHaveBeenCalledTimes(1);
    expect(acct(db, 'b').status).toBe('ok');
  });
});
