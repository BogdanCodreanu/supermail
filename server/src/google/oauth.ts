import { readFileSync } from 'node:fs';
import type { FastifyRequest } from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import type { AppConfig } from '../config.js';
import { HttpError } from '../errors.js';

export const LOGIN_SCOPES = ['openid', 'https://www.googleapis.com/auth/userinfo.email'];
export const CONNECT_SCOPES = [...LOGIN_SCOPES, 'https://www.googleapis.com/auth/gmail.modify'];
export const CALLBACK_PATH = '/auth/google/callback';

/**
 * Reads the `web` key of the Google OAuth client JSON. Errors name the file but never include its
 * contents: the file holds the client secret.
 */
export function readClientFile(path: string): { clientId: string; clientSecret: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(code ? `cannot read Google client file ${path} (${code})` : `Google client file ${path} is not valid JSON`);
  }
  const web = (parsed as { web?: { client_id?: unknown; client_secret?: unknown } } | null)?.web;
  if (typeof web?.client_id !== 'string' || typeof web.client_secret !== 'string') {
    throw new Error(`Google client file ${path} has no web.client_id / web.client_secret (expected a "Web application" client)`);
  }
  return { clientId: web.client_id, clientSecret: web.client_secret };
}

export function oauthClient(cfg: AppConfig): OAuth2Client {
  const { clientId, clientSecret } = readClientFile(cfg.googleClientFile);
  return new OAuth2Client({ clientId, clientSecret, redirectUri: `${cfg.publicUrl}${CALLBACK_PATH}` });
}

export interface GoogleIdentity { email: string; refreshToken: string | null }

/**
 * Exchanges an authorization code and verifies the returned id_token. Google client errors carry the
 * request (code, client secret), so they are replaced by a sanitized error before anything can log them.
 */
export async function exchangeCode(cfg: AppConfig, code: string): Promise<GoogleIdentity> {
  const client = oauthClient(cfg);
  try {
    const { tokens } = await client.getToken(code);
    if (!tokens.id_token) throw new HttpError(502, 'Google returned no id_token');
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: readClientFile(cfg.googleClientFile).clientId });
    const payload = ticket.getPayload();
    if (!payload?.email || payload.email_verified !== true) throw new HttpError(403, 'Google account email is not verified');
    return { email: payload.email.toLowerCase(), refreshToken: tokens.refresh_token ?? null };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const reason = (err as { response?: { data?: { error?: unknown } } }).response?.data?.error;
    throw new HttpError(502, `Google token exchange failed${typeof reason === 'string' ? ` (${reason})` : ''}`);
  }
}

const REDACTED_PARAMS = new Set(['code', 'token', 'refresh_token', 'access_token', 'id_token']);

/** Replaces OAuth secrets in a URL's query string with `[redacted]`, keeping everything else as is. */
export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  if (q === -1) return url;
  const params = url.slice(q + 1).split('&').map((part) => {
    const eq = part.indexOf('=');
    const rawName = eq === -1 ? part : part.slice(0, eq);
    let name = rawName;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      // keep the raw name
    }
    return REDACTED_PARAMS.has(name.toLowerCase()) ? `${rawName}=[redacted]` : part;
  });
  return `${url.slice(0, q)}?${params.join('&')}`;
}

/** Fastify `req` log serializer that never writes OAuth codes or tokens to the logs. */
export function reqSerializer(req: FastifyRequest): { method: string; url: string; host: string | undefined; remoteAddress: string } {
  return { method: req.method, url: redactUrl(req.url), host: req.headers.host, remoteAddress: req.ip };
}

export const logSerializers = { req: reqSerializer };
