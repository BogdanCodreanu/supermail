import { closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import type { AppConfig } from '../config.js';

export const LOG_FILE = 'supermail.log';
export const ROTATE_BYTES = 10 * 1024 * 1024;
const MB = 1024 * 1024;

export const logDirOf = (cfg: AppConfig): string => join(cfg.dataDir, 'logs');

export interface LogStream { write(chunk: string): boolean; end(): void }

/** `supermail.log` is generation 0, `supermail.log.N` is generation N (older). Other files are ignored. */
function generation(name: string): number | null {
  if (name === LOG_FILE) return 0;
  const m = /^supermail\.log\.(\d+)$/.exec(name);
  return m ? Number(m[1]) : null;
}

function logFiles(dir: string): { path: string; gen: number; size: number }[] {
  if (!existsSync(dir)) return [];
  const out: { path: string; gen: number; size: number }[] = [];
  for (const name of readdirSync(dir)) {
    const gen = generation(name);
    if (gen === null) continue;
    const path = join(dir, name);
    try {
      out.push({ path, gen, size: statSync(path).size });
    } catch {
      // Rotated away while listing.
    }
  }
  return out.sort((a, b) => a.gen - b.gen);
}

/** Total bytes of every file in the log directory. */
export function logsBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const name of readdirSync(dir)) {
    try {
      total += statSync(join(dir, name)).size;
    } catch {
      // Rotated away while listing.
    }
  }
  return total;
}

/** Deletes the oldest rotated files until the logs fit in `maxTotalBytes`. The live file is never deleted. */
export function pruneLogs(dir: string, maxTotalBytes: number): number {
  const files = logFiles(dir);
  let total = files.reduce((s, f) => s + f.size, 0);
  let removed = 0;
  for (const f of [...files].reverse()) {
    if (total <= maxTotalBytes || f.gen === 0) break;
    try {
      unlinkSync(f.path);
      total -= f.size;
      removed++;
    } catch {
      // Already gone.
    }
  }
  return removed;
}

/**
 * An append-only log file that rotates at `maxFileBytes` (`supermail.log` → `.1` → `.2` …) and keeps only
 * as many rotated files as fit in `maxTotalBytes`, so the newest lines are kept. Write errors are swallowed:
 * logging must never take the server down.
 */
export function createLogStream(dir: string, opts: { maxFileBytes: number; maxTotalBytes: number }): LogStream {
  mkdirSync(dir, { recursive: true });
  const fileBytes = Math.max(1, Math.min(opts.maxFileBytes, Math.floor(opts.maxTotalBytes / 2)));
  const keep = Math.max(0, Math.floor(opts.maxTotalBytes / fileBytes) - 1);
  const base = join(dir, LOG_FILE);
  const rotated = (n: number) => `${base}.${n}`;

  for (const f of logFiles(dir)) if (f.gen > keep) unlinkSync(f.path); // limit lowered since last run
  let fd: number | null = openSync(base, 'a');
  let size = statSync(base).size;

  function rotate(): void {
    if (fd !== null) closeSync(fd);
    if (keep === 0) {
      unlinkSync(base);
    } else {
      for (let n = keep; n >= 1; n--) {
        const from = n === 1 ? base : rotated(n - 1);
        if (existsSync(from)) renameSync(from, rotated(n)); // overwrites (drops) the oldest
      }
    }
    fd = openSync(base, 'a');
    size = 0;
  }

  return {
    write(chunk: string): boolean {
      if (fd === null) return false;
      try {
        const buf = Buffer.from(chunk);
        if (size > 0 && size + buf.length > fileBytes) rotate();
        writeSync(fd, buf);
        size += buf.length;
      } catch {
        // Disk full or file removed underneath us; drop the line.
      }
      return true;
    },
    end(): void {
      if (fd !== null) closeSync(fd);
      fd = null;
    },
  };
}

function fileStream(cfg: AppConfig): LogStream {
  return createLogStream(logDirOf(cfg), { maxFileBytes: ROTATE_BYTES, maxTotalBytes: cfg.limits.logsMB * MB });
}

/** Stdout (the add-on log in Home Assistant) plus the rotating file. Pass as Fastify's `logger.stream`. */
export function createLogSink(cfg: AppConfig): LogStream {
  const file = fileStream(cfg);
  return {
    write(chunk: string): boolean {
      process.stdout.write(chunk);
      return file.write(chunk);
    },
    end: () => file.end(),
  };
}

/** pino to `${dataDir}/logs/supermail.log`, rotated at 10 MB, total kept within `limits.logsMB`. */
export function createLogger(cfg: AppConfig, opts: pino.LoggerOptions = { level: 'info' }): pino.Logger {
  return pino(opts, fileStream(cfg));
}
