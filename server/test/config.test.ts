import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const ADDON_OPTIONS = {
  owner_email: 'o@x.com',
  public_url: 'https://mail.example.com',
  port: 8787,
  body_cache_mb: 1024,
  index_mb: 1024,
  logs_mb: 50,
  total_mb: 3072,
  min_free_disk_gb: 20,
};

function noFile(p: string): string {
  throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
}

describe('loadConfig', () => {
  it('reads add-on options.json when present', () => {
    const cfg = loadConfig({}, (p) => {
      if (p === '/data/options.json') return JSON.stringify(ADDON_OPTIONS);
      return noFile(p);
    });
    expect(cfg.dataDir).toBe('/data');
    expect(cfg.googleClientFile).toBe('/config/client_secret.json');
    expect(cfg.secureCookies).toBe(true);
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.ownerEmail).toBe('o@x.com');
    expect(cfg.publicUrl).toBe('https://mail.example.com');
    expect(cfg.port).toBe(8787);
    expect(cfg.pollSeconds).toBe(15);
    expect(cfg.limits).toEqual({ bodyCacheMB: 1024, indexMB: 1024, logsMB: 50, totalMB: 3072, minFreeDiskGB: 20 });
  });

  it('applies add-on option overrides', () => {
    const cfg = loadConfig({}, () => JSON.stringify({ ...ADDON_OPTIONS, port: 9000, total_mb: 2000 }));
    expect(cfg.port).toBe(9000);
    expect(cfg.limits.totalMB).toBe(2000);
  });

  it('uses dev env defaults when there is no options.json', () => {
    const cfg = loadConfig({ SUPERMAIL_OWNER_EMAIL: 'me@gmail.com', HOME: '/home/me' }, noFile);
    expect(cfg.ownerEmail).toBe('me@gmail.com');
    expect(cfg.publicUrl).toBe('http://localhost:8787');
    expect(cfg.googleClientFile).toBe('/home/me/.config/supermail/client_secret.json');
    expect(cfg.dataDir.endsWith('.data')).toBe(true);
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.port).toBe(8787);
    expect(cfg.secureCookies).toBe(false);
    expect(cfg.limits).toEqual({ bodyCacheMB: 1024, indexMB: 1024, logsMB: 50, totalMB: 3072, minFreeDiskGB: 20 });
  });

  it('honours dev env overrides', () => {
    const cfg = loadConfig(
      {
        SUPERMAIL_OWNER_EMAIL: 'me@gmail.com',
        SUPERMAIL_DATA_DIR: '/tmp/sm',
        SUPERMAIL_PUBLIC_URL: 'http://127.0.0.1:8787',
        SUPERMAIL_CLIENT_FILE: '/tmp/client.json',
      },
      noFile,
    );
    expect(cfg.dataDir).toBe('/tmp/sm');
    expect(cfg.publicUrl).toBe('http://127.0.0.1:8787');
    expect(cfg.googleClientFile).toBe('/tmp/client.json');
  });

  it('throws without SUPERMAIL_OWNER_EMAIL in dev', () => {
    expect(() => loadConfig({}, noFile)).toThrow(/SUPERMAIL_OWNER_EMAIL is missing/);
  });

  it('reads the Docker variables: host, port and secure cookies', () => {
    const cfg = loadConfig({ SUPERMAIL_OWNER_EMAIL: 'me@gmail.com', SUPERMAIL_HOST: '0.0.0.0', SUPERMAIL_PORT: '9000', SUPERMAIL_SECURE_COOKIES: 'true' }, noFile);
    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.port).toBe(9000);
    expect(cfg.publicUrl).toBe('http://localhost:9000');
    expect(cfg.secureCookies).toBe(true);
  });

  it('turns secure cookies on for an https public URL unless told otherwise', () => {
    const base = { SUPERMAIL_OWNER_EMAIL: 'me@gmail.com', SUPERMAIL_PUBLIC_URL: 'https://mail.example.com/' };
    expect(loadConfig(base, noFile)).toMatchObject({ secureCookies: true, publicUrl: 'https://mail.example.com' });
    expect(loadConfig({ ...base, SUPERMAIL_SECURE_COOKIES: 'false' }, noFile).secureCookies).toBe(false);
    expect(() => loadConfig({ ...base, SUPERMAIL_SECURE_COOKIES: 'maybe' }, noFile)).toThrow(/SUPERMAIL_SECURE_COOKIES/);
  });

  it('explains every missing add-on option at once', () => {
    const read = () => JSON.stringify({ ...ADDON_OPTIONS, owner_email: '', public_url: '' });
    expect(() => loadConfig({}, read)).toThrow(/Configuration tab[\s\S]*owner_email is missing[\s\S]*public_url is missing/);
  });

  it('rejects an add-on public_url that is not a URL', () => {
    const read = () => JSON.stringify({ ...ADDON_OPTIONS, public_url: 'mail.example.com' });
    expect(() => loadConfig({}, read)).toThrow(/public_url "mail.example.com" must start with https:\/\//);
  });
});
