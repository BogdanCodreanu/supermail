import { randomBytes } from 'node:crypto';
import type { PushPayload } from '@supermail/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { done, setRead, snooze } from '../src/actions/actions.js';
import { bulkAction } from '../src/actions/bulk.js';
import { removeAccount } from '../src/accounts/accounts.js';
import type { AppConfig } from '../src/config.js';
import { encrypt } from '../src/crypto/tokens.js';
import { type DB, openDb } from '../src/db/index.js';
import { ALLOW_ALL, type AppDeps } from '../src/http/app.js';
import { getThreadDetail } from '../src/mail/bodies.js';
import { search } from '../src/mail/search.js';
import { keysWereReset, loadOrCreateVapid } from '../src/push/keys.js';
import { createPushService, type PushSender, type PushService } from '../src/push/service.js';
import { createSnoozeScheduler } from '../src/scheduler/snoozeScheduler.js';
import { reportSpam } from '../src/spam/spam.js';
import { createPoller, type Poller } from '../src/sync/poller.js';
import { makeThreadHook, type ThreadChangeHook } from '../src/threads/classifyThread.js';
import { createFakeGmail, type FakeGmail } from './fakes/fakeGmail.js';

const NOW = Date.UTC(2026, 9, 31, 10, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PHONE = 'https://fcm.googleapis.com/fcm/send/phone';
const LAPTOP = 'https://fcm.googleapis.com/fcm/send/laptop';

type LogFn = (obj: unknown, msg?: string) => void;
const newLog = () => ({ error: vi.fn<LogFn>(), warn: vi.fn<LogFn>(), info: vi.fn<LogFn>() });

interface Sent { endpoint: string; payload: PushPayload; raw: string; ttl: number; urgency: string }

interface World {
  db: DB; a: FakeGmail; b: FakeGmail; clock: { now: number }; deps: AppDeps; hook: ThreadChangeHook; poller: Poller; push: PushService; sent: Sent[]; send: ReturnType<typeof vi.fn>; log: ReturnType<typeof newLog>;
  tick(): Promise<void>;
}

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) {
    w.poller.stop();
    w.push.stop();
    w.db.close();
  }
});

function subscribe(db: DB, endpoint: string, id = endpoint.split('/').at(-1)!): void {
  db.prepare('INSERT INTO push_subscriptions(id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, endpoint, 'p256', 'auth', 'Chrome', NOW);
}

async function setup(over: { sender?: PushSender; timeoutMs?: number; subscriptions?: string[] } = {}): Promise<World> {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO accounts(id, email, color, status, created_at) VALUES ('a', 'me@gmail.com', '#2563eb', 'syncing', 1)").run();
  db.prepare("INSERT INTO accounts(id, email, color, status, created_at) VALUES ('b', 'work@gmail.com', '#16a34a', 'syncing', 1)").run();
  const clock = { now: NOW };
  const a = createFakeGmail('me@gmail.com', { now: () => clock.now });
  const b = createFakeGmail('work@gmail.com', { now: () => clock.now });
  a.addThread({ id: 'old', messages: [{ from: 'Ana <ana@friends.ro>', subject: 'Old', date: NOW - DAY, labelIds: ['INBOX'] }] });
  const gmailFor = (id: string) => (id === 'a' ? a : b);
  const log = newLog();
  const hook = makeThreadHook({ db, gmailFor, now: () => clock.now, log });
  const sent: Sent[] = [];
  const send = vi.fn(async (sub: { endpoint: string }, payload: string, o: { ttl: number; urgency: string }) => {
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) as PushPayload, raw: payload, ttl: o.ttl, urgency: o.urgency });
  });
  const push = createPushService({ db, publicKey: 'pub', sender: over.sender ?? send, now: () => clock.now, log, timeoutMs: over.timeoutMs });
  const poller = createPoller({ db, gmailFor, intervalMs: 15_000, onChange: hook, onNewMail: (id, threads) => push.newMail(id, threads), onAfterTick: () => push.sweep(), log, now: () => clock.now });
  const deps: AppDeps = { db, config: {} as AppConfig, gmailFor, now: () => clock.now, onThreadChange: hook, storage: ALLOW_ALL, push };
  const tick = async () => {
    await poller.tick();
    await hook.idle();
    await push.idle();
  };
  await tick(); // initial sync
  for (const endpoint of over.subscriptions ?? [PHONE]) subscribe(db, endpoint);
  const w: World = { db, a, b, clock, deps, hook, poller, push, sent, send, log, tick };
  worlds.push(w);
  return w;
}

