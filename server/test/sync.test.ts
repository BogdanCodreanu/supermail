import { google } from 'googleapis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db/index.js';
import { GmailAuthRevoked, GmailHistoryExpired, GmailLabelExists } from '../src/google/gmailApi.js';
import { createGmailApi, GMAIL_CONCURRENCY, gmailForFactory, type OAuth2Client } from '../src/google/gmailClient.js';
import { backfillStep, initialSync, isNotFound } from '../src/sync/initialSync.js';
import { createPoller } from '../src/sync/poller.js';
import { createFakeGmail, type FakeGmail } from './fakes/fakeGmail.js';
import { allFixtures, DAY, FIXTURE_IDS, inboxFixtures } from './fixtures/threads.js';

const NOW = Date.UTC(2026, 9, 29, 10, 0, 0);

function addAccount(db: DB, id: string, email: string): void {
  db.prepare("INSERT INTO accounts(id, email, color, status, created_at) VALUES (?, ?, '#2563eb', 'syncing', 1)").run(id, email);
}

function account(db: DB, id: string) {
  return db.prepare('SELECT status, history_id, backfill_done, backfill_page_token FROM accounts WHERE id = ?').get(id) as {
    status: string; history_id: string | null; backfill_done: number; backfill_page_token: string | null;
  };
}

const count = (db: DB, sql: string, ...p: unknown[]) => db.prepare(sql).pluck().get(...p) as number;

describe('initial sync', () => {
  let db: DB;
  let gmail: FakeGmail;
  beforeEach(() => {
    db = openDb(':memory:');
    addAccount(db, 'a', 'me@gmail.com');
    gmail = createFakeGmail('me@gmail.com', { now: () => NOW });
    for (const t of allFixtures(NOW)) gmail.addThread(t);
  });

  it('runs on the first tick for a freshly connected account', async () => {
    const poller = createPoller({ db, gmailFor: () => gmail, intervalMs: 30_000 });
    expect(account(db, 'a')).toMatchObject({ status: 'syncing', history_id: null });
    await poller.tick();
    expect(account(db, 'a')).toMatchObject({ status: 'ok', history_id: String(gmail.currentHistoryId()) });
    expect(gmail.calls.all).toContain('getProfile');
    expect(count(db, 'SELECT count(*) FROM threads WHERE in_inbox = 1')).toBe(inboxFixtures(NOW).length);
  });

  it('indexes the inbox and the last 90 days, stores history_id and marks the account ok', async () => {
    await initialSync(db, 'a', gmail);
    expect(account(db, 'a')).toMatchObject({ status: 'ok', history_id: String(gmail.currentHistoryId()) });
    for (const t of inboxFixtures(NOW)) {
      expect(db.prepare('SELECT in_inbox FROM threads WHERE id = ?').pluck().get(`a:${t.id}`)).toBe(1);
    }
    expect(db.prepare('SELECT in_inbox FROM threads WHERE id = ?').pluck().get(`a:${FIXTURE_IDS.archivedRecent}`)).toBe(0);
    // Older than 90 days and archived: left to backfill.
    expect(count(db, 'SELECT count(*) FROM threads WHERE id = ?', `a:${FIXTURE_IDS.archivedOld}`)).toBe(0);
  });

  it('stores thread fields from the parsed messages', async () => {
    await initialSync(db, 'a', gmail);
    const bolt = db.prepare('SELECT * FROM threads WHERE id = ?').get(`a:${FIXTURE_IDS.bolt}`) as Record<string, unknown>;
    expect(bolt).toMatchObject({
      account_id: 'a', gmail_thread_id: FIXTURE_IDS.bolt, subject: 'Your Bolt Scooter ride', from_name: 'Bolt',
      from_email: 'receipts@bolt.eu', last_message_at: NOW - 7 * 3_600_000, unread: 0, in_inbox: 1, has_attachments: 1, is_sent_only: 0,
    });
    const m = db.prepare('SELECT * FROM messages WHERE thread_id = ?').get(`a:${FIXTURE_IDS.bookstore}`) as Record<string, unknown>;
    expect(m).toMatchObject({ list_id: 'newsletter.librariacetatii.example', has_list_unsubscribe: 1, account_id: 'a' });
    expect(JSON.parse(m.label_ids_json as string)).toContain('INBOX');
  });

  it('is idempotent: running twice gives the same threads and messages', async () => {
    await initialSync(db, 'a', gmail);
    const threads = count(db, 'SELECT count(*) FROM threads');
    const messages = count(db, 'SELECT count(*) FROM messages');
    await initialSync(db, 'a', gmail);
    expect(count(db, 'SELECT count(*) FROM threads')).toBe(threads);
    expect(count(db, 'SELECT count(*) FROM messages')).toBe(messages);
    expect(threads).toBe(inboxFixtures(NOW).length + 1);
  });

  it('stores history_id before indexing, so mail arriving mid-sync is picked up by the next history poll', async () => {
    const before = gmail.currentHistoryId();
    const original = gmail.listThreads.bind(gmail);
    let delivered = false;
    gmail.listThreads = async (p) => {
      if (!delivered) {
        delivered = true;
        gmail.deliver('mid-sync', { from: 'x@y.com', subject: 'during sync', date: NOW });
      }
      return original(p);
    };
    await initialSync(db, 'a', gmail);
    expect(account(db, 'a').history_id).toBe(String(before));
  });

  it('refreshes threads the index thinks are in the inbox but Gmail no longer lists there', async () => {
    gmail.addThread({ id: 'old-inbox', messages: [{ from: 'x@y.com', subject: 'old', date: NOW - 300 * DAY }] });
    await initialSync(db, 'a', gmail);
    expect(db.prepare('SELECT in_inbox FROM threads WHERE id = ?').pluck().get('a:old-inbox')).toBe(1);
    gmail.setLabels('old-inbox', [], ['INBOX']);
    await initialSync(db, 'a', gmail);
    expect(db.prepare('SELECT in_inbox FROM threads WHERE id = ?').pluck().get('a:old-inbox')).toBe(0);
  });
});

