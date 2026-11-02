import { existsSync, lstatSync, readdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import type { StorageUsageDTO } from '@supermail/shared';
import type { AppConfig } from '../config.js';
import type { DB } from '../db/index.js';
import { bus } from '../events.js';
import { logDirOf, logsBytes, pruneLogs } from './logs.js';

export type StatFs = (p: string) => { bavail: bigint; bsize: bigint };

const MB = 1024 * 1024;
const GB = 1024 * MB;
/** Eviction and pruning stop once usage is back under this share of the limit. */
export const CLEANUP_TARGET = 0.9;
/** After the index was pruned, backfill stays stopped until the index is under this share of its limit. */
export const INDEX_RESUME = 0.8;
/** Estimates can miss after a delete (half-empty pages), so re-measure and go again a few times at most. */
const MAX_ROUNDS = 5;

const defaultStatfs: StatFs = (p) => {
  const s = statfsSync(p, { bigint: true });
  return { bavail: s.bavail, bsize: s.bsize };
};

// Process-wide gate state, read through canIndexMore/canCacheBodies (AppDeps.storage in main.ts).
let degraded = false;
let indexFull = false;

/** False in degraded mode, and after the index hit its limit (stops backfill of older history). */
export function canIndexMore(): boolean {
  return !degraded && !indexFull;
}

/** False in degraded mode: no new bodies are cached; reads still stream from Gmail. */
export function canCacheBodies(): boolean {
  return !degraded;
}

/** Test helper: back to the startup state. */
export function resetStorageState(): void {
  degraded = false;
  indexFull = false;
}

/** Bytes of the body cache and of the mail index (threads + messages), indexes included, from `dbstat`. */
function tableBytes(db: DB): { body: number; index: number } {
  const rows = db.prepare(`
    SELECT s.tbl_name AS tbl, SUM(d.pgsize) AS bytes
    FROM dbstat d JOIN sqlite_schema s ON s.name = d.name
    WHERE s.tbl_name IN ('body_cache', 'threads', 'messages')
    GROUP BY s.tbl_name`).all() as { tbl: string; bytes: number }[];
  let body = 0;
  let index = 0;
  for (const r of rows) {
    if (r.tbl === 'body_cache') body += r.bytes;
    else index += r.bytes;
  }
  return { body, index };
}

/** Everything under `dir` (database, WAL, key, logs), symlinks not followed. */
function dirBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      const st = lstatSync(p);
      if (st.isDirectory()) total += dirBytes(p);
      else if (st.isFile()) total += st.size;
    } catch {
      // Removed while walking.
    }
  }
  return total;
}

function freeBytes(cfg: AppConfig, statfs: StatFs): number {
  const s = statfs(cfg.dataDir);
  return Number(s.bavail * s.bsize);
}

function isDegraded(cfg: AppConfig, totalBytes: number, free: number): boolean {
  return totalBytes > cfg.limits.totalMB * MB || free < cfg.limits.minFreeDiskGB * GB;
}

export function measure(db: DB, cfg: AppConfig, statfs: StatFs = defaultStatfs): StorageUsageDTO {
  const { body, index } = tableBytes(db);
  const total = dirBytes(cfg.dataDir);
  const free = freeBytes(cfg, statfs);
  return {
    bodyCacheMB: body / MB,
    indexMB: index / MB,
    logsMB: logsBytes(logDirOf(cfg)) / MB,
    totalMB: total / MB,
    diskFreeGB: free / GB,
    limits: { ...cfg.limits },
    degraded: isDegraded(cfg, total, free),
  };
}

/** Takes rows from the front (oldest first) until their weights add up to `toFree`. */
function pickOldest<T extends { w: number }>(rows: T[], toFree: number): T[] {
  const picked: T[] = [];
  let acc = 0;
  for (const r of rows) {
    if (acc >= toFree) break;
    picked.push(r);
    acc += r.w;
  }
  return picked;
}

