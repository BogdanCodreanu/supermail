import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Limits { bodyCacheMB: number; indexMB: number; logsMB: number; totalMB: number; minFreeDiskGB: number }
export interface AppConfig { port: number; host: string; dataDir: string; publicUrl: string; ownerEmail: string; googleClientFile: string; pollSeconds: number; limits: Limits; secureCookies: boolean }

export const ADDON_OPTIONS_FILE = '/data/options.json';
export const DEFAULT_PORT = 8787;
export const DEFAULT_POLL_SECONDS = 15;
export const DEFAULT_LIMITS: Limits = { bodyCacheMB: 1024, indexMB: 1024, logsMB: 50, totalMB: 3072, minFreeDiskGB: 20 };

interface AddonOptions {
  owner_email?: string;
  public_url?: string;
  port?: number;
  body_cache_mb?: number;
  index_mb?: number;
  logs_mb?: number;
  total_mb?: number;
  min_free_disk_gb?: number;
}

function readOptions(readFile: (p: string) => string): AddonOptions | null {
  let raw: string;
  try {
    raw = readFile(ADDON_OPTIONS_FILE);
  } catch {
    return null; // not running as the Home Assistant add-on
  }
  try {
    return JSON.parse(raw) as AddonOptions;
  } catch (err) {
    throw new Error(`${ADDON_OPTIONS_FILE} is not valid JSON: ${(err as Error).message}`);
  }
}

function num(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`option ${name} must be a positive number`);
  }
  return value;
}

function bool(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new Error(`${name} must be true or false, not "${value}"`);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What is wrong with the owner address and the public URL, as lines the person can act on. */
function problems(ownerEmail: string | undefined, publicUrl: string | undefined, names: { email: string; url: string }): string[] {
  const out: string[] = [];
  if (!ownerEmail) out.push(`${names.email} is missing: set it to the Google address allowed to sign in, such as you@gmail.com`);
  else if (!EMAIL.test(ownerEmail)) out.push(`${names.email} "${ownerEmail}" is not an email address`);
  if (publicUrl !== undefined) {
    if (!publicUrl) out.push(`${names.url} is missing: set it to the address SuperMail is served at, such as https://mail.example.com`);
    else if (!/^https?:\/\/[^/\s]+/.test(publicUrl)) out.push(`${names.url} "${publicUrl}" must start with https:// (or http:// for local use)`);
  }
  return out;
}

function fail(lines: string[], where: string): never {
  throw new Error(`SuperMail is not configured yet. ${where}\n${lines.map((l) => `  - ${l}`).join('\n')}`);
}

export function loadConfig(env: NodeJS.ProcessEnv, readFile: (p: string) => string = (p) => readFileSync(p, 'utf8')): AppConfig {
  const opts = readOptions(readFile);
  if (opts) {
    const issues = problems(opts.owner_email?.trim(), opts.public_url?.trim() ?? '', { email: 'owner_email', url: 'public_url' });
    if (issues.length) fail(issues, 'Fix these in the add-on\'s Configuration tab, then restart it:');
    return {
      port: num(opts.port, DEFAULT_PORT, 'port'),
      host: '127.0.0.1',
      dataDir: '/data',
      publicUrl: opts.public_url!.trim().replace(/\/+$/, ''),
      ownerEmail: opts.owner_email!.trim(),
      googleClientFile: '/config/client_secret.json',
      pollSeconds: DEFAULT_POLL_SECONDS,
      limits: {
        bodyCacheMB: num(opts.body_cache_mb, DEFAULT_LIMITS.bodyCacheMB, 'body_cache_mb'),
        indexMB: num(opts.index_mb, DEFAULT_LIMITS.indexMB, 'index_mb'),
        logsMB: num(opts.logs_mb, DEFAULT_LIMITS.logsMB, 'logs_mb'),
        totalMB: num(opts.total_mb, DEFAULT_LIMITS.totalMB, 'total_mb'),
        minFreeDiskGB: num(opts.min_free_disk_gb, DEFAULT_LIMITS.minFreeDiskGB, 'min_free_disk_gb'),
      },
      secureCookies: true,
    };
  }

  // Plain Node or Docker: everything comes from SUPERMAIL_* variables.
  const ownerEmail = env.SUPERMAIL_OWNER_EMAIL?.trim();
  const port = env.SUPERMAIL_PORT ? Number(env.SUPERMAIL_PORT) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`SUPERMAIL_PORT must be a port number, not "${env.SUPERMAIL_PORT}"`);
  const publicUrl = (env.SUPERMAIL_PUBLIC_URL?.trim() || `http://localhost:${port}`).replace(/\/+$/, '');
  const issues = problems(ownerEmail, publicUrl, { email: 'SUPERMAIL_OWNER_EMAIL', url: 'SUPERMAIL_PUBLIC_URL' });
  if (issues.length) fail(issues, 'Set these environment variables (see README.md), then start it again:');
  const home = env.HOME || homedir();
  return {
    port,
    host: env.SUPERMAIL_HOST?.trim() || '127.0.0.1',
    dataDir: resolve(env.SUPERMAIL_DATA_DIR || './.data'),
    publicUrl,
    ownerEmail: ownerEmail!,
    googleClientFile: env.SUPERMAIL_CLIENT_FILE || join(home, '.config/supermail/client_secret.json'),
    pollSeconds: DEFAULT_POLL_SECONDS,
    limits: { ...DEFAULT_LIMITS },
    // Secure cookies are only sent over HTTPS, so they follow the public URL unless set explicitly.
    secureCookies: bool(env.SUPERMAIL_SECURE_COOKIES, publicUrl.startsWith('https://'), 'SUPERMAIL_SECURE_COOKIES'),
  };
}