describe('backfillStep', () => {
  let db: DB;
  let gmail: FakeGmail;
  beforeEach(async () => {
    db = openDb(':memory:');
    addAccount(db, 'a', 'me@gmail.com');
    gmail = createFakeGmail('me@gmail.com', { now: () => NOW });
    for (const t of allFixtures(NOW)) gmail.addThread(t);
    await initialSync(db, 'a', gmail);
  });

  it('indexes nothing when canIndexMore returns false', async () => {
    const before = count(db, 'SELECT count(*) FROM threads');
    const calls = gmail.calls.all.length;
    expect(await backfillStep(db, 'a', gmail, () => false)).toBe(false);
    expect(count(db, 'SELECT count(*) FROM threads')).toBe(before);
    expect(gmail.calls.all.length).toBe(calls);
    expect(account(db, 'a').backfill_done).toBe(0);
  });

  it('indexes older threads page by page, resumes from the stored page token, then finishes', async () => {
    for (let i = 0; i < 150; i++) {
      gmail.addThread({ id: `old-${i}`, messages: [{ from: 'x@y.com', subject: `old ${i}`, date: NOW - (100 + i) * DAY, labelIds: [] }] });
    }
    expect(await backfillStep(db, 'a', gmail, () => true)).toBe(true);
    expect(account(db, 'a').backfill_page_token).not.toBeNull();
    expect(count(db, "SELECT count(*) FROM threads WHERE gmail_thread_id LIKE 'old-%'")).toBe(100);

    expect(await backfillStep(db, 'a', gmail, () => true)).toBe(false);
    expect(account(db, 'a')).toMatchObject({ backfill_done: 1, backfill_page_token: null });
    expect(count(db, "SELECT count(*) FROM threads WHERE gmail_thread_id LIKE 'old-%'")).toBe(150);
    expect(count(db, 'SELECT count(*) FROM threads WHERE id = ?', `a:${FIXTURE_IDS.archivedOld}`)).toBe(1);

    const calls = gmail.calls.all.length;
    expect(await backfillStep(db, 'a', gmail, () => true)).toBe(false);
    expect(gmail.calls.all.length).toBe(calls);
  });
});

