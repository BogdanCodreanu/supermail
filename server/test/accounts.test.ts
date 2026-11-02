import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { API_HEADER, type ServerEvent } from '@supermail/shared';
import {
  ACCOUNT_COLORS,
  getRefreshToken,
  listAccounts,
  removeAccount,
  setAccountStatus,
  upsertAccount,
} from '../src/accounts/accounts.js';
import { createSession, isAllowedEmail, requireSession, SESSION_COOKIE } from '../src/auth/sessions.js';
import type { AppConfig } from '../src/config.js';
import { TokenDecryptError } from '../src/crypto/tokens.js';
import { type DB, openDb } from '../src/db/index.js';
import { bus } from '../src/events.js';
import { ALLOW_ALL, type AppDeps, buildApp, NOOP_HOOK, type RoutePlugin } from '../src/http/app.js';
import { accountsRoutes } from '../src/http/routes/accounts.js';

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);

function config(dataDir = mkdtempSync(join(tmpdir(), 'sm-data-'))): AppConfig {
  return {
    port: 8787,
    host: '127.0.0.1',
    dataDir,
    publicUrl: 'http://localhost:8787',
    ownerEmail: 'owner@gmail.com',
    googleClientFile: '/nonexistent/client_secret.json',
    pollSeconds: 30,
    limits: { bodyCacheMB: 1024, indexMB: 1024, logsMB: 50, totalMB: 3072, minFreeDiskGB: 20 },
    secureCookies: false,
  };
}

function captureEvents(): { events: ServerEvent[]; off: () => void } {
  const events: ServerEvent[] = [];
  const off = bus.subscribe((e) => events.push(e));
  return { events, off };
}

function insertThread(db: DB, accountId: string, gmailThreadId: string): string {
  const id = `${accountId}:${gmailThreadId}`;
  db.prepare('INSERT INTO threads(id, account_id, gmail_thread_id, last_message_at, in_inbox) VALUES (?, ?, ?, ?, 1)').run(id, accountId, gmailThreadId, NOW);
  db.prepare('INSERT INTO messages(id, thread_id, account_id, gmail_message_id, date) VALUES (?, ?, ?, ?, ?)').run(`${id}:m1`, id, accountId, 'm1', NOW);
  db.prepare('INSERT INTO body_cache(message_id, html, bytes, last_accessed_at) VALUES (?, ?, 4, ?)').run(`${id}:m1`, '<p>', NOW);
  db.prepare('INSERT INTO snoozes(thread_id, until, created_at) VALUES (?, ?, ?)').run(id, NOW + 1000, NOW);
  return id;
}