const mailIn = (w: World, id = 'n1', over: object = {}) => {
  w.clock.now += 1000;
  w.a.deliver(id, { from: 'Ana Pop <ana@friends.ro>', subject: 'Lunch?', snippet: 'Are you free on Friday', date: w.clock.now, ...over });
};
const mails = (w: World) => w.sent.filter((s) => s.payload.type === 'mail');
const clears = (w: World) => w.sent.filter((s) => s.payload.type === 'clear');
const notified = (db: DB) => db.prepare('SELECT thread_id FROM notified_threads').pluck().all() as string[];

describe('notifying about new mail', () => {
  it('sends a new inbox email to every device, once, high urgency, for a day', async () => {
    const w = await setup({ subscriptions: [PHONE, LAPTOP] });
    mailIn(w);
    await w.tick();
    expect(w.sent.map((s) => s.endpoint).sort()).toEqual([LAPTOP, PHONE]);
    const [first] = w.sent;
    expect(first!.payload).toEqual({ type: 'mail', threadId: 'a:n1', title: 'Ana Pop', body: 'Lunch?\nAre you free on Friday', accountLabel: 'me', group: 'Important', sentAt: w.clock.now });
    expect(first).toMatchObject({ ttl: 86_400, urgency: 'high' });
    expect(notified(w.db)).toEqual(['a:n1']);
    await w.tick();
    expect(mails(w)).toHaveLength(2); // nothing new, nothing sent
  });

  it('notifies again for a new reply, under the same thread id', async () => {
    const w = await setup();
    mailIn(w);
    await w.tick();
    mailIn(w, 'n1', { subject: 'Re: Lunch?' });
    await w.tick();
    expect(mails(w).map((s) => (s.payload as { threadId: string }).threadId)).toEqual(['a:n1', 'a:n1']);
  });

  it('sends nothing at all with no device subscribed', async () => {
    const w = await setup({ subscriptions: [] });
    mailIn(w);
    await w.tick();
    expect(w.sent).toEqual([]);
    expect(notified(w.db)).toEqual([]);
  });

  it.each([
    ['this account', { from: 'Me <me@gmail.com>' }],
    ['another connected account', { from: 'Work <work@gmail.com>' }],
    ['the Sent label, whatever the From says', { from: 'Alias <alias@me.ro>', labelIds: ['INBOX', 'UNREAD', 'SENT'] }],
  ])('stays quiet when the newest message came from %s', async (_, msg) => {
    const w = await setup();
    mailIn(w, 'n1', msg);
    await w.tick();
    expect(w.sent).toEqual([]);
  });

  it('judges the newest message of the thread, not the sender of the older ones', async () => {
    const w = await setup();
    mailIn(w);
    await w.tick();
    mailIn(w, 'n1', { from: 'Me <me@gmail.com>', subject: 'Re: Lunch?', labelIds: ['SENT'] });
    await w.tick();
    expect(mails(w)).toHaveLength(1);
  });

  it('stays quiet for a muted group', async () => {
    const w = await setup();
    w.db.prepare('UPDATE groups SET notify = 0').run();
    mailIn(w);
    await w.tick();
    expect(w.sent).toEqual([]);
  });

  it('stays quiet for mail a Gmail filter archived, and for mail already read', async () => {
    const w = await setup();
    mailIn(w, 'archived', { labelIds: ['UNREAD'] });
    mailIn(w, 'read', { labelIds: ['INBOX'] });
    await w.tick();
    expect(w.sent).toEqual([]);
  });

  it('stays quiet through initial sync, even for a thread that is new and unread', async () => {
    const w = await setup();
    w.db.prepare("UPDATE accounts SET history_id = NULL WHERE id = 'a'").run();
    mailIn(w);
    await w.tick();
    expect(w.db.prepare("SELECT 1 FROM threads WHERE id = 'a:n1'").get()).toBeDefined();
    expect(w.sent).toEqual([]);
  });

  it('stays quiet through a resync after Gmail expired the history', async () => {
    const w = await setup();
    mailIn(w);
    w.a.expireHistory();
    await w.tick();
    expect(w.db.prepare("SELECT 1 FROM threads WHERE id = 'a:n1'").get()).toBeDefined();
    expect(w.sent).toEqual([]);
  });

  it('stays quiet through backfill', async () => {
    const w = await setup();
    w.a.addThread({ id: 'ancient', messages: [{ from: 'Ana <ana@friends.ro>', subject: 'Years ago', date: NOW - 400 * DAY, labelIds: ['INBOX', 'UNREAD'] }] });
    w.db.prepare("UPDATE accounts SET backfill_done = 0, backfill_page_token = NULL WHERE id = 'a'").run();
    await w.tick();
    await w.tick(); // backfill runs every other poll
    expect(w.db.prepare("SELECT 1 FROM threads WHERE id = 'a:ancient'").get()).toBeDefined();
    expect(w.sent).toEqual([]);
  });

  it('stays quiet when a search finds mail the index lacks', async () => {
    const w = await setup();
    w.a.addThread({ id: 'found', messages: [{ from: 'Ana <ana@friends.ro>', subject: 'Findable', date: w.clock.now, labelIds: ['INBOX', 'UNREAD'] }] });
    await search(w.deps, 'Findable');
    await w.hook.idle();
    await w.push.idle();
    expect(w.db.prepare("SELECT 1 FROM threads WHERE id = 'a:found'").get()).toBeDefined();
    expect(w.sent).toEqual([]);
  });

  it('stays quiet when opening a thread pulls in a message the poller has not seen', async () => {
    const w = await setup();
    mailIn(w);
    await w.tick();
    w.sent.length = 0;
    w.a.deliver('n1', { from: 'Ana Pop <ana@friends.ro>', subject: 'Re: Lunch?', date: w.clock.now + 1 });
    await getThreadDetail(w.deps, 'a:n1');
    await w.hook.idle();
    await w.push.idle();
    expect(mails(w)).toEqual([]);
  });

  it('keeps a payload inside the Web Push limit, whatever the subject and sender', async () => {
    const w = await setup();
    mailIn(w, 'n1', { from: `"${'😀'.repeat(500)}" <ana@friends.ro>`, subject: '😀'.repeat(2000), snippet: '"'.repeat(3000) });
    await w.tick();
    expect(Buffer.byteLength(w.sent[0]!.raw)).toBeLessThan(3900);
  });

  it('never puts the owner\'s address in anything it hands to the sender', async () => {
    const w = await setup();
    mailIn(w);
    await w.tick();
    expect(JSON.stringify(w.send.mock.calls)).not.toContain('me@gmail.com');
  });
});