describe('Gmail client', () => {
  function httpError(status: number, data: unknown = {}, message = `HTTP ${status}`) {
    return Object.assign(new Error(message), { status, response: { status, data } });
  }

  /** An OAuth2 client whose HTTP layer is replaced by `handler`. */
  function stubAuth(handler: (opts: { url: string; method?: string; params?: Record<string, unknown> }) => Promise<unknown>): OAuth2Client {
    const auth = new google.auth.OAuth2();
    (auth as unknown as { request: typeof handler }).request = handler;
    return auth;
  }

  it('maps a 404 from history.list to GmailHistoryExpired', async () => {
    const api = createGmailApi(stubAuth(async () => { throw httpError(404); }));
    await expect(api.listHistory('123')).rejects.toBeInstanceOf(GmailHistoryExpired);
  });

  it('keeps a 404 from threads.get as a not-found error', async () => {
    const api = createGmailApi(stubAuth(async () => { throw httpError(404); }));
    const err = await api.getThread('t', 'metadata').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(GmailHistoryExpired);
    expect(isNotFound(err)).toBe(true);
  });

  it.each([
    ['invalid_grant from the token refresh', Object.assign(new Error('invalid_grant'), { response: { status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } } })],
    ['a 401 after refresh', httpError(401)],
    ['missing Gmail scope', httpError(403, { error: { message: 'Request had insufficient authentication scopes.' } }, 'Request had insufficient authentication scopes.')],
  ])('maps %s to GmailAuthRevoked', async (_label, error) => {
    const api = createGmailApi(stubAuth(async () => { throw error; }));
    await expect(api.getProfile()).rejects.toBeInstanceOf(GmailAuthRevoked);
    await expect(api.listHistory('1')).rejects.toBeInstanceOf(GmailAuthRevoked);
  });

  it('maps a 409 from labels.create to GmailLabelExists and passes other errors through', async () => {
    const api = createGmailApi(stubAuth(async () => { throw httpError(409); }));
    await expect(api.createLabel('SuperMail/Dev')).rejects.toBeInstanceOf(GmailLabelExists);
    const other = createGmailApi(stubAuth(async () => { throw httpError(503); }));
    await expect(other.createLabel('SuperMail/Dev')).rejects.toMatchObject({ status: 503 });
  });

  it('requests metadata with the metadata headers and maps list results', async () => {
    const params: Record<string, unknown>[] = [];
    const api = createGmailApi(stubAuth(async (opts) => {
      params.push(opts.params ?? {});
      if (opts.url.includes('/threads/')) return { data: { id: 't1', messages: [] } };
      return { data: { threads: [{ id: 'a' }, { id: 'b' }] } };
    }));
    expect(await api.listThreads({ q: 'in:inbox' })).toEqual({ ids: ['a', 'b'] });
    await api.getThread('t1', 'metadata');
    expect(params[0]).toMatchObject({ q: 'in:inbox' });
    expect(params[1]).toMatchObject({ format: 'metadata', metadataHeaders: expect.arrayContaining(['List-Id', 'List-Unsubscribe', 'From']) });
  });

  it(`never has more than ${GMAIL_CONCURRENCY} requests in flight`, async () => {
    let active = 0;
    let peak = 0;
    const api = createGmailApi(stubAuth(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { data: { id: 't', messages: [] } };
    }));
    await Promise.all(Array.from({ length: 12 }, (_, i) => api.getThread(`t${i}`, 'metadata')));
    expect(peak).toBe(GMAIL_CONCURRENCY);
  });

  describe('gmailForFactory', () => {
    const cfg = { publicUrl: 'http://localhost:8787' } as AppConfig;
    let db: DB;
    beforeEach(() => {
      db = openDb(':memory:');
      db.prepare("INSERT INTO accounts(id, email, color, token_enc, created_at) VALUES ('a', 'me@gmail.com', '#2563eb', x'01', 1)").run();
      db.prepare("INSERT INTO accounts(id, email, color, created_at) VALUES ('b', 'no-token@gmail.com', '#16a34a', 1)").run();
    });

    it('caches one client per account and rebuilds it when the stored token changes', () => {
      const getRefreshToken = vi.fn(() => 'rt');
      const oauthClient = vi.fn(() => new google.auth.OAuth2());
      const gmailFor = gmailForFactory(db, cfg, Buffer.alloc(32), { getRefreshToken, oauthClient });
      const first = gmailFor('a');
      expect(gmailFor('a')).toBe(first);
      expect(getRefreshToken).toHaveBeenCalledTimes(1);
      expect(getRefreshToken).toHaveBeenCalledWith(db, expect.any(Buffer), 'a');
      expect(oauthClient).toHaveBeenCalledWith(cfg);

      db.prepare("UPDATE accounts SET token_enc = x'02' WHERE id = 'a'").run(); // reconnected
      expect(gmailFor('a')).not.toBe(first);
      expect(getRefreshToken).toHaveBeenCalledTimes(2);
    });

    it('treats an account without a token as needing reconnect', () => {
      const gmailFor = gmailForFactory(db, cfg, Buffer.alloc(32), { getRefreshToken: () => 'rt', oauthClient: () => new google.auth.OAuth2() });
      expect(() => gmailFor('b')).toThrow(GmailAuthRevoked);
      expect(() => gmailFor('missing')).toThrow(/unknown account/);
    });
  });
});

