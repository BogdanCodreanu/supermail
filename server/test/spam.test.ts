import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_HEADER, type ActionResult, type ServerEvent, type ThreadDetailDTO, type ThreadPage } from '@supermail/shared';
import { done, moveToGroup, snooze } from '../src/actions/actions.js';
import { undo } from '../src/actions/undo.js';
import { createSession, requireSession, SESSION_COOKIE } from '../src/auth/sessions.js';
import type { AppConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db/index.js';
import { bus } from '../src/events.js';
import { ALLOW_ALL, type AppDeps, buildApp, type RoutePlugin } from '../src/http/app.js';
import { mailRoutes } from '../src/http/routes/mail.js';
import { spamRoutes } from '../src/http/routes/spam.js';
import { SNOOZED_LABEL } from '../src/labels/labelWriter.js';
import { getSpamThread, listSpam, notSpam, reportSpam } from '../src/spam/spam.js';
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

const GITHUB = FIXTURE_IDS.github;
const ID = `a:${GITHUB}`;
const count = (db: DB, table: string) => db.prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number;

async function setup() {
  const db: DB = openDb(':memory:');
  db.prepare("INSERT INTO accounts(id, email, color, status, created_at) VALUES ('a', 'me@gmail.com', '#2563eb', 'syncing', 1)").run();
  db.prepare("INSERT INTO accounts(id, email, color, status, created_at) VALUES ('b', 'work@gmail.com', '#16a34a', 'syncing', 2)").run();
  const clock = { now: NOW };
  const a = createFakeGmail('me@gmail.com', { now: () => clock.now });
  const b = createFakeGmail('work@gmail.com', { now: () => clock.now });
  for (const t of inboxFixtures(NOW)) a.addThread(t);
  a.addThread({ id: 's-prize', messages: [{ from: 'Prize Dept <win@lottery.example>', subject: 'You won', snippet: 'Claim now', date: NOW - 2 * HOUR, labelIds: ['SPAM', 'UNREAD'], html: '<p>Claim</p><img src="https://track.example/p.gif">' }] });
  a.addThread({ id: 's-old', messages: [{ from: 'Pills <pills@spam.example>', subject: 'Cheap pills', date: NOW - 3 * DAY, labelIds: ['SPAM'], attachments: [{ filename: 'invoice.exe', mimeType: 'application/x-msdownload', data: 'MZ' }] }] });
  b.addThread({ id: 's-crypto', messages: [{ from: 'Crypto <hi@coin.example>', subject: 'Double your coins', date: NOW - HOUR, labelIds: ['SPAM', 'UNREAD', 'CATEGORY_PROMOTIONS'] }] });
  const gmailFor = vi.fn((accountId: string) => (accountId === 'a' ? a : b));
  const hook = makeThreadHook({ db, gmailFor, now: () => clock.now, log });
  const poller = createPoller({ db, gmailFor, intervalMs: 30_000, onChange: hook, log });
  const tick = async () => {
    await poller.tick();
    await hook.idle();
  };
  await tick();
  a.calls.modifyThread.length = 0; // the first sync's group labels
  gmailFor.mockClear();
  const deps: AppDeps = { db, config: { ownerEmail: 'me@gmail.com' } as AppConfig, gmailFor, now: () => clock.now, onThreadChange: hook, storage: ALLOW_ALL };
  const events: ServerEvent[] = [];
  const off = bus.subscribe((e) => void events.push(e));
  return { db, a, b, clock, deps, hook, tick, events, off };
}

describe('reportSpam', () => {
  it('adds SPAM and removes INBOX in Gmail, drops the thread from the index and publishes thread.removed', async () => {
    const { db, a, deps, events, off } = await setup();
    const res = await reportSpam(deps, ID);
    off();

    expect(res).toEqual({ undoId: expect.any(String), thread: null });
    expect(a.calls.modifyThread.at(-1)).toEqual([GITHUB, ['SPAM'], ['INBOX']]);
    expect(a.threadLabels(GITHUB)).toContain('SPAM');
    expect(a.threadLabels(GITHUB)).not.toContain('INBOX');
    expect(db.prepare('SELECT count(*) FROM threads WHERE id = ?').pluck().get(ID)).toBe(0);
    expect(db.prepare('SELECT count(*) FROM messages WHERE thread_id = ?').pluck().get(ID)).toBe(0);
    expect(events).toContainEqual({ type: 'thread.removed', id: ID });
  });

  it('takes SuperMail/Snoozed off a snoozed thread and the cascade clears its snooze and override', async () => {
    const { db, a, deps } = await setup();
    await moveToGroup(deps, ID, 'low_priority');
    await snooze(deps, ID, NOW + DAY);
    const snoozed = a.labelId(SNOOZED_LABEL)!;
    await reportSpam(deps, ID);
    expect(a.threadLabels(GITHUB)).not.toContain(snoozed);
    expect(a.threadLabels(GITHUB)).toContain('SPAM');
    expect(count(db, 'snoozes')).toBe(0);
    expect(count(db, 'overrides')).toBe(0);
  });

  it('works on a Done thread', async () => {
    const { db, a, deps } = await setup();
    await done(deps, ID);
    await reportSpam(deps, ID);
    expect(a.threadLabels(GITHUB)).toContain('SPAM');
    expect(db.prepare('SELECT count(*) FROM threads WHERE id = ?').pluck().get(ID)).toBe(0);
  });

  it('creates no rule and no mark: reporting teaches Gmail, not SuperMail', async () => {
    const { db, deps } = await setup();
    const rules = count(db, 'rules');
    const marks = count(db, 'sender_marks');
    const { undoId } = await reportSpam(deps, ID);
    await undo(deps, undoId);
    expect(count(db, 'rules')).toBe(rules);
    expect(count(db, 'sender_marks')).toBe(marks);
  });

  it('changes nothing in the index when Gmail refuses', async () => {
    const { db, a, deps } = await setup();
    vi.spyOn(a, 'modifyThread').mockRejectedValueOnce(new Error('Gmail is down'));
    await expect(reportSpam(deps, ID)).rejects.toThrow('Gmail is down');
    expect(toSummary(db, ID).inInbox).toBe(true);
  });

  it('is 404 for a thread the index does not have', async () => {
    const { deps } = await setup();
    await expect(reportSpam(deps, 'a:nope')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('stays out of the index when the poller sees the label change', async () => {
    const { db, deps, tick } = await setup();
    await reportSpam(deps, ID);
    await tick();
    expect(db.prepare('SELECT count(*) FROM threads WHERE id = ?').pluck().get(ID)).toBe(0);
  });
});

describe('undo of a spam report', () => {
  it('takes SPAM off, puts it back in the inbox and the index, and publishes thread.updated', async () => {
    const { db, a, deps, events, off } = await setup();
    const group = toSummary(db, ID).groupId;
    const { undoId } = await reportSpam(deps, ID);
    const res = await undo(deps, undoId);
    off();

    expect(a.threadLabels(GITHUB)).toContain('INBOX');
    expect(a.threadLabels(GITHUB)).not.toContain('SPAM');
    expect(res.thread).toMatchObject({ id: ID, inInbox: true, groupId: group });
    expect(listInbox(db, {}).threads.map((t) => t.id)).toContain(ID);
    expect(events.some((e) => e.type === 'thread.updated' && e.thread.id === ID)).toBe(true);
  });

  it('restores the snooze, with its label in Gmail, and does not put the thread in the inbox', async () => {
    const { db, a, deps, tick } = await setup();
    await snooze(deps, ID, NOW + DAY);
    const { undoId } = await reportSpam(deps, ID);
    const res = await undo(deps, undoId);

    expect(res.thread).toMatchObject({ id: ID, inInbox: false, snoozedUntil: NOW + DAY });
    expect(a.threadLabels(GITHUB)).toContain(a.labelId(SNOOZED_LABEL)!);
    expect(a.threadLabels(GITHUB)).not.toContain('INBOX');
    await tick(); // the poller must not take the snooze for one the owner removed
    expect(db.prepare('SELECT until FROM snoozes WHERE thread_id = ?').pluck().get(ID)).toBe(NOW + DAY);
  });

  it('keeps a Done thread Done, with its original time', async () => {
    const { a, clock, deps } = await setup();
    await done(deps, ID);
    clock.now += HOUR;
    const { undoId } = await reportSpam(deps, ID);
    const res = await undo(deps, undoId);
    expect(res.thread).toMatchObject({ inInbox: false, doneAt: NOW });
    expect(a.threadLabels(GITHUB)).not.toContain('INBOX');
    expect(a.threadLabels(GITHUB)).not.toContain('SPAM');
  });

  it('keeps a hand-moved thread in its group', async () => {
    const { deps } = await setup();
    await moveToGroup(deps, ID, 'low_priority');
    const { undoId } = await reportSpam(deps, ID);
    const res = await undo(deps, undoId);
    expect(res.thread).toMatchObject({ groupId: 'low_priority', reason: { source: 'override' } });
  });

  it('gives an undo id that reports it again, and that one undoes again', async () => {
    const { db, a, deps } = await setup();
    const first = await reportSpam(deps, ID);
    const back = await undo(deps, first.undoId);
    const again = await undo(deps, back.undoId);
    expect(again.thread).toBeNull();
    expect(a.threadLabels(GITHUB)).toContain('SPAM');
    expect(db.prepare('SELECT count(*) FROM threads WHERE id = ?').pluck().get(ID)).toBe(0);
    expect((await undo(deps, again.undoId)).thread).toMatchObject({ id: ID, inInbox: true });
  });

  it('is 404 when the thread has since been deleted in Gmail', async () => {
    const { a, deps } = await setup();
    const { undoId } = await reportSpam(deps, ID);
    a.deleteThread(GITHUB);
    await expect(undo(deps, undoId)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('listSpam', () => {
  it('merges every account newest first, without touching the index or the body cache', async () => {
    const { db, a, deps } = await setup();
    const before = [count(db, 'threads'), count(db, 'messages'), count(db, 'body_cache')];
    const hook = vi.spyOn(deps, 'onThreadChange');
    const page = await listSpam(deps);

    expect(page.nextCursor).toBeNull();
    expect(page.threads.map((t) => t.id)).toEqual(['b:s-crypto', 'a:s-prize', 'a:s-old']);
    expect(page.threads[1]).toMatchObject({
      accountId: 'a', subject: 'You won', snippet: 'Claim now', fromName: 'Prize Dept', fromEmail: 'win@lottery.example', lastMessageAt: NOW - 2 * HOUR,
      unread: true, inInbox: false, groupId: 'unsorted', groupName: 'Spam', reason: { source: 'default', text: 'In Gmail spam', at: null },
      snoozedUntil: null, suggestRule: false,
    });
    expect(page.threads[2]).toMatchObject({ unread: false, hasAttachments: true });
    expect([count(db, 'threads'), count(db, 'messages'), count(db, 'body_cache')]).toEqual(before);
    expect(hook).not.toHaveBeenCalled();
    expect(a.calls.modifyThread).toEqual([]);
  });

  it('asks each account for 50 threads of in:spam', async () => {
    const { a, deps } = await setup();
    const list = vi.spyOn(a, 'listThreads');
    await listSpam(deps);
    expect(list).toHaveBeenCalledWith({ q: 'in:spam', maxResults: 50 });
  });

  it('orders by when Gmail received it, so a forged Date header cannot float to the top', async () => {
    const { a, deps } = await setup();
    a.addThread({ id: 's-forged', messages: [{ from: 'x@y.example', subject: 'From the future', date: NOW - 10 * DAY, labelIds: ['SPAM'], headers: { Date: 'Sat, 1 Jan 2028 00:00:00 +0000' } }] });
    // The fake's own Date header comes first in a lookup, so forge it the way a real message arrives.
    const get = a.getThread.bind(a);
    vi.spyOn(a, 'getThread').mockImplementation(async (id, format) => {
      const t = await get(id, format);
      if (id !== 's-forged') return t;
      return { ...t, messages: t.messages?.map((m) => ({ ...m, payload: { ...m.payload, headers: m.payload?.headers?.map((h) => (h.name === 'Date' ? { ...h, value: 'Sat, 1 Jan 2028 00:00:00 +0000' } : h)) } })) };
    });
    const page = await listSpam(deps);
    expect(page.threads.at(-1)).toMatchObject({ id: 'a:s-forged', lastMessageAt: NOW - 10 * DAY });
  });

  it('leaves out an account that fails', async () => {
    const { a, deps } = await setup();
    vi.spyOn(a, 'listThreads').mockRejectedValue(new Error('Gmail is down'));
    expect((await listSpam(deps)).threads.map((t) => t.id)).toEqual(['b:s-crypto']);
  });

  it('skips a thread Gmail deleted between the list and the fetch', async () => {
    const { a, deps } = await setup();
    const get = a.getThread.bind(a);
    vi.spyOn(a, 'getThread').mockImplementation((id, format) => (id === 's-old' ? Promise.reject(Object.assign(new Error('gone'), { code: 404 })) : get(id, format)));
    expect((await listSpam(deps)).threads.map((t) => t.id)).toEqual(['b:s-crypto', 'a:s-prize']);
  });

  it('returns the error when every account fails', async () => {
    const { a, b, deps } = await setup();
    vi.spyOn(a, 'listThreads').mockRejectedValue(new Error('Gmail is down'));
    vi.spyOn(b, 'listThreads').mockRejectedValue(new Error('Gmail is down too'));
    await expect(listSpam(deps)).rejects.toThrow('Gmail is down');
  });

  it('skips an account in reconnect_needed, and a revoked one is flipped and left out', async () => {
    const { db, a, deps } = await setup();
    db.prepare("UPDATE accounts SET status = 'reconnect_needed' WHERE id = 'b'").run();
    expect((await listSpam(deps)).threads.map((t) => t.accountId)).toEqual(['a', 'a']);
    expect(deps.gmailFor).not.toHaveBeenCalledWith('b');

    db.prepare("UPDATE accounts SET status = 'ok' WHERE id = 'b'").run();
    a.revoke();
    const later = deps.now() + 10_000;
    deps.now = () => later; // past the cached read
    expect((await listSpam(deps)).threads.map((t) => t.id)).toEqual(['b:s-crypto']);
    expect(db.prepare("SELECT status FROM accounts WHERE id = 'a'").pluck().get()).toBe('reconnect_needed');
  });

  it('is an error, not an empty list, when no account can be read', async () => {
    const { db, deps } = await setup();
    db.prepare("UPDATE accounts SET status = 'reconnect_needed'").run();
    await expect(listSpam(deps)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('is an empty page with no accounts connected', async () => {
    const { db, deps } = await setup();
    db.prepare('DELETE FROM accounts').run();
    expect(await listSpam(deps)).toEqual({ threads: [], nextCursor: null });
  });

  it('shows only the spam of a thread that also holds normal mail', async () => {
    const { a, deps } = await setup();
    a.addThread({ id: 's-mixed', messages: [
      { from: 'Ana <ana@friends.ro>', subject: 'Real', snippet: 'Real mail', date: NOW - 4 * DAY, labelIds: ['INBOX'] },
      { from: 'Junk <junk@spam.example>', subject: 'Fake', snippet: 'Junk mail', date: NOW - 4 * DAY + 1000, labelIds: ['SPAM'] },
    ] });
    expect((await listSpam(deps)).threads.find((t) => t.id === 'a:s-mixed')).toMatchObject({ subject: 'Fake', snippet: 'Junk mail', fromEmail: 'junk@spam.example' });
  });
});

describe('getSpamThread', () => {
  it('reads the thread live in full format and stores nothing', async () => {
    const { db, a, deps } = await setup();
    const before = [count(db, 'threads'), count(db, 'messages'), count(db, 'body_cache')];
    const detail = await getSpamThread(deps, 'a:s-prize');

    expect(detail.thread).toMatchObject({ id: 'a:s-prize', groupName: 'Spam', reason: { text: 'In Gmail spam' }, inInbox: false });
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages[0]).toMatchObject({ subject: 'You won', from: { name: 'Prize Dept', email: 'win@lottery.example' } });
    expect(detail.messages[0]!.html).toContain('<img src="https://track.example/p.gif">');
    expect([count(db, 'threads'), count(db, 'messages'), count(db, 'body_cache')]).toEqual(before);
    expect(a.calls.modifyThread).toEqual([]); // nothing marked read
    expect(a.threadLabels('s-prize')).toContain('UNREAD');
  });

  it('lists attachment names', async () => {
    const { deps } = await setup();
    const detail = await getSpamThread(deps, 'a:s-old');
    expect(detail.messages[0]!.attachments).toMatchObject([{ filename: 'invoice.exe', mimeType: 'application/x-msdownload' }]);
  });

  it('is 404 once the thread is out of spam, for any thread not in spam, and for a bad id', async () => {
    const { a, deps } = await setup();
    a.setLabels('s-prize', ['INBOX'], ['SPAM']);
    await expect(getSpamThread(deps, 'a:s-prize')).rejects.toMatchObject({ statusCode: 404 });
    await expect(getSpamThread(deps, ID)).rejects.toMatchObject({ statusCode: 404 });
    await expect(getSpamThread(deps, 'a:gone')).rejects.toMatchObject({ statusCode: 404 });
    await expect(getSpamThread(deps, 'unknown:s-prize')).rejects.toMatchObject({ statusCode: 404 });
    await expect(getSpamThread(deps, 'no-separator')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('asking for a normal thread here leaves it in the index', async () => {
    const { db, deps } = await setup();
    await expect(getSpamThread(deps, ID)).rejects.toMatchObject({ statusCode: 404 });
    await expect(notSpam(deps, ID)).rejects.toMatchObject({ statusCode: 404 });
    expect(toSummary(db, ID).inInbox).toBe(true);
  });

  it('flips a revoked account to reconnect_needed (409)', async () => {
    const { db, a, deps } = await setup();
    a.revoke();
    await expect(getSpamThread(deps, 'a:s-prize')).rejects.toMatchObject({ statusCode: 409 });
    expect(db.prepare("SELECT status FROM accounts WHERE id = 'a'").pluck().get()).toBe('reconnect_needed');
  });
});

describe('notSpam', () => {
  it('moves it to the inbox, indexes, classifies and labels it, and publishes thread.updated', async () => {
    const { db, a, deps, hook, events, off } = await setup();
    a.addThread({ id: 's-news', messages: [{ from: 'GitHub <noreply@github.com>', subject: 'Your build', date: NOW - DAY, labelIds: ['SPAM'] }] });
    const res = await notSpam(deps, 'a:s-news');
    await hook.idle();
    off();

    expect(a.threadLabels('s-news')).toContain('INBOX');
    expect(a.threadLabels('s-news')).not.toContain('SPAM');
    expect(res.thread).toMatchObject({ id: 'a:s-news', inInbox: true, groupId: 'dev' });
    const label = db.prepare("SELECT gmail_label_id FROM group_labels WHERE group_id = 'dev' AND account_id = 'a'").pluck().get() as string;
    expect(a.threadLabels('s-news')).toContain(label);
    expect(events.some((e) => e.type === 'thread.updated' && e.thread.id === 'a:s-news')).toBe(true);
  });

  it('ranks it first in the inbox, like any thread brought back', async () => {
    const { db, deps } = await setup();
    await notSpam(deps, 'a:s-old');
    expect(listInbox(db, { limit: 1 }).threads.map((t) => t.id)).toEqual(['a:s-old']);
  });

  it('undo moves it back to spam and out of the index, and its undo rescues it again', async () => {
    const { db, a, deps } = await setup();
    const { undoId } = await notSpam(deps, 'a:s-prize');
    const res = await undo(deps, undoId);
    expect(res.thread).toBeNull();
    expect(a.threadLabels('s-prize')).toContain('SPAM');
    expect(a.threadLabels('s-prize')).not.toContain('INBOX');
    expect(db.prepare("SELECT count(*) FROM threads WHERE id = 'a:s-prize'").pluck().get()).toBe(0);
    expect((await undo(deps, res.undoId)).thread).toMatchObject({ id: 'a:s-prize', inInbox: true });
  });

  it('is 404 when the thread is no longer in spam', async () => {
    const { a, deps } = await setup();
    a.setLabels('s-prize', [], ['SPAM']);
    await expect(notSpam(deps, 'a:s-prize')).rejects.toMatchObject({ statusCode: 404 });
    expect(a.threadLabels('s-prize')).not.toContain('INBOX');
    await expect(notSpam(deps, 'a:gone')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('teaches nothing', async () => {
    const { db, deps } = await setup();
    const taught = [count(db, 'rules'), count(db, 'sender_marks')];
    await notSpam(deps, 'a:s-prize');
    expect([count(db, 'rules'), count(db, 'sender_marks')]).toEqual(taught);
  });
});

describe('spam routes', () => {
  async function routes(deps: AppDeps) {
    const guard: RoutePlugin = async (a, d) => {
      a.addHook('preHandler', requireSession(d.db, d.config, d.now));
    };
    const app = await buildApp(deps, [guard, spamRoutes], { webDir: '/nonexistent' });
    apps.push(app);
    return app;
  }
  const signedIn = (deps: AppDeps) => ({ cookie: `${SESSION_COOKIE}=${createSession(deps.db, 'me@gmail.com', NOW)}` });

  it('serve every route with a session, and never let the browser keep a spam body', async () => {
    const { a, deps } = await setup();
    const app = await routes(deps);
    const cookie = signedIn(deps);

    expect(((await app.inject({ url: '/api/spam', headers: cookie })).json() as ThreadPage).threads).toHaveLength(3);
    const one = await app.inject({ url: `/api/spam/${encodeURIComponent('a:s-prize')}`, headers: cookie });
    expect((one.json() as ThreadDetailDTO).thread.id).toBe('a:s-prize');
    expect(one.headers['cache-control']).toBe('no-store');
    const out = await app.inject({ method: 'POST', url: `/api/spam/${encodeURIComponent('a:s-prize')}/not-spam`, headers: { ...cookie, [API_HEADER]: '1' } });
    expect((out.json() as ActionResult).thread).toMatchObject({ id: 'a:s-prize', inInbox: true });
    const report = await app.inject({ method: 'POST', url: `/api/threads/${encodeURIComponent(ID)}/spam`, headers: { ...cookie, [API_HEADER]: '1' } });
    expect((report.json() as ActionResult).thread).toBeNull();
    expect(a.threadLabels(GITHUB)).toContain('SPAM');
  });

  it('all need a session', async () => {
    const { deps } = await setup();
    const app = await routes(deps);
    const post = { [API_HEADER]: '1' };
    for (const url of ['/api/spam', '/api/spam/a%3As-prize', '/api/spam/a.js']) expect((await app.inject({ url })).statusCode).toBe(401);
    for (const url of ['/api/spam/a%3As-prize/not-spam', `/api/threads/${encodeURIComponent(ID)}/spam`]) {
      expect((await app.inject({ method: 'POST', url, headers: post })).statusCode).toBe(401);
    }
  });

  it('writes need the x-supermail header', async () => {
    const { deps } = await setup();
    const app = await routes(deps);
    const cookie = signedIn(deps);
    for (const url of ['/api/spam/a%3As-prize/not-spam', `/api/threads/${encodeURIComponent(ID)}/spam`]) {
      expect((await app.inject({ method: 'POST', url, headers: cookie })).statusCode).toBe(403);
    }
  });

  it('answer 404 for a thread out of spam', async () => {
    const { deps } = await setup();
    const app = await routes(deps);
    expect((await app.inject({ url: `/api/spam/${encodeURIComponent(ID)}`, headers: signedIn(deps) })).statusCode).toBe(404);
  });

  it('never serve a spam attachment: the attachment route only knows indexed mail', async () => {
    const { deps } = await setup();
    const app = await buildApp(deps, [mailRoutes], { webDir: '/nonexistent' });
    apps.push(app);
    const m = (await getSpamThread(deps, 'a:s-old')).messages[0]!;
    const res = await app.inject({ url: `/api/attachments/a/${m.gmailMessageId}/${m.attachments[0]!.attachmentId}` });
    expect(res.statusCode).toBe(404);
  });
});