describe('a burst of mail', () => {
  const burst = (w: World, n: number, gmail: FakeGmail = w.a) => {
    for (let i = 0; i < n; i++) {
      w.clock.now += 1000;
      gmail.deliver(`b${i}`, { from: 'Ana <ana@friends.ro>', subject: `Mail ${i}`, date: w.clock.now });
    }
  };

  it('sends the newest 5 and one summary that counts them all', async () => {
    const w = await setup();
    burst(w, 12);
    await w.tick();
    expect(mails(w).map((s) => (s.payload as { threadId: string }).threadId).sort()).toEqual(['a:b10', 'a:b11', 'a:b7', 'a:b8', 'a:b9']);
    const summaries = w.sent.filter((s) => s.payload.type === 'summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.payload).toMatchObject({ title: '12 new emails', tag: 'summary:a' });
    expect(notified(w.db).sort()).toEqual(['a:b10', 'a:b11', 'a:b7', 'a:b8', 'a:b9']);
  });

  it('sends no summary for exactly 5', async () => {
    const w = await setup();
    burst(w, 5);
    await w.tick();
    expect(mails(w)).toHaveLength(5);
    expect(w.sent.some((s) => s.payload.type === 'summary')).toBe(false);
  });

  it('counts each account on its own', async () => {
    const w = await setup();
    burst(w, 7);
    burst(w, 7, w.b);
    await w.tick();
    expect(mails(w)).toHaveLength(10);
    expect(w.sent.filter((s) => s.payload.type === 'summary').map((s) => (s.payload as { tag: string }).tag).sort()).toEqual(['summary:a', 'summary:b']);
  });
});

describe('back from snooze', () => {
  const snoozed = async (over: object = {}) => {
    const w = await setup();
    mailIn(w, 'n1', over);
    await w.tick();
    await snooze(w.deps, 'a:n1', w.clock.now + HOUR);
    await w.push.idle();
    w.sent.length = 0;
    w.clock.now += HOUR + 1;
    return { w, scheduler: createSnoozeScheduler(w.deps, 60_000) };
  };

  it('notifies when a snooze comes back', async () => {
    const { w, scheduler } = await snoozed();
    expect(await scheduler.runDue()).toBe(1);
    await w.push.idle();
    expect(mails(w)).toHaveLength(1);
    expect(mails(w)[0]!.payload).toMatchObject({ type: 'mail', threadId: 'a:n1', title: 'Back from snooze', body: 'Ana Pop\nLunch?' });
    expect(notified(w.db)).toEqual(['a:n1']);
  });

  it('brings back mail already read too, and that notification survives the sweep', async () => {
    const { w, scheduler } = await snoozed();
    w.db.prepare("UPDATE threads SET unread = 0 WHERE id = 'a:n1'").run();
    await scheduler.runDue();
    await w.push.idle();
    w.push.sweep();
    await w.push.idle();
    expect(mails(w)).toHaveLength(1);
    expect(clears(w)).toEqual([]);
    await done(w.deps, 'a:n1');
    await w.push.idle();
    expect(clears(w)).toHaveLength(1); // Done still clears it
  });

  it('stays quiet in a muted group', async () => {
    const { w, scheduler } = await snoozed();
    w.db.prepare('UPDATE groups SET notify = 0').run();
    await scheduler.runDue();
    await w.push.idle();
    expect(mails(w)).toEqual([]);
  });

  it('a snooze that fails to restore says nothing', async () => {
    const { w, scheduler } = await snoozed();
    vi.spyOn(w.a, 'modifyThread').mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await scheduler.runDue()).toBe(0);
    await w.push.idle();
    expect(mails(w)).toEqual([]);
  });

  it('a pile of due snoozes gets the same burst limit', async () => {
    const w = await setup();
    for (let i = 0; i < 8; i++) mailIn(w, `s${i}`);
    await w.tick();
    for (let i = 0; i < 8; i++) await snooze(w.deps, `a:s${i}`, w.clock.now + HOUR);
    await w.push.idle();
    w.sent.length = 0;
    w.clock.now += HOUR + 1;
    await createSnoozeScheduler(w.deps, 60_000).runDue();
    await w.push.idle();
    expect(mails(w)).toHaveLength(5);
    expect(w.sent.filter((s) => s.payload.type === 'summary').map((s) => (s.payload as { title: string }).title)).toEqual(['8 emails back from snooze']);
  });
});

