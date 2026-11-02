import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ThreadPage } from '@supermail/shared';
import type { AppConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db/index.js';
import { ALLOW_ALL, type AppDeps, buildApp } from '../src/http/app.js';
import { mailRoutes } from '../src/http/routes/mail.js';
import { search } from '../src/mail/search.js';
import { indexThread } from '../src/sync/indexer.js';
import { createFakeGmail, type FakeGmail } from './fakes/fakeGmail.js';
import { DAY, HOUR } from './fixtures/threads.js';

const NOW = Date.UTC(2026, 9, 29, 10, 0, 0);

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

describe('search', () => {
  let db: DB;
  let a: FakeGmail;
  let b: FakeGmail;
  let c: FakeGmail;
  let deps: AppDeps;
  let changes: [string, string][];
  let app: FastifyInstance | undefined;

  beforeEach(async () => {
    db = openDb(':memory:');
    const add = db.prepare("INSERT INTO accounts(id, email, color, status, created_at) VALUES (?, ?, '#2563eb', ?, ?)");
    add.run('a', 'me@gmail.com', 'ok', 1);
    add.run('b', 'work@gmail.com', 'ok', 2);
    add.run('c', 'old@gmail.com', 'reconnect_needed', 3);
    a = createFakeGmail('me@gmail.com', { now: () => NOW });
    b = createFakeGmail('work@gmail.com', { now: () => NOW });
    c = createFakeGmail('old@gmail.com', { now: () => NOW });

    a.addThread({ id: 'a-new', messages: [{ from: 'ING <alerte@ing.ro>', subject: 'Invoice October', date: NOW - HOUR }] });
    a.addThread({ id: 'a-old', messages: [{ from: 'ING <alerte@ing.ro>', subject: 'Invoice 2024', date: NOW - 400 * DAY, labelIds: [] }] });
    a.addThread({ id: 'a-other', messages: [{ from: 'Ana <ana@friends.ro>', subject: 'Coffee', date: NOW }] });
    b.addThread({ id: 'b-mid', messages: [{ from: 'Billing <billing@corp.com>', subject: 'Invoice #42', date: NOW - DAY }] });
    c.addThread({ id: 'c-1', messages: [{ from: 'X <x@x.com>', subject: 'Invoice', date: NOW }] });
    // a-new is already in the index; the others are found only through Gmail search
    indexThread(db, 'a', await a.getThread('a-new', 'metadata'), new Set(['me@gmail.com']), undefined, 'sync');

    changes = [];
    const fakes: Record<string, FakeGmail> = { a, b, c };
    deps = { db, config, gmailFor: (id) => fakes[id]!, now: () => NOW, onThreadChange: (id, r) => changes.push([id, r]), storage: ALLOW_ALL };
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('merges results from every ok account, newest first, indexing unknown threads', async () => {
    const page = await search(deps, 'invoice');
    expect(page.threads.map((t) => t.id)).toEqual(['a:a-new', 'b:b-mid', 'a:a-old']);
    expect(page.nextCursor).toBeNull();
    expect(page.threads[2]).toMatchObject({ subject: 'Invoice 2024', inInbox: false, accountId: 'a' });
    expect(db.prepare("SELECT count(*) FROM threads WHERE id IN ('a:a-old', 'b:b-mid')").pluck().get()).toBe(2);
    // newly indexed history is reported as a change, never as new mail
    expect(changes.sort()).toEqual([['a:a-old', 'changed'], ['b:b-mid', 'changed']]);
  });

  it('passes the query to Gmail with maxResults 25 and skips accounts that need reconnecting', async () => {
    const seen: unknown[] = [];
    const listThreads = a.listThreads.bind(a);
    a.listThreads = async (p) => {
      seen.push(p);
      return listThreads(p);
    };
    await search(deps, 'from:alerte@ing.ro');
    expect(seen).toEqual([{ q: 'from:alerte@ing.ro', maxResults: 25 }]);
    expect(c.calls.all).toEqual([]);
  });

  it('never writes labels', async () => {
    await search(deps, 'invoice');
    await search(deps, 'coffee');
    expect(a.calls.modifyThread).toEqual([]);
    expect(b.calls.modifyThread).toEqual([]);
    expect(a.calls.all).not.toContain('modifyThread');
  });

  it('still returns the other accounts when one fails', async () => {
    b.revoke();
    const page = await search(deps, 'invoice');
    expect(page.threads.map((t) => t.id)).toEqual(['a:a-new', 'a:a-old']);
  });

  it('GET /api/search returns a ThreadPage, and 400 without q', async () => {
    app = await buildApp(deps, [mailRoutes], { webDir: '/nonexistent' });
    const res = await app.inject({ method: 'GET', url: '/api/search?q=coffee' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as ThreadPage).threads.map((t) => t.id)).toEqual(['a:a-other']);
    expect((await app.inject({ method: 'GET', url: '/api/search?q=%20' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/search' })).statusCode).toBe(400);
  });
});
