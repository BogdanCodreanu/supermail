import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ThreadDetailDTO } from '@supermail/shared';
import type { AppConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db/index.js';
import { ALLOW_ALL, type AppDeps, buildApp, NOOP_HOOK } from '../src/http/app.js';
import { mailRoutes } from '../src/http/routes/mail.js';
import { getThreadDetail, MAX_CACHED_BODY_BYTES } from '../src/mail/bodies.js';
import { indexThread } from '../src/sync/indexer.js';
import { createFakeGmail, type FakeGmail, type FakeThread } from './fakes/fakeGmail.js';
import { FIXTURE_IDS, HOUR, inboxFixtures } from './fixtures/threads.js';

const NOW = Date.UTC(2026, 9, 29, 10, 0, 0);
const OWN = new Set(['me@gmail.com']);

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

const getThreadCalls = (g: FakeGmail) => g.calls.all.filter((c) => c === 'getThread').length;
const cacheRows = (db: DB) => db.prepare('SELECT count(*) FROM body_cache').pluck().get() as number;

describe('thread detail and body cache', () => {
  let db: DB;
  let gmail: FakeGmail;
  let deps: AppDeps;
  let app: FastifyInstance | undefined;

  async function addIndexed(t: FakeThread): Promise<string> {
    gmail.addThread(t);
    const id = indexThread(db, 'a', await gmail.getThread(t.id, 'metadata'), OWN, undefined, 'sync');
    gmail.calls.all.length = 0;
    return id;
  }

  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare("INSERT INTO accounts(id, email, color, status, created_at) VALUES ('a', 'me@gmail.com', '#2563eb', 'ok', 1)").run();
    gmail = createFakeGmail('me@gmail.com', { now: () => NOW });
    deps = { db, config, gmailFor: () => gmail, now: () => NOW, onThreadChange: NOOP_HOOK, storage: ALLOW_ALL };
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('fetches the full thread on the first open and serves the second from the cache', async () => {
    const id = await addIndexed(inboxFixtures(NOW).find((t) => t.id === FIXTURE_IDS.bolt)!);

    const first = await getThreadDetail(deps, id);
    expect(getThreadCalls(gmail)).toBe(1);
    expect(first.thread).toMatchObject({ id, subject: 'Your Bolt Scooter ride', hasAttachments: true });
    expect(first.messages).toHaveLength(1);
    const m = first.messages[0]!;
    expect(m).toMatchObject({ id: `a:${m.gmailMessageId}`, from: { name: 'Bolt', email: 'receipts@bolt.eu' }, subject: 'Your Bolt Scooter ride' });
    expect(m.text).toContain('Thanks for riding with Bolt');
    expect(m.attachments).toEqual([expect.objectContaining({ filename: 'receipt.pdf', mimeType: 'application/pdf', size: 13 })]);
    expect(cacheRows(db)).toBe(1);

    const second = await getThreadDetail(deps, id);
    expect(getThreadCalls(gmail)).toBe(1);
    expect(second.messages).toEqual(first.messages);
  });

  it('prefers html, keeps the text alternative, and returns messages oldest first', async () => {
    const id = await addIndexed({
      id: 't-html',
      messages: [
        { from: 'Ana <ana@friends.ro>', subject: 'Plans', date: NOW - 2 * HOUR, html: '<p>Hello <b>there</b></p>', text: 'Hello there' },
        { from: 'Me <me@gmail.com>', subject: 'Re: Plans', date: NOW - HOUR, text: 'Sounds good', labelIds: ['SENT'] },
      ],
    });
    const d = await getThreadDetail(deps, id);
    expect(d.messages.map((m) => m.text)).toEqual(['Hello there', 'Sounds good']);
    expect(d.messages[0]!.html).toBe('<p>Hello <b>there</b></p>');
    expect(d.messages[1]!.html).toBeNull();
  });

  it('fetches again when the poller indexed a message that is not cached yet', async () => {
    const id = await addIndexed({ id: 't-grow', messages: [{ from: 'Ana <ana@friends.ro>', subject: 'Plans', date: NOW - HOUR, text: 'one' }] });
    await getThreadDetail(deps, id);
    gmail.deliver('t-grow', { from: 'Ana <ana@friends.ro>', subject: 'Re: Plans', date: NOW, text: 'two' });
    indexThread(db, 'a', await gmail.getThread('t-grow', 'metadata'), OWN, undefined, 'live'); // what the poller does
    gmail.calls.all.length = 0;

    const d = await getThreadDetail(deps, id);
    expect(getThreadCalls(gmail)).toBe(1);
    expect(d.messages.map((m) => m.text)).toEqual(['one', 'two']);
    expect(cacheRows(db)).toBe(2);
  });

  it('Review Focus 5: a 5 MB html body is returned but not cached', async () => {
    const huge = `<div>${'x'.repeat(5 * 1024 * 1024)}</div>`;
    expect(huge.length).toBeGreaterThan(MAX_CACHED_BODY_BYTES);
    const id = await addIndexed({ id: 't-huge', messages: [{ from: 'Spam <s@spam.example>', subject: 'Huge', date: NOW, html: huge }] });

    const d = await getThreadDetail(deps, id);
    expect(d.messages[0]!.html).toBe(huge);
    expect(cacheRows(db)).toBe(0);

    await getThreadDetail(deps, id);
    expect(getThreadCalls(gmail)).toBe(2); // not cached, so fetched again
  });

  it('does not cache bodies when storage says no', async () => {
    deps.storage = { canIndexMore: () => true, canCacheBodies: () => false };
    const id = await addIndexed({ id: 't-nocache', messages: [{ from: 'Ana <ana@friends.ro>', subject: 'Hi', date: NOW, text: 'hi' }] });
    expect((await getThreadDetail(deps, id)).messages[0]!.text).toBe('hi');
    expect(cacheRows(db)).toBe(0);
  });

  it('updates last_accessed_at on a cache hit', async () => {
    const id = await addIndexed({ id: 't-access', messages: [{ from: 'Ana <ana@friends.ro>', subject: 'Hi', date: NOW, text: 'hi' }] });
    await getThreadDetail(deps, id);
    deps.now = () => NOW + 60_000;
    await getThreadDetail(deps, id);
    expect(db.prepare('SELECT last_accessed_at FROM body_cache').pluck().get()).toBe(NOW + 60_000);
    expect(db.prepare('SELECT last_accessed_at FROM threads WHERE id = ?').pluck().get(id)).toBe(NOW + 60_000);
  });

  it('404s for an unknown thread', async () => {
    await expect(getThreadDetail(deps, 'a:nope')).rejects.toMatchObject({ statusCode: 404 });
  });

  describe('routes', () => {
    it('GET /api/threads/:id returns hostile html raw, as JSON', async () => {
      const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script><form><input></form>';
      const id = await addIndexed({ id: 't-hostile', messages: [{ from: 'Evil <e@evil.example>', subject: 'Click', date: NOW, html: hostile }] });
      app = await buildApp(deps, [mailRoutes], { webDir: '/nonexistent' });

      const res = await app.inject({ method: 'GET', url: `/api/threads/${encodeURIComponent(id)}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect((res.json() as ThreadDetailDTO).messages[0]!.html).toBe(hostile);
    });

    it('GET /api/attachments opens a PDF inline (no sandbox CSP, which makes Chrome block it) and downloads with ?download=1', async () => {
      const id = await addIndexed(inboxFixtures(NOW).find((t) => t.id === FIXTURE_IDS.bolt)!);
      app = await buildApp(deps, [mailRoutes], { webDir: '/nonexistent' });
      const detail = (await app.inject({ method: 'GET', url: `/api/threads/${encodeURIComponent(id)}` })).json() as ThreadDetailDTO;
      const m = detail.messages[0]!;
      const att = m.attachments[0]!;

      const res = await app.inject({ method: 'GET', url: `/api/attachments/a/${m.gmailMessageId}/${att.attachmentId}` });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('%PDF-1.4 fake');
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toMatch(/^inline;.*filename="receipt\.pdf"/);
      expect(String(res.headers['content-security-policy'] ?? '')).not.toContain('sandbox');
      expect(res.headers['x-content-type-options']).toBe('nosniff');

      const dl = await app.inject({ method: 'GET', url: `/api/attachments/a/${m.gmailMessageId}/${att.attachmentId}?download=1` });
      expect(dl.headers['content-disposition']).toMatch(/^attachment;.*filename="receipt\.pdf"/);
    });

    it('GET /api/attachments always downloads active content (HTML, SVG) under a locked-down CSP', async () => {
      const id = await addIndexed({
        id: 't-svg',
        messages: [{ from: 'X <x@y.ro>', subject: 'Logo', date: NOW, text: 'logo', attachments: [{ filename: 'logo.svg', mimeType: 'image/svg+xml', data: '<svg onload="alert(1)"/>' }] }],
      });
      const m = (await getThreadDetail(deps, id)).messages[0]!;
      app = await buildApp(deps, [mailRoutes], { webDir: '/nonexistent' });
      const res = await app.inject({ method: 'GET', url: `/api/attachments/a/${m.gmailMessageId}/${m.attachments[0]!.attachmentId}` });
      expect(res.headers['content-disposition']).toMatch(/^attachment;/);
      expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('GET /api/attachments matches by ?name= when Gmail has handed out a new attachmentId', async () => {
      deps.storage = { canIndexMore: () => true, canCacheBodies: () => false };
      const id = await addIndexed({
        id: 't-two',
        messages: [{ from: 'Ana <ana@friends.ro>', subject: 'Docs', date: NOW, text: 'two files', attachments: [
          { filename: 'a.pdf', mimeType: 'application/pdf', data: 'AAA' },
          { filename: 'b.png', mimeType: 'image/png', data: 'BBB' },
        ] }],
      });
      const m = (await getThreadDetail(deps, id)).messages[0]!;
      app = await buildApp(deps, [mailRoutes], { webDir: '/nonexistent' });
      const res = await app.inject({ method: 'GET', url: `/api/attachments/a/${m.gmailMessageId}/stale-id?name=${encodeURIComponent('b.png')}` });
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['content-disposition']).toMatch(/^inline;.*filename="b\.png"/);
    });

    it('GET /api/attachments finds the filename even when the body was not cached', async () => {
      deps.storage = { canIndexMore: () => true, canCacheBodies: () => false };
      const id = await addIndexed({
        id: 't-att',
        messages: [{ from: 'Ana <ana@friends.ro>', subject: 'Photo', date: NOW, text: 'see attached', attachments: [{ filename: 'Poză vară.jpg', mimeType: 'image/jpeg', data: 'JPEGDATA' }] }],
      });
      const detail = await getThreadDetail(deps, id);
      const m = detail.messages[0]!;
      app = await buildApp(deps, [mailRoutes], { webDir: '/nonexistent' });

      const res = await app.inject({ method: 'GET', url: `/api/attachments/a/${m.gmailMessageId}/${m.attachments[0]!.attachmentId}` });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('JPEGDATA');
      expect(res.headers['content-disposition']).toContain(`filename*=UTF-8''${encodeURIComponent('Poză vară.jpg')}`);
    });

    it('GET /api/attachments 404s for a message that is not in the index', async () => {
      app = await buildApp(deps, [mailRoutes], { webDir: '/nonexistent' });
      const res = await app.inject({ method: 'GET', url: '/api/attachments/a/unknown/att1' });
      expect(res.statusCode).toBe(404);
      expect(gmail.calls.all).not.toContain('getAttachment');
    });
  });
});
