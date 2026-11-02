import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { API_HEADER } from '@supermail/shared';
import { getRefreshToken, listAccounts } from '../src/accounts/accounts.js';
import { createSession, requireSession, SESSION_COOKIE, SESSION_DAYS, sessionEmail } from '../src/auth/sessions.js';
import type { AppConfig } from '../src/config.js';
import { loadOrCreateKey } from '../src/crypto/tokens.js';
import { openDb } from '../src/db/index.js';
import { CONNECT_SCOPES, LOGIN_SCOPES, readClientFile, redactUrl, reqSerializer } from '../src/google/oauth.js';
import { ALLOW_ALL, type AppDeps, buildApp, NOOP_HOOK, type RoutePlugin } from '../src/http/app.js';
import { accountsRoutes } from '../src/http/routes/accounts.js';
import { createAuthRoutes, type ExchangeCode, OAUTH_STATE_COOKIE } from '../src/http/routes/auth.js';
import { privacyRoutes } from '../src/http/routes/privacy.js';

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const OWNER = 'owner@gmail.com';
const FAKE_CLIENT_ID = 'fake-client.apps.googleusercontent.com';
const FAKE_CLIENT_SECRET = 'fake-secret-for-tests';

let clientFile: string;
let webDir: string;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-auth-'));
  clientFile = join(dir, 'client_secret.json');
  writeFileSync(clientFile, JSON.stringify({ web: { client_id: FAKE_CLIENT_ID, client_secret: FAKE_CLIENT_SECRET, project_id: 'x' } }));
  webDir = mkdtempSync(join(tmpdir(), 'sm-web-'));
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>SuperMail</title><div id="root"></div>');
});

function config(over: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 8787,
    host: '127.0.0.1',
    dataDir: mkdtempSync(join(tmpdir(), 'sm-data-')),
    publicUrl: 'http://localhost:8787',
    ownerEmail: OWNER,
    googleClientFile: clientFile,
    pollSeconds: 30,
    limits: { bodyCacheMB: 1024, indexMB: 1024, logsMB: 50, totalMB: 3072, minFreeDiskGB: 20 },
    secureCookies: false,
    ...over,
  };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Identity the stubbed Google token exchange returns for the next callback. */
interface Stub { email: string; refreshToken: string | null; codes: string[] }

async function build(over: Partial<AppConfig> = {}): Promise<{ app: FastifyInstance; deps: AppDeps; stub: Stub }> {
  const stub: Stub = { email: OWNER, refreshToken: null, codes: [] };
  const exchangeCode: ExchangeCode = async (_cfg, code) => {
    stub.codes.push(code);
    return { email: stub.email, refreshToken: stub.refreshToken };
  };
  const deps: AppDeps = {
    db: openDb(':memory:'),
    config: config(over),
    gmailFor: () => {
      throw new Error('no gmail in tests');
    },
    now: () => NOW,
    onThreadChange: NOOP_HOOK,
    storage: ALLOW_ALL,
  };
  // Mirrors main.ts: the session guard first, then the route plugins.
  const guard: RoutePlugin = async (a, d) => {
    a.addHook('preHandler', requireSession(d.db, d.config, d.now));
  };
  app = await buildApp(deps, [guard, createAuthRoutes({ exchangeCode }), accountsRoutes, privacyRoutes], { webDir });
  return { app, deps, stub };
}

function setCookies(res: LightMyRequestResponse): string[] {
  const h = res.headers['set-cookie'];
  return h === undefined ? [] : Array.isArray(h) ? h : [h];
}

function cookieValue(res: LightMyRequestResponse, name: string): string | undefined {
  const c = setCookies(res).find((s) => s.startsWith(`${name}=`));
  return c?.slice(name.length + 1).split(';')[0];
}

async function start(a: FastifyInstance, path: '/auth/login' | '/auth/connect', cookie?: string) {
  const res = await a.inject({ method: 'GET', url: path, headers: cookie ? { cookie } : {} });
  expect(res.statusCode).toBe(302);
  const location = new URL(res.headers.location as string);
  const state = location.searchParams.get('state')!;
  const stateCookie = cookieValue(res, OAUTH_STATE_COOKIE)!;
  return { res, location, state, stateCookie };
}