describe('fake Gmail (used by later tasks)', () => {
  it('supports the q forms the sync and skipped views use', async () => {
    const g = createFakeGmail('me@gmail.com', { now: () => NOW });
    g.addThread({ id: 'inbox-new', messages: [{ from: 'a@x.com', subject: 'a', date: NOW - DAY }] });
    g.addThread({ id: 'archived-new', messages: [{ from: 'b@x.com', subject: 'b', date: NOW - 3 * DAY, labelIds: ['[superhuman]/ai/autoarchived'] }] });
    g.addThread({ id: 'archived-old', messages: [{ from: 'c@x.com', subject: 'c', date: NOW - 40 * DAY, labelIds: [] }] });
    g.addThread({ id: 'sent', messages: [{ from: 'me@gmail.com', subject: 'd', date: NOW - DAY, labelIds: ['SENT'] }] });
    g.addThread({ id: 'spam', messages: [{ from: 'e@x.com', subject: 'e', date: NOW - DAY, labelIds: ['SPAM'] }] });
    const ids = async (q: string) => (await g.listThreads({ q })).ids.sort();
    expect(await ids('in:inbox')).toEqual(['inbox-new']);
    expect(await ids('newer_than:30d')).toEqual(['archived-new', 'inbox-new', 'sent']);
    expect(await ids('older_than:30d')).toEqual(['archived-old']);
    expect(await ids('-in:inbox -in:sent newer_than:30d')).toEqual(['archived-new']);
    expect(await ids('in:spam')).toEqual(['spam']);
  });

  it('keeps an incrementing historyId and a history log of every change', async () => {
    const g = createFakeGmail('me@gmail.com', { now: () => NOW });
    g.addThread({ id: 't', messages: [{ from: 'a@x.com', subject: 'a' }] });
    const start = (await g.getProfile()).historyId;
    const m2 = g.deliver('t', { from: 'b@x.com', subject: 'Re: a' });
    await g.modifyThread('t', ['SuperMail/Dev'], ['UNREAD']);
    g.deleteMessage(m2);
    const { history, historyId } = await g.listHistory(start);
    expect(Number(historyId)).toBe(Number(start) + 3);
    expect(history.map((h) => Object.keys(h).filter((k) => k !== 'id' && k !== 'messages').sort())).toEqual([
      ['messagesAdded'], ['labelsAdded', 'labelsRemoved'], ['messagesDeleted'],
    ]);
    expect(g.calls.modifyThread).toEqual([['t', ['SuperMail/Dev'], ['UNREAD']]]);
    expect((await g.listLabels()).some((l) => l.name === 'SuperMail/Dev' && l.type === 'user')).toBe(true);
    await expect(g.createLabel('SuperMail/Dev')).rejects.toBeInstanceOf(GmailLabelExists);
    g.expireHistory();
    await expect(g.listHistory(start)).rejects.toBeInstanceOf(GmailHistoryExpired);
    g.revoke();
    await expect(g.getProfile()).rejects.toBeInstanceOf(GmailAuthRevoked);
  });
});
