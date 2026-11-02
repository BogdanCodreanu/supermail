import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerEvent, StorageUsageDTO } from '@supermail/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AppConfig, DEFAULT_LIMITS } from '../src/config.js';
import { type DB, openDb } from '../src/db/index.js';
import { bus } from '../src/events.js';
import { ALLOW_ALL, buildApp, NOOP_HOOK } from '../src/http/app.js';
import { storageRoutes } from '../src/http/routes/storage.js';
import { createLogger, createLogStream, pruneLogs } from '../src/storage/logs.js';
import { canCacheBodies, canIndexMore, enforceLimits, measure, resetStorageState } from '../src/storage/limits.js';

const NOW = Date.UTC(2026, 9, 29, 10, 0, 0);
const GB = 1024n ** 3n;
const MB = 1024 * 1024;
const freeGB = (gb: number) => () => ({ bavail: BigInt(gb) * GB / 4096n, bsize: 4096n });
const healthy = freeGB(100);

function cfg(dataDir: string, limits: Partial<AppConfig['limits']> = {}): AppConfig {
  return {
    port: 8787, host: '127.0.0.1', dataDir, publicUrl: 'http://localhost:8787', ownerEmail: 'o@x.com',
    googleClientFile: '/nonexistent', pollSeconds: 30, limits: { ...DEFAULT_LIMITS, ...limits }, secureCookies: false,
  };
}

const count = (db: DB, sql: string) => db.prepare(sql).pluck().get() as number;
const ids = (db: DB, sql: string) => db.prepare(sql).pluck().all() as string[];

function addAccount(db: DB): void {
  db.prepare("INSERT INTO accounts(id, email, color, created_at) VALUES ('a', 'me@gmail.com', '#2563eb', 1)").run();
}