async function callback(a: FastifyInstance, state: string, stateCookie: string, extraCookie?: string) {
  const cookie = [`${OAUTH_STATE_COOKIE}=${stateCookie}`, extraCookie].filter(Boolean).join('; ');
  return a.inject({ method: 'GET', url: `/auth/google/callback?code=the-code&state=${encodeURIComponent(state)}`, headers: { cookie } });
}

describe('GET /auth/login', () => {
  it('redirects to Google with login scopes only and a random state in a 10-minute httpOnly cookie', async () => {
    const { app } = await build();
    const { res, location, state, stateCookie } = await start(app, '/auth/login');
    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(location.searchParams.get('client_id')).toBe(FAKE_CLIENT_ID);
    expect(location.searchParams.get('redirect_uri')).toBe('http://localhost:8787/auth/google/callback');
    expect(location.searchParams.get('scope')!.split(' ')).toEqual(LOGIN_SCOPES);
    expect(location.searchParams.get('scope')).not.toContain('gmail');
    expect(location.searchParams.get('access_type')).not.toBe('offline');
    expect(state.length).toBeGreaterThan(20);
    expect(decodeURIComponent(stateCookie)).toBe(state);
    const raw = setCookies(res).find((c) => c.startsWith(OAUTH_STATE_COOKIE))!;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/Max-Age=600/);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(res.body).not.toContain(FAKE_CLIENT_SECRET);

    const second = await start(app, '/auth/login');
    expect(second.state).not.toBe(state);
  });
});

