import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { upsertAccount } from '../../accounts/accounts.js';
import {
  createSession,
  deleteSession,
  isAllowedEmail,
  readCookie,
  requestEmail,
  SESSION_COOKIE,
  SESSION_DAYS,
  serializeCookie,
} from '../../auth/sessions.js';
import type { AppConfig } from '../../config.js';
import { loadOrCreateKey } from '../../crypto/tokens.js';
import { HttpError } from '../../errors.js';
import { CONNECT_SCOPES, exchangeCode, type GoogleIdentity, LOGIN_SCOPES, oauthClient } from '../../google/oauth.js';
import type { RoutePlugin } from '../app.js';

export const OAUTH_STATE_COOKIE = 'sm_oauth_state';
const OAUTH_STATE_SECONDS = 600;
const OAUTH_STATE_PATH = '/auth';

export type OAuthMode = 'login' | 'connect';
/** Swaps the authorization code for the verified Google identity; injectable so tests never call Google. */
export type ExchangeCode = (cfg: AppConfig, code: string) => Promise<GoogleIdentity>;

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * `GET /auth/login` (app sign-in, owner or connected accounts only), `GET /auth/connect` (add a Gmail
 * account, needs a session), the shared Google callback, `POST /auth/logout` and `GET /api/me`.
 */
export function createAuthRoutes(opts: { exchangeCode?: ExchangeCode } = {}): RoutePlugin {
  const exchange = opts.exchangeCode ?? exchangeCode;

  return async (app, deps) => {
    const { db, config } = deps;
    let key: Buffer | undefined;
    const tokenKey = (): Buffer => (key ??= loadOrCreateKey(config.dataDir));
    const stateCookie = (value: string, maxAgeSeconds: number) =>
      serializeCookie(OAUTH_STATE_COOKIE, value, { maxAgeSeconds, secure: config.secureCookies, path: OAUTH_STATE_PATH });

    function startOAuth(reply: FastifyReply, mode: OAuthMode) {
      const state = `${mode}.${randomBytes(24).toString('base64url')}`;
      const url = oauthClient(config).generateAuthUrl(
        mode === 'connect'
          ? { scope: CONNECT_SCOPES, state, access_type: 'offline', prompt: 'consent' }
          : { scope: LOGIN_SCOPES, state, prompt: 'select_account' },
      );
      reply.header('set-cookie', stateCookie(state, OAUTH_STATE_SECONDS));
      return reply.redirect(url, 302);
    }

    app.get('/auth/login', async (_req, reply) => startOAuth(reply, 'login'));

    app.get('/auth/connect', async (req, reply) => {
      if (!requestEmail(db, config, req, deps.now())) return reply.redirect('/login', 302);
      return startOAuth(reply, 'connect');
    });

    app.get('/auth/google/callback', async (req, reply) => {
      const q = req.query as Record<string, unknown>;
      const expected = readCookie(req, OAUTH_STATE_COOKIE);
      if (!expected || typeof q.state !== 'string' || !sameString(expected, q.state)) {
        throw new HttpError(400, 'Invalid or expired sign-in state. Start again.');
      }
      reply.header('set-cookie', stateCookie('', 0)); // single use; Fastify appends later set-cookie calls

      const mode = expected.slice(0, expected.indexOf('.'));
      if (mode !== 'login' && mode !== 'connect') throw new HttpError(400, 'Invalid sign-in state');
      if (typeof q.error === 'string') throw new HttpError(400, `Google sign-in did not complete (${q.error.replace(/[^a-z_]/gi, '')})`);
      if (typeof q.code !== 'string' || !q.code) throw new HttpError(400, 'Missing authorization code');

      if (mode === 'connect') {
        if (!requestEmail(db, config, req, deps.now())) throw new HttpError(401, 'Not signed in');
        const id = await exchange(config, q.code);
        if (!id.refreshToken) throw new HttpError(400, 'Google returned no refresh token. Remove SuperMail at myaccount.google.com/permissions and connect again.');
        const account = upsertAccount(db, tokenKey(), id.email, id.refreshToken, deps.now());
        return reply.redirect(`/?connected=${encodeURIComponent(account.email)}`, 302);
      }

      const id = await exchange(config, q.code);
      if (!isAllowedEmail(db, config, id.email)) throw new HttpError(403, 'This Google account is not allowed to sign in to SuperMail');
      const token = createSession(db, id.email, deps.now());
      reply.header('set-cookie', serializeCookie(SESSION_COOKIE, token, { maxAgeSeconds: SESSION_DAYS * 86_400, secure: config.secureCookies }));
      return reply.redirect('/', 302);
    });

    app.post('/auth/logout', async (req, reply) => {
      deleteSession(db, readCookie(req, SESSION_COOKIE));
      reply.header('set-cookie', serializeCookie(SESSION_COOKIE, '', { maxAgeSeconds: 0, secure: config.secureCookies }));
      return { ok: true };
    });

    app.get('/api/me', async (req) => {
      const email = requestEmail(db, config, req, deps.now());
      if (!email) throw new HttpError(401, 'Not signed in');
      return { email };
    });
  };
}

export const authRoutes: RoutePlugin = createAuthRoutes();