/** A thread with `msgs` messages, each carrying a padded snippet so the index has real weight. */
function addThread(db: DB, n: number, opts: { inbox?: boolean; at?: number; msgs?: number } = {}): string {
  const id = `a:t${n}`;
  const at = opts.at ?? NOW - n * 60_000;
  db.prepare('INSERT INTO threads(id, account_id, gmail_thread_id, subject, last_message_at, in_inbox) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, 'a', `t${n}`, `Subject ${n}`, at, opts.inbox ? 1 : 0);
  for (let i = 0; i < (opts.msgs ?? 3); i++) {
    db.prepare('INSERT INTO messages(id, thread_id, account_id, gmail_message_id, subject, snippet, date) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(`a:m${n}-${i}`, id, 'a', `m${n}-${i}`, `Subject ${n}`, 'x'.repeat(2000), at - i);
  }
  return id;
}

function addBody(db: DB, messageId: string, accessedAt: number, bytes = 20_000): void {
  db.prepare('INSERT INTO body_cache(message_id, html, text, bytes, last_accessed_at) VALUES (?, ?, ?, ?, ?)')
    .run(messageId, `<p>${'y'.repeat(bytes)}</p>`, null, bytes, accessedAt);
}

describe('storage limits', () => {
  let db: DB;
  let dir: string;
  let events: ServerEvent[];
  let off: () => void;

  beforeEach(() => {
    resetStorageState();
    db = openDb(':memory:');
    addAccount(db);
    dir = mkdtempSync(join(tmpdir(), 'supermail-limits-'));
    events = [];
    off = bus.subscribe((e) => events.push(e));
  });

  afterEach(() => {
    off();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('measure reports the default limits and splits body cache from the index', () => {
    addThread(db, 1, { inbox: true });
    addBody(db, 'a:m1-0', NOW);
    writeFileSync(join(dir, 'supermail.db'), Buffer.alloc(2 * MB));
    const m: StorageUsageDTO = measure(db, cfg(dir), healthy);
    expect(m.limits).toEqual({ bodyCacheMB: 1024, indexMB: 1024, logsMB: 50, totalMB: 3072, minFreeDiskGB: 20 });
    expect(m.limits.totalMB).toBe(3072);
    expect(m.bodyCacheMB).toBeGreaterThan(0.015);
    expect(m.indexMB).toBeGreaterThan(0.005);
    expect(m.totalMB).toBeGreaterThanOrEqual(2);
    expect(m.diskFreeGB).toBeCloseTo(100, 5);
    expect(m.degraded).toBe(false);
  });

  it('evicts the oldest-accessed bodies first and keeps the newest', () => {
    addThread(db, 1, { inbox: true, msgs: 10 });
    for (let i = 0; i < 10; i++) addBody(db, `a:m1-${i}`, NOW - (10 - i) * 1000); // m1-0 oldest … m1-9 newest
    const c = cfg(dir, { bodyCacheMB: 0.1 }); // ~100 KB, so about four 20 KB bodies fit
    const r = enforceLimits(db, c, NOW, healthy);
    expect(r.evictedBodies).toBeGreaterThan(0);
    const left = ids(db, 'SELECT message_id FROM body_cache ORDER BY last_accessed_at');
    expect(left).toContain('a:m1-9');
    expect(left).not.toContain('a:m1-0');
    // Whatever survived is the newest suffix.
    const all = Array.from({ length: 10 }, (_, i) => `a:m1-${i}`);
    expect(left).toEqual(all.slice(10 - left.length));
    expect(measure(db, c, healthy).bodyCacheMB).toBeLessThanOrEqual(0.1);
    expect(count(db, 'SELECT count(*) FROM messages')).toBe(10); // only bodies go, never index rows
  });

  it('prunes archived threads but keeps inbox, snoozed and overridden threads', () => {
    const inbox = addThread(db, 1, { inbox: true, at: NOW - 400 * 86_400_000 });
    const snoozed = addThread(db, 2, { at: NOW - 401 * 86_400_000 });
    const overridden = addThread(db, 3, { at: NOW - 402 * 86_400_000 });
    db.prepare('INSERT INTO snoozes(thread_id, until, created_at) VALUES (?, ?, ?)').run(snoozed, NOW + 86_400_000, NOW);
    db.prepare("INSERT INTO overrides(thread_id, group_id, source, created_at) VALUES (?, 'dev', 'app', ?)").run(overridden, NOW);
    for (let n = 10; n < 40; n++) addThread(db, n);

    const r = enforceLimits(db, cfg(dir, { indexMB: 0.001 }), NOW, healthy);
    expect(r.prunedThreads).toBe(30);
    expect(ids(db, 'SELECT id FROM threads ORDER BY id').sort()).toEqual([inbox, snoozed, overridden].sort());
    expect(count(db, "SELECT count(*) FROM messages WHERE thread_id NOT IN ('a:t1','a:t2','a:t3')")).toBe(0);
    expect(count(db, 'SELECT count(*) FROM snoozes')).toBe(1);
    expect(count(db, 'SELECT count(*) FROM overrides')).toBe(1);
  });

  it('prunes the oldest archived threads first, down to 90% of the index limit, and stops backfill', () => {
    for (let n = 10; n < 50; n++) addThread(db, n); // higher n = older
    const before = measure(db, cfg(dir), healthy).indexMB;
    const limit = before * 0.7;
    expect(canIndexMore()).toBe(true);

    const r = enforceLimits(db, cfg(dir, { indexMB: limit }), NOW, healthy);
    expect(r.prunedThreads).toBeGreaterThan(0);
    expect(r.prunedThreads).toBeLessThan(40);
    const left = ids(db, 'SELECT id FROM threads');
    expect(left).toContain('a:t10'); // newest archived stays
    expect(left).not.toContain('a:t49'); // oldest goes first
    const kept = left.map((id) => Number(id.slice(3))).sort((x, y) => x - y);
    expect(kept).toEqual(Array.from({ length: kept.length }, (_, i) => 10 + i)); // a contiguous newest block
    expect(measure(db, cfg(dir), healthy).indexMB).toBeLessThanOrEqual(limit * 0.9 + 0.02);
    expect(canIndexMore()).toBe(false); // no more backfill while the index is full
    expect(canCacheBodies()).toBe(true);
  });

  it('enters degraded mode below 20 GB free and leaves it at 25 GB, publishing each change', () => {
    const c = cfg(dir);
    let r = enforceLimits(db, c, NOW, freeGB(19));
    expect(r.degraded).toBe(true);
    expect(canIndexMore()).toBe(false);
    expect(canCacheBodies()).toBe(false);
    expect(measure(db, c, freeGB(19)).degraded).toBe(true);

    r = enforceLimits(db, c, NOW + 1000, freeGB(19));
    expect(r.degraded).toBe(true);

    r = enforceLimits(db, c, NOW + 2000, freeGB(25));
    expect(r.degraded).toBe(false);
    expect(canIndexMore()).toBe(true);
    expect(canCacheBodies()).toBe(true);

    expect(events.filter((e) => e.type === 'storage.degraded')).toEqual([
      { type: 'storage.degraded', degraded: true },
      { type: 'storage.degraded', degraded: false },
    ]);
  });

  it('enters degraded mode when everything in dataDir exceeds totalMB', () => {
    mkdirSync(join(dir, 'logs'));
    writeFileSync(join(dir, 'supermail.db'), Buffer.alloc(2 * MB));
    writeFileSync(join(dir, 'logs', 'supermail.log'), Buffer.alloc(MB));
    const r = enforceLimits(db, cfg(dir, { totalMB: 2.5 }), NOW, healthy);
    expect(r.degraded).toBe(true);
    expect(measure(db, cfg(dir), healthy).logsMB).toBeCloseTo(1, 5);
  });

  it('GET /api/storage returns the measured usage', async () => {
    const app = await buildApp({ db, config: cfg(dir), gmailFor: () => { throw new Error('unused'); }, now: () => NOW, onThreadChange: NOOP_HOOK, storage: ALLOW_ALL }, [storageRoutes], { webDir: dir });
    const res = await app.inject({ method: 'GET', url: '/api/storage' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as StorageUsageDTO;
    expect(body.limits.totalMB).toBe(3072);
    expect(typeof body.diskFreeGB).toBe('number');
    expect(typeof body.degraded).toBe('boolean'); // real statfs here, so it depends on the machine
    await app.close();
  });
});

describe('logs', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'supermail-logs-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const logDir = () => join(dir, 'logs');
  const totalBytes = () => readdirSync(logDir()).reduce((s, f) => s + statSync(join(logDir(), f)).size, 0);

  it('createLogger writes JSON lines to dataDir/logs/supermail.log', () => {
    const log = createLogger(cfg(dir));
    log.info({ accountId: 'a' }, 'hello');
    log.flush?.();
    const files = readdirSync(logDir());
    expect(files).toContain('supermail.log');
    expect(statSync(join(logDir(), 'supermail.log')).size).toBeGreaterThan(0);
  });

  it('rotates at the file size and keeps the total under the limit, newest kept', () => {
    const stream = createLogStream(logDir(), { maxFileBytes: 1000, maxTotalBytes: 3000 });
    for (let i = 0; i < 100; i++) stream.write(`${JSON.stringify({ i, pad: 'z'.repeat(80) })}\n`);
    stream.end();
    expect(totalBytes()).toBeLessThanOrEqual(3000);
    const files = readdirSync(logDir()).sort();
    expect(files).toContain('supermail.log');
    expect(files.length).toBeGreaterThan(1);
    expect(files.length).toBeLessThanOrEqual(3);
  });

  it('pruneLogs deletes the oldest rotated files until the total fits', () => {
    mkdirSync(logDir());
    writeFileSync(join(logDir(), 'supermail.log'), Buffer.alloc(1000));
    writeFileSync(join(logDir(), 'supermail.log.1'), Buffer.alloc(1000));
    writeFileSync(join(logDir(), 'supermail.log.2'), Buffer.alloc(1000));
    writeFileSync(join(logDir(), 'supermail.log.3'), Buffer.alloc(1000));
    pruneLogs(logDir(), 2500);
    expect(readdirSync(logDir()).sort()).toEqual(['supermail.log', 'supermail.log.1']);
  });
});