describe('GET /auth/connect', () => {
  it('requires a session', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'GET', url: '/auth/connect' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('asks for offline access with consent and the gmail.modify scope', async () => {
    const { app, deps } = await build();
    const cookie = `${SESSION_COOKIE}=${createSession(deps.db, OWNER, NOW)}`;
    const { location } = await start(app, '/auth/connect', cookie);
    expect(location.searchParams.get('scope')!.split(' ')).toEqual(CONNECT_SCOPES);
    expect(location.searchParams.get('access_type')).toBe('offline');
    expect(location.searchParams.get('prompt')).toBe('consent');
  });
});

describe('GET /auth/google/callback (login)', () => {
  it('refuses a stranger with 403 and sets no session cookie', async () => {
    const { app, deps, stub } = await build();
    stub.email = 'stranger@x.com';
    const { state, stateCookie } = await start(app, '/auth/login');
    const res = await callback(app, state, stateCookie);
    expect(res.statusCode).toBe(403);
    expect(cookieValue(res, SESSION_COOKIE) ?? '').toBe('');
    expect(deps.db.prepare('SELECT count(*) FROM sessions').pluck().get()).toBe(0);
  });

  it('signs the owner in: 302 to / with an httpOnly SameSite=Lax session cookie', async () => {
    const { app, deps, stub } = await build();
    const { state, stateCookie } = await start(app, '/auth/login');
    const res = await callback(app, state, stateCookie);
    expect(stub.codes).toEqual(['the-code']);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    const raw = setCookies(res).find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).toMatch(new RegExp(`Max-Age=${SESSION_DAYS * 86400}`));
    expect(raw).not.toMatch(/Secure/i);
    // The state cookie is single-use, and each cookie is set exactly once.
    expect(setCookies(res)).toHaveLength(2);
    expect(setCookies(res).find((c) => c.startsWith(`${OAUTH_STATE_COOKIE}=;`))).toMatch(/Max-Age=0/);

    const token = cookieValue(res, SESSION_COOKIE)!;
    expect(sessionEmail(deps.db, token, NOW)).toBe(OWNER);
    // Only a hash is stored.
    expect(deps.db.prepare('SELECT token_hash FROM sessions').pluck().get()).not.toBe(token);

    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ email: OWNER });
  });

  it('accepts the owner email case-insensitively', async () => {
    const { app, stub } = await build();
    stub.email = 'Owner@Gmail.com';
    const { state, stateCookie } = await start(app, '/auth/login');
    expect((await callback(app, state, stateCookie)).statusCode).toBe(302);
  });

  it('marks the session cookie Secure when secureCookies is on', async () => {
    const { app } = await build({ secureCookies: true, publicUrl: 'https://mail.example.com' });
    const { location, state, stateCookie, res: startRes } = await start(app, '/auth/login');
    expect(location.searchParams.get('redirect_uri')).toBe('https://mail.example.com/auth/google/callback');
    expect(setCookies(startRes).find((c) => c.startsWith(OAUTH_STATE_COOKIE))).toMatch(/Secure/);
    const res = await callback(app, state, stateCookie);
    expect(setCookies(res).find((c) => c.startsWith(`${SESSION_COOKIE}=`))).toMatch(/Secure/);
  });

  it('rejects a mismatched state with 400 and never exchanges the code', async () => {
    const { app, stub } = await build();
    const { stateCookie } = await start(app, '/auth/login');
    const res = await callback(app, 'login.forged-state-value-000000000000', stateCookie);
    expect(res.statusCode).toBe(400);
    expect(stub.codes).toEqual([]);
  });

  it('rejects a callback without the state cookie with 400', async () => {
    const { app, stub } = await build();
    const { state } = await start(app, '/auth/login');
    const res = await app.inject({ method: 'GET', url: `/auth/google/callback?code=c&state=${encodeURIComponent(state)}` });
    expect(res.statusCode).toBe(400);
    expect(stub.codes).toEqual([]);
  });

  it('turns a Google error (owner cancelled) into 400 without exchanging', async () => {
    const { app, stub } = await build();
    const { state, stateCookie } = await start(app, '/auth/login');
    const res = await app.inject({
      method: 'GET',
      url: `/auth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      headers: { cookie: `${OAUTH_STATE_COOKIE}=${stateCookie}` },
    });
    expect(res.statusCode).toBe(400);
    expect(stub.codes).toEqual([]);
  });
});

describe('GET /auth/google/callback (connect)', () => {
  it('stores the account encrypted and redirects to /?connected=<email>', async () => {
    const { app, deps, stub } = await build();
    const session = `${SESSION_COOKIE}=${createSession(deps.db, OWNER, NOW)}`;
    const { state, stateCookie } = await start(app, '/auth/connect', session);
    stub.email = 'second@gmail.com';
    stub.refreshToken = 'rt-second';
    const res = await callback(app, state, stateCookie, session);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/?connected=second%40gmail.com');
    const accounts = listAccounts(deps.db);
    expect(accounts.map((a) => [a.email, a.status])).toEqual([['second@gmail.com', 'syncing']]);
    expect(getRefreshToken(deps.db, loadOrCreateKey(deps.config.dataDir), accounts[0]!.id)).toBe('rt-second');
    // A connect callback never creates a new session.
    expect(cookieValue(res, SESSION_COOKIE)).toBeUndefined();
  });

  it('fails with 400 when Google returns no refresh token', async () => {
    const { app, deps, stub } = await build();
    const session = `${SESSION_COOKIE}=${createSession(deps.db, OWNER, NOW)}`;
    const { state, stateCookie } = await start(app, '/auth/connect', session);
    stub.refreshToken = null;
    const res = await callback(app, state, stateCookie, session);
    expect(res.statusCode).toBe(400);
    expect(listAccounts(deps.db)).toEqual([]);
  });

  it('requires the session to still be valid at callback time', async () => {
    const { app, deps, stub } = await build();
    const session = `${SESSION_COOKIE}=${createSession(deps.db, OWNER, NOW)}`;
    const { state, stateCookie } = await start(app, '/auth/connect', session);
    stub.refreshToken = 'rt';
    const res = await callback(app, state, stateCookie);
    expect(res.statusCode).toBe(401);
    expect(listAccounts(deps.db)).toEqual([]);
  });
});

describe('session enforcement', () => {
  it('GET /api/accounts without a cookie → 401', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'GET', url: '/api/accounts' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: expect.any(String) });
  });

  it('percent-encoded /api paths get the same session and CSRF guards', async () => {
    const { app } = await build();
    const get = await app.inject({ method: 'GET', url: '/%61pi/accounts' });
    expect(get.statusCode).toBe(401);
    // A last segment with a dot looks like a static file to the public-path check.
    expect((await app.inject({ method: 'DELETE', url: '/%61pi/accounts/acc1.js', headers: { [API_HEADER]: '1' } })).statusCode).toBe(401);
    const post = await app.inject({ method: 'POST', url: '/%61pi/accounts' });
    expect(post.statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/%61pi/accounts/acc1' })).statusCode).toBe(403);
  });

  it('GET /api/events without a cookie → 401', async () => {
    const { app } = await build();
    expect((await app.inject({ method: 'GET', url: '/api/events' })).statusCode).toBe(401);
  });

  it('GET /privacy without a cookie → 200 public HTML', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'GET', url: '/privacy' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('myaccount.google.com/permissions');
    expect(res.body).toMatch(/third part/i);
  });

  it('redirects app pages to /login but serves /login and static assets without a session', async () => {
    const { app } = await build();
    const page = await app.inject({ method: 'GET', url: '/t/abc' });
    expect(page.statusCode).toBe(302);
    expect(page.headers.location).toBe('/login');
    const root = await app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(302);
    const login = await app.inject({ method: 'GET', url: '/login' });
    expect(login.statusCode).toBe(200);
    expect(login.body).toContain('<div id="root">');
    const asset = await app.inject({ method: 'GET', url: '/assets/missing.js' });
    expect(asset.statusCode).not.toBe(302);
  });

  it('serves app pages with a valid session and rejects an expired one', async () => {
    const { app, deps } = await build();
    const fresh = `${SESSION_COOKIE}=${createSession(deps.db, OWNER, NOW)}`;
    expect((await app.inject({ method: 'GET', url: '/t/abc', headers: { cookie: fresh } })).statusCode).toBe(200);
    const old = `${SESSION_COOKIE}=${createSession(deps.db, OWNER, NOW - (SESSION_DAYS * 86400_000 + 1))}`;
    expect((await app.inject({ method: 'GET', url: '/api/accounts', headers: { cookie: old } })).statusCode).toBe(401);
  });

  it('POST /auth/logout deletes the session and clears the cookie', async () => {
    const { app, deps } = await build();
    const token = createSession(deps.db, OWNER, NOW);
    const cookie = `${SESSION_COOKIE}=${token}`;
    const res = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie, [API_HEADER]: '1' } });
    expect(res.statusCode).toBe(200);
    expect(setCookies(res).find((c) => c.startsWith(`${SESSION_COOKIE}=;`))).toMatch(/Max-Age=0/);
    expect(sessionEmail(deps.db, token, NOW)).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });
});

describe('oauth helpers', () => {
  it('readClientFile reads the web key', () => {
    expect(readClientFile(clientFile)).toEqual({ clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET });
  });

  it('readClientFile errors name the file but never echo its contents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sm-bad-'));
    const bad = join(dir, 'client_secret.json');
    writeFileSync(bad, '{"installed":{"client_secret":"leaky-secret"}}');
    expect(() => readClientFile(bad)).toThrow(/client_secret\.json/);
    try {
      readClientFile(bad);
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('leaky-secret');
    }
    expect(() => readClientFile(join(dir, 'missing.json'))).toThrow(/missing\.json/);
  });

  it('redacts code, token and refresh_token from logged URLs', () => {
    const url = '/auth/google/callback?state=s&code=4%2Fsecret-code&token=t&refresh_token=r&scope=x';
    const out = redactUrl(url);
    expect(out).not.toContain('secret-code');
    expect(out).not.toMatch(/token=t\b/);
    expect(out).not.toMatch(/refresh_token=r\b/);
    expect(out).toContain('scope=x');
    expect(reqSerializer({ method: 'GET', url, headers: {}, ip: '127.0.0.1' } as never).url).toBe(out);
    expect(redactUrl('/api/threads?limit=2')).toBe('/api/threads?limit=2');
  });
});