describe('accounts', () => {
  const key = randomBytes(32);

  it('gives the first two accounts #2563eb then #16a34a, status syncing', () => {
    const db = openDb(':memory:');
    const a = upsertAccount(db, key, 'a@gmail.com', 'rt-a', NOW);
    const b = upsertAccount(db, key, 'b@gmail.com', 'rt-b', NOW + 1);
    expect(a.color).toBe('#2563eb');
    expect(b.color).toBe('#16a34a');
    expect(ACCOUNT_COLORS.slice(0, 2)).toEqual(['#2563eb', '#16a34a']);
    expect(a.status).toBe('syncing');
    expect(a.id).not.toContain(':');
    expect(listAccounts(db).map((x) => x.email)).toEqual(['a@gmail.com', 'b@gmail.com']);
  });

  it('reuses a freed color before cycling', () => {
    const db = openDb(':memory:');
    const a = upsertAccount(db, key, 'a@gmail.com', 'rt-a', NOW);
    upsertAccount(db, key, 'b@gmail.com', 'rt-b', NOW + 1);
    removeAccount(db, a.id);
    expect(upsertAccount(db, key, 'c@gmail.com', 'rt-c', NOW + 2).color).toBe('#2563eb');
  });

  it('upserting the same email twice keeps one row, replaces the token and resets sync', () => {
    const db = openDb(':memory:');
    const first = upsertAccount(db, key, 'a@gmail.com', 'rt-old', NOW);
    db.prepare("UPDATE accounts SET status='reconnect_needed', history_id='999' WHERE id=?").run(first.id);
    const second = upsertAccount(db, key, 'A@Gmail.com', 'rt-new', NOW + 1);
    expect(second.id).toBe(first.id);
    expect(second.color).toBe(first.color);
    expect(second.status).toBe('syncing');
    expect(db.prepare('SELECT count(*) FROM accounts').pluck().get()).toBe(1);
    expect(db.prepare('SELECT history_id FROM accounts').pluck().get()).toBeNull();
    expect(getRefreshToken(db, key, first.id)).toBe('rt-new');
  });

  it('stores the refresh token encrypted, never in plaintext', () => {
    const db = openDb(':memory:');
    const a = upsertAccount(db, key, 'a@gmail.com', 'rt-plaintext-secret', NOW);
    const blob = db.prepare('SELECT token_enc FROM accounts WHERE id=?').pluck().get(a.id) as Buffer;
    expect(Buffer.isBuffer(blob)).toBe(true);
    expect(blob.toString('latin1')).not.toContain('rt-plaintext-secret');
  });

  it('publishes account.updated on connect', () => {
    const db = openDb(':memory:');
    const { events, off } = captureEvents();
    const a = upsertAccount(db, key, 'a@gmail.com', 'rt-a', NOW);
    off();
    expect(events).toContainEqual({ type: 'account.updated', account: a });
  });

  it('lets a connected account email pass isAllowedEmail (case-insensitive)', () => {
    const db = openDb(':memory:');
    const cfg = config();
    expect(isAllowedEmail(db, cfg, 'second@gmail.com')).toBe(false);
    upsertAccount(db, key, 'second@gmail.com', 'rt', NOW);
    expect(isAllowedEmail(db, cfg, 'Second@Gmail.com')).toBe(true);
    expect(isAllowedEmail(db, cfg, 'OWNER@gmail.com')).toBe(true);
    expect(isAllowedEmail(db, cfg, 'stranger@x.com')).toBe(false);
  });

  it('a corrupted token_enc makes getRefreshToken throw and flips status to reconnect_needed', () => {
    const db = openDb(':memory:');
    const a = upsertAccount(db, key, 'a@gmail.com', 'rt-a', NOW);
    setAccountStatus(db, a.id, 'ok');
    db.prepare('UPDATE accounts SET token_enc=? WHERE id=?').run(Buffer.from('garbage-garbage-garbage-garbage!'), a.id);
    const { events, off } = captureEvents();
    expect(() => getRefreshToken(db, key, a.id)).toThrow(TokenDecryptError);
    off();
    expect(listAccounts(db)[0]!.status).toBe('reconnect_needed');
    expect(events).toContainEqual({ type: 'account.updated', account: { ...a, status: 'reconnect_needed' } });
  });

  it('a key that changed (restored backup) also means reconnect_needed, without wiping data', () => {
    const db = openDb(':memory:');
    const a = upsertAccount(db, key, 'a@gmail.com', 'rt-a', NOW);
    insertThread(db, a.id, 't1');
    expect(() => getRefreshToken(db, randomBytes(32), a.id)).toThrow(TokenDecryptError);
    expect(listAccounts(db)[0]!.status).toBe('reconnect_needed');
    expect(db.prepare('SELECT count(*) FROM threads').pluck().get()).toBe(1);
  });

  it('setAccountStatus publishes only on change', () => {
    const db = openDb(':memory:');
    const a = upsertAccount(db, key, 'a@gmail.com', 'rt-a', NOW);
    const { events, off } = captureEvents();
    setAccountStatus(db, a.id, 'ok');
    setAccountStatus(db, a.id, 'ok');
    off();
    expect(events).toEqual([{ type: 'account.updated', account: { ...a, status: 'ok' } }]);
  });

  it('removeAccount deletes its token, index, cache, labels map and undo/label logs, leaving others', () => {
    const db = openDb(':memory:');
    const a = upsertAccount(db, key, 'a@gmail.com', 'rt-a', NOW);
    const b = upsertAccount(db, key, 'b@gmail.com', 'rt-b', NOW);
    const ta = insertThread(db, a.id, 't1');
    insertThread(db, b.id, 't1');
    db.prepare("INSERT INTO group_labels(group_id, account_id, gmail_label_id) VALUES ('dev', ?, 'Label_1')").run(a.id);
    db.prepare("INSERT INTO label_writes(account_id, gmail_thread_id, added_json, removed_json, at) VALUES (?, 't1', '[]', '[]', ?)").run(a.id, NOW);
    db.prepare("INSERT INTO undo(id, thread_id, kind, payload_json, created_at) VALUES ('u1', ?, 'done', '{}', ?)").run(ta, NOW);

    removeAccount(db, a.id);

    expect(listAccounts(db).map((x) => x.id)).toEqual([b.id]);
    for (const table of ['threads', 'messages', 'body_cache', 'snoozes']) {
      expect(db.prepare(`SELECT count(*) FROM ${table}`).pluck().get(), table).toBe(1);
    }
    expect(db.prepare('SELECT count(*) FROM group_labels').pluck().get()).toBe(0);
    expect(db.prepare('SELECT count(*) FROM label_writes').pluck().get()).toBe(0);
    expect(db.prepare('SELECT count(*) FROM undo').pluck().get()).toBe(0);
  });
});