/** Body cache over its limit: delete by `last_accessed_at` ascending until under 90% of the limit. */
function evictBodies(db: DB, limitBytes: number): number {
  let evicted = 0;
  const del = db.prepare('DELETE FROM body_cache WHERE message_id = ?');
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const used = tableBytes(db).body;
    if (used <= limitBytes * (round === 0 ? 1 : CLEANUP_TARGET)) break;
    const rows = db.prepare(`
      SELECT message_id AS id,
             COALESCE(length(CAST(html AS BLOB)), 0) + COALESCE(length(CAST(text AS BLOB)), 0) + length(CAST(attachments_json AS BLOB)) + 64 AS w
      FROM body_cache ORDER BY last_accessed_at ASC, message_id ASC`).all() as { id: string; w: number }[];
    // Weights are raw row bytes; scale the dbstat excess (pages, overhead) into that unit.
    const weight = rows.reduce((s, r) => s + r.w, 0);
    if (!weight) break;
    const picked = pickOldest(rows, (used - limitBytes * CLEANUP_TARGET) * (weight / used));
    if (!picked.length) break;
    db.transaction(() => {
      for (const r of picked) del.run(r.id);
    })();
    evicted += picked.length;
  }
  return evicted;
}

/**
 * Index over its limit: delete archived threads (not in the inbox, not snoozed, no override) with the oldest
 * `last_message_at` first, until under 90% of the limit. They stay in Gmail and remain findable by search.
 */
function pruneIndex(db: DB, limitBytes: number): number {
  let pruned = 0;
  const del = db.prepare('DELETE FROM threads WHERE id = ?'); // cascades to messages and body_cache
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const used = tableBytes(db).index;
    if (used <= limitBytes * (round === 0 ? 1 : CLEANUP_TARGET)) break;
    const units = (db.prepare('SELECT (SELECT count(*) FROM threads) + (SELECT count(*) FROM messages)').pluck().get() as number) || 1;
    const rows = db.prepare(`
      SELECT t.id AS id, 1 + (SELECT count(*) FROM messages m WHERE m.thread_id = t.id) AS w
      FROM threads t
      WHERE t.in_inbox = 0
        AND NOT EXISTS (SELECT 1 FROM snoozes s WHERE s.thread_id = t.id)
        AND NOT EXISTS (SELECT 1 FROM overrides o WHERE o.thread_id = t.id)
      ORDER BY t.last_message_at ASC, t.id ASC`).all() as { id: string; w: number }[];
    // Weights are row counts (the thread plus its messages); every indexed row costs about used / units bytes.
    const picked = pickOldest(rows, (used - limitBytes * CLEANUP_TARGET) * (units / used));
    if (!picked.length) break;
    db.transaction(() => {
      for (const r of picked) del.run(r.id);
    })();
    pruned += picked.length;
  }
  return pruned;
}

/**
 * Applies every hard limit (spec §4.2). Runs at startup, every 15 minutes and after each poller tick.
 * - body cache over limit → evict oldest-accessed bodies to 90%;
 * - index over limit → prune oldest archived threads to 90% and stop backfill;
 * - logs over limit → drop the oldest rotated files;
 * - `/data` over `totalMB` or disk free under `minFreeDiskGB` → degraded: no history indexing, no body
 *   caching. `storage.degraded` is published whenever that flips.
 */
export function enforceLimits(db: DB, cfg: AppConfig, now: number, statfs: StatFs = defaultStatfs): { evictedBodies: number; prunedThreads: number; degraded: boolean } {
  const lim = cfg.limits;
  let evictedBodies = 0;
  let prunedThreads = 0;

  db.pragma('wal_checkpoint(TRUNCATE)');
  // Fast path: dbstat reads every page, so skip it while the whole file is smaller than either table limit.
  const fileBytes = (db.pragma('page_count', { simple: true }) as number) * (db.pragma('page_size', { simple: true }) as number);
  if (fileBytes > Math.min(lim.bodyCacheMB, lim.indexMB) * MB) {
    evictedBodies = evictBodies(db, lim.bodyCacheMB * MB);
    prunedThreads = pruneIndex(db, lim.indexMB * MB);
    if (prunedThreads > 0) indexFull = true;
    else if (indexFull && tableBytes(db).index < lim.indexMB * MB * INDEX_RESUME) indexFull = false;
  } else if (fileBytes < lim.indexMB * MB * INDEX_RESUME) {
    indexFull = false;
  }
  if (evictedBodies || prunedThreads) {
    db.prepare("INSERT INTO kv(key, value) VALUES ('storage_last_cleanup', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify({ at: now, evictedBodies, prunedThreads }));
  }

  pruneLogs(logDirOf(cfg), lim.logsMB * MB);

  const next = isDegraded(cfg, dirBytes(cfg.dataDir), freeBytes(cfg, statfs));
  if (next !== degraded) {
    degraded = next;
    bus.publish({ type: 'storage.degraded', degraded });
  }
  return { evictedBodies, prunedThreads, degraded };
}