describe('when the push service misbehaves', () => {
  it.each([[404], [410]])('a %d removes that subscription and leaves the rest', async (statusCode) => {
    const sender: PushSender = async (sub) => {
      if (sub.endpoint === PHONE) throw Object.assign(new Error('gone'), { statusCode });
    };
    const w = await setup({ sender, subscriptions: [PHONE, LAPTOP] });
    mailIn(w);
    await w.tick();
    expect(w.db.prepare('SELECT endpoint FROM push_subscriptions').pluck().all()).toEqual([LAPTOP]);
    expect(w.log.error).not.toHaveBeenCalled();
  });

  it('logs another failure once, keeps the subscription, and sync carries on', async () => {
    const sender = vi.fn(async () => {
      throw Object.assign(new Error('Bad gateway'), { statusCode: 502 });
    });
    const w = await setup({ sender });
    mailIn(w, 'n1');
    await w.tick();
    mailIn(w, 'n2');
    await w.tick();
    expect(sender).toHaveBeenCalledTimes(2);
    expect(w.log.warn.mock.calls.filter(([, msg]) => /push/.test(String(msg)))).toHaveLength(1);
    expect(w.db.prepare('SELECT count(*) FROM push_subscriptions').pluck().get()).toBe(1);
    expect(w.db.prepare("SELECT count(*) FROM threads WHERE id IN ('a:n1', 'a:n2')").pluck().get()).toBe(2);
    expect(w.log.error).not.toHaveBeenCalled();
  });

  it('logs again after the subscription has worked in between', async () => {
    let fail = true;
    const sender: PushSender = async () => {
      if (fail) throw new Error('no route');
    };
    const w = await setup({ sender });
    mailIn(w, 'n1');
    await w.tick();
    fail = false;
    mailIn(w, 'n2');
    await w.tick();
    fail = true;
    mailIn(w, 'n3');
    await w.tick();
    expect(w.log.warn.mock.calls.filter(([, msg]) => /push/.test(String(msg)))).toHaveLength(2);
  });

  it('records when a device last took a push', async () => {
    const w = await setup();
    mailIn(w);
    await w.tick();
    expect(w.db.prepare('SELECT last_ok_at FROM push_subscriptions').pluck().get()).toBe(w.clock.now);
  });

  it('a push service that never answers does not hold the poller up', async () => {
    const sender = vi.fn(() => new Promise<void>(() => {}));
    const w = await setup({ sender, timeoutMs: 20 });
    mailIn(w);
    const started = performance.now();
    await w.poller.tick();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(w.db.prepare("SELECT 1 FROM threads WHERE id = 'a:n1'").get()).toBeDefined();
    await w.push.idle(); // gives up after the timeout
    expect(w.log.warn.mock.calls.some(([, msg]) => /push/.test(String(msg)))).toBe(true);
  });

  it('never runs more than a few sends at once', async () => {
    let running = 0;
    let most = 0;
    const sender: PushSender = async () => {
      most = Math.max(most, ++running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    };
    const subscriptions = Array.from({ length: 12 }, (_, i) => `${PHONE}${i}`);
    const w = await setup({ sender, subscriptions });
    mailIn(w);
    await w.tick();
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(4);
  });

  it('a throwing onNewMail never breaks the poll', async () => {
    const w = await setup();
    const poller = createPoller({ db: w.db, gmailFor: (id) => (id === 'a' ? w.a : w.b), intervalMs: 15_000, onChange: w.hook, onNewMail: () => { throw new Error('boom'); }, log: w.log, now: () => w.clock.now });
    mailIn(w);
    await expect(poller.tick()).resolves.toBeUndefined();
    expect(w.db.prepare("SELECT 1 FROM threads WHERE id = 'a:n1'").get()).toBeDefined();
    expect(w.log.error).toHaveBeenCalledWith(expect.anything(), 'onNewMail failed');
  });
});

describe('clearing a notification that was handled', () => {
  const notifiedThread = async (over: Parameters<typeof setup>[0] = {}) => {
    const w = await setup(over);
    mailIn(w);
    await w.tick();
    w.sent.length = 0;
    return w;
  };
  const expectCleared = (w: World) => {
    expect(clears(w).map((s) => s.payload)).toEqual([{ type: 'clear', threadId: 'a:n1' }]);
    expect(notified(w.db)).toEqual([]);
  };

  it.each([
    ['Done', (w: World) => done(w.deps, 'a:n1')],
    ['snooze', (w: World) => snooze(w.deps, 'a:n1', w.clock.now + HOUR)],
    ['read', (w: World) => setRead(w.deps, 'a:n1', true)],
    ['spam', (w: World) => reportSpam(w.deps, 'a:n1')],
  ])('%s in the app clears it', async (_, act) => {
    const w = await notifiedThread();
    await act(w);
    await w.push.idle();
    expectCleared(w);
  });

  it.each([
    ['read in Gmail', (w: World) => w.a.setLabels('n1', [], ['UNREAD'], false)],
    ['archived in Gmail', (w: World) => w.a.setLabels('n1', [], ['INBOX'], false)],
    ['spammed in Gmail', (w: World) => w.a.setLabels('n1', ['SPAM'], ['INBOX'], false)],
    ['trashed in Gmail', (w: World) => w.a.setLabels('n1', ['TRASH'], ['INBOX'], false)],
    ['deleted in Gmail', (w: World) => w.a.deleteThread('n1')],
  ])('%s clears it', async (_, act) => {
    const w = await notifiedThread();
    act(w);
    await w.tick();
    expectCleared(w);
  });

  it('removing the account clears its notifications', async () => {
    const w = await notifiedThread();
    removeAccount(w.db, 'a');
    await w.tick();
    expectCleared(w);
  });

  it('a change that leaves the email waiting clears nothing', async () => {
    const w = await notifiedThread();
    w.a.setLabels('n1', ['STARRED'], [], false);
    await w.tick();
    expect(clears(w)).toEqual([]);
    expect(notified(w.db)).toEqual(['a:n1']);
  });

  it('sends nothing for a thread that was never notified', async () => {
    const w = await setup();
    await done(w.deps, 'a:old');
    await w.push.idle();
    expect(w.sent).toEqual([]);
  });

  it('sends one clear for one thread: handling it twice owes nothing more', async () => {
    const w = await notifiedThread();
    await done(w.deps, 'a:n1');
    await w.push.idle();
    await w.tick();
    expect(clears(w)).toHaveLength(1);
  });

  it('coalesces a bulk action into one push', async () => {
    const w = await setup();
    for (const id of ['n1', 'n2', 'n3']) mailIn(w, id);
    await w.tick();
    w.sent.length = 0;
    await bulkAction(w.deps, { ids: ['a:n1', 'a:n2', 'a:n3', 'a:old'], action: 'done' });
    await w.hook.idle();
    await w.push.idle();
    expect(clears(w)).toHaveLength(1);
    const { threadIds } = clears(w)[0]!.payload as { threadIds: string[] };
    expect(threadIds.sort()).toEqual(['a:n1', 'a:n2', 'a:n3']);
  });

  it('a clear of many threads still fits a push: it goes in several', async () => {
    const w = await setup();
    const ids = Array.from({ length: 250 }, (_, i) => `a:x${i}`);
    for (const id of ids) {
      w.db.prepare("INSERT INTO threads(id, account_id, gmail_thread_id, last_message_at, in_inbox, unread) VALUES (?, 'a', ?, 1, 0, 1)").run(id, id.slice(2));
      w.db.prepare('INSERT INTO notified_threads(thread_id, notified_at) VALUES (?, ?)').run(id, w.clock.now);
    }
    w.push.sweep();
    await w.push.idle();
    expect(clears(w).flatMap((s) => (s.payload as { threadIds: string[] }).threadIds).sort()).toEqual([...ids].sort());
    expect(clears(w).every((s) => Buffer.byteLength(s.raw) < 3900)).toBe(true);
  });

  it('goes out soon after an action, with no poll needed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const w = await notifiedThread();
      await done(w.deps, 'a:n1');
      expect(clears(w)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(clears(w)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a new reply before the clear goes out cancels the clear', async () => {
    const w = await notifiedThread();
    await done(w.deps, 'a:n1');
    mailIn(w, 'n1', { subject: 'Re: Lunch?' });
    await w.tick();
    expect(clears(w)).toEqual([]);
    expect(mails(w)).toHaveLength(1);
    expect(notified(w.db)).toEqual(['a:n1']);
  });

  it('skips the device that acted from its notification: it already closed it', async () => {
    const w = await notifiedThread({ subscriptions: [PHONE, LAPTOP] });
    w.push.handledOn('a:n1', PHONE);
    await done(w.deps, 'a:n1');
    await w.push.idle();
    expect(clears(w).map((s) => s.endpoint)).toEqual([LAPTOP]);
  });

  it('forgets the device when a clear covers other threads too: it still needs those', async () => {
    const w = await setup({ subscriptions: [PHONE, LAPTOP] });
    for (const id of ['n1', 'n2']) mailIn(w, id);
    await w.tick();
    w.sent.length = 0;
    w.push.handledOn('a:n1', PHONE);
    await bulkAction(w.deps, { ids: ['a:n1', 'a:n2'], action: 'done' });
    await w.hook.idle();
    await w.push.idle();
    const phone = clears(w).find((s) => s.endpoint === PHONE)!.payload;
    const laptop = clears(w).find((s) => s.endpoint === LAPTOP)!.payload as { threadIds: string[] };
    expect(phone).toEqual({ type: 'clear', threadId: 'a:n2' });
    expect(laptop.threadIds.sort()).toEqual(['a:n1', 'a:n2']);
  });

  it('a clear travels at normal urgency: it must not wake a sleeping phone by itself', async () => {
    const w = await notifiedThread();
    await done(w.deps, 'a:n1');
    await w.push.idle();
    expect(clears(w)[0]).toMatchObject({ urgency: 'normal' });
  });

  it('prunes rows older than 3 days without sending anything', async () => {
    const w = await notifiedThread();
    w.clock.now += 3 * DAY + 1;
    w.push.sweep();
    await w.push.idle();
    expect(notified(w.db)).toEqual([]);
    expect(w.sent).toEqual([]);
    expect(w.db.prepare('SELECT count(*) FROM push_clears').pluck().get()).toBe(0);
  });

  it('keeps a clear owed across a restart', async () => {
    const w = await notifiedThread();
    await done(w.deps, 'a:n1');
    w.push.stop();
    const again = createPushService({ db: w.db, publicKey: 'pub', sender: w.send as unknown as PushSender, now: () => w.clock.now, log: w.log });
    again.sweep();
    await again.idle();
    again.stop();
    expectCleared(w);
  });
});

describe('VAPID keys', () => {
  const log = newLog;
  let db: DB;
  const key = randomBytes(32);

  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => db.close());

  const kvDump = () => JSON.stringify(db.prepare('SELECT * FROM kv').all());

  it('generates a pair on first start and keeps it', () => {
    const first = loadOrCreateVapid(db, key, log());
    expect(first.publicKey).toMatch(/^[\w-]{80,}$/);
    expect(first.privateKey).toMatch(/^[\w-]{40,}$/);
    expect(loadOrCreateVapid(db, key, log())).toEqual(first);
    expect(keysWereReset(db)).toBe(false);
  });

  it('leaves nothing readable about the keys in kv', () => {
    const keys = loadOrCreateVapid(db, key, log());
    const dump = kvDump();
    expect(dump).not.toContain(keys.privateKey);
    expect(dump).not.toContain(keys.publicKey);
    expect(dump).not.toMatch(/privateKey|publicKey/);
  });

  it('after a restore with another secret.key: new keys, every subscription gone, logged, flagged', () => {
    const first = loadOrCreateVapid(db, key, log());
    subscribe(db, PHONE);
    db.prepare("INSERT INTO accounts(id, email, color, status, created_at) VALUES ('a', 'me@gmail.com', '#2563eb', 'ok', 1)").run();
    db.prepare("INSERT INTO threads(id, account_id, gmail_thread_id, last_message_at) VALUES ('a:1', 'a', '1', 1)").run();
    db.prepare("INSERT INTO notified_threads(thread_id, notified_at) VALUES ('a:1', 1)").run();
    const l = log();
    const second = loadOrCreateVapid(db, randomBytes(32), l);
    expect(second.publicKey).not.toBe(first.publicKey);
    expect(db.prepare('SELECT count(*) FROM push_subscriptions').pluck().get()).toBe(0);
    expect(db.prepare('SELECT count(*) FROM notified_threads').pluck().get()).toBe(0);
    expect(db.prepare('SELECT count(*) FROM push_clears').pluck().get()).toBe(0);
    expect(l.warn).toHaveBeenCalledTimes(1);
    expect(keysWereReset(db)).toBe(true);
  });

  it('does the same for a value that decrypts to nonsense', () => {
    db.prepare("INSERT INTO kv(key, value) VALUES ('push_vapid', ?)").run(encrypt(key, 'not json').toString('base64'));
    const l = log();
    expect(loadOrCreateVapid(db, key, l).publicKey).toBeTruthy();
    expect(l.warn).toHaveBeenCalledTimes(1);
  });
});

describe('the poller after the move to 15 s', () => {
  it('keeps backfill at its 30 s pace', async () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO accounts(id, email, color, status, created_at) VALUES ('a', 'me@gmail.com', '#2563eb', 'syncing', 1)").run();
    const a = createFakeGmail('me@gmail.com', { now: () => NOW });
    a.addThread({ id: 'x', messages: [{ from: 'Ana <ana@friends.ro>', subject: 'Hi', date: NOW - DAY }] });
    const poller = createPoller({ db, gmailFor: () => a, intervalMs: 15_000 });
    await poller.tick();
    const pages = () => a.calls.all.filter((c) => c === 'listThreads').length;
    const before = pages();
    for (let i = 0; i < 4; i++) {
      db.prepare("UPDATE accounts SET backfill_done = 0 WHERE id = 'a'").run();
      await poller.tick();
    }
    expect(pages() - before).toBe(2);
    db.close();
  });
});