describe('accounts routes', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function build(): Promise<{ app: FastifyInstance; deps: AppDeps; cookie: string }> {
    const cfg = config();
    const deps: AppDeps = {
      db: openDb(':memory:'),
      config: cfg,
      gmailFor: () => {
        throw new Error('no gmail in tests');
      },
      now: () => NOW,
      onThreadChange: NOOP_HOOK,
      storage: ALLOW_ALL,
    };
    const guard: RoutePlugin = async (a, d) => {
      a.addHook('preHandler', requireSession(d.db, d.config, d.now));
    };
    app = await buildApp(deps, [guard, accountsRoutes], { webDir: '/nonexistent' });
    const raw = createSession(deps.db, cfg.ownerEmail, NOW);
    return { app, deps, cookie: `${SESSION_COOKIE}=${raw}` };
  }

  it('GET /api/accounts lists accounts without tokens', async () => {
    const { app, deps, cookie } = await build();
    const a = upsertAccount(deps.db, randomBytes(32), 'a@gmail.com', 'rt-a', NOW);
    const res = await app.inject({ method: 'GET', url: '/api/accounts', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([a]);
    expect(res.body).not.toContain('token');
  });

  it('DELETE /api/accounts/:id removes it, and 404s for an unknown id', async () => {
    const { app, deps, cookie } = await build();
    const a = upsertAccount(deps.db, randomBytes(32), 'a@gmail.com', 'rt-a', NOW);
    const headers = { cookie, [API_HEADER]: '1' };
    const res = await app.inject({ method: 'DELETE', url: `/api/accounts/${a.id}`, headers });
    expect(res.statusCode).toBe(200);
    expect(listAccounts(deps.db)).toEqual([]);
    const again = await app.inject({ method: 'DELETE', url: `/api/accounts/${a.id}`, headers });
    expect(again.statusCode).toBe(404);
  });

  it('a removed account email can no longer use its existing session', async () => {
    const { app, deps } = await build();
    const a = upsertAccount(deps.db, randomBytes(32), 'second@gmail.com', 'rt', NOW);
    const cookie = `${SESSION_COOKIE}=${createSession(deps.db, 'second@gmail.com', NOW)}`;
    expect((await app.inject({ method: 'GET', url: '/api/accounts', headers: { cookie } })).statusCode).toBe(200);
    removeAccount(deps.db, a.id);
    expect((await app.inject({ method: 'GET', url: '/api/accounts', headers: { cookie } })).statusCode).toBe(401);
  });
});
