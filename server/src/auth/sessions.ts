import { createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { AppConfig } from '../config.js';
import type { DB } from '../db/index.js';

export const SESSION_COOKIE = 'sm_session';
export const SESSION_DAYS = 90;
const DAY_MS = 86_400_000;

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Creates a session and returns the raw token for the cookie. Only its sha256 is stored. */
export function createSession(db: DB, email: string, now: number): string {
  const raw = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions(token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    hashToken(raw),
    email.toLowerCase(),
    now,
    now + SESSION_DAYS * DAY_MS,
  );
  return raw;
}

export function sessionEmail(db: DB, rawToken: string | undefined, now: number): string | null {
  if (!rawToken) return null;
  const row = db.prepare('SELECT email, expires_at AS expiresAt FROM sessions WHERE token_hash = ?').get(hashToken(rawToken)) as
    | { email: string; expiresAt: number }
    | undefined;
  if (!row) return null;
  if (row.expiresAt <= now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(rawToken));
    return null;
  }
  return row.email;
}

export function deleteSession(db: DB, rawToken: string | undefined): void {
  if (rawToken) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(rawToken));
}

/** The owner, or the email of any connected account (case-insensitive). */
export function isAllowedEmail(db: DB, cfg: AppConfig, email: string): boolean {
  const e = email.toLowerCase();
  if (e === cfg.ownerEmail.toLowerCase()) return true;
  return db.prepare('SELECT 1 FROM accounts WHERE lower(email) = ?').get(e) !== undefined;
}

/** The signed-in email for this request, or null. The email must still be allowed (account not removed). */
export function requestEmail(db: DB, cfg: AppConfig, req: FastifyRequest, now: number): string | null {
  const email = sessionEmail(db, readCookie(req, SESSION_COOKIE), now);
  return email && isAllowedEmail(db, cfg, email) ? email : null;
}

/**
 * The request path as the router matches it: percent-decoded, without the query. Guards must check this, not
 * the raw URL, or `/%61pi/...` would reach /api routes unchecked. An undecodable path is returned as is.
 */
export function requestPath(req: FastifyRequest): string {
  const q = req.url.indexOf('?');
  const raw = q === -1 ? req.url : req.url.slice(0, q);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/** True for a request to /api, by its decoded path or by the route the router matched. */
export function isApiRequest(req: FastifyRequest): boolean {
  return isApiPath(requestPath(req)) || isApiPath(req.routeOptions.url ?? '');
}

/** Paths reachable without a session: OAuth, the privacy page, the login page and static files. */
function isPublicPath(path: string): boolean {
  if (path === '/auth' || path.startsWith('/auth/')) return true;
  if (path === '/privacy' || path === '/login') return true;
  if (path.startsWith('/assets/')) return true;
  const last = path.slice(path.lastIndexOf('/') + 1);
  return last.includes('.'); // favicon.ico, manifest, service worker…
}

/** 401 for /api/*, a redirect to /login for app pages; /auth/*, /privacy, /login and static files are public. */
export function requireSession(db: DB, cfg: AppConfig, now: () => number = Date.now): preHandlerHookHandler {
  return async (req, reply) => {
    const api = isApiRequest(req);
    if (!api && isPublicPath(requestPath(req))) return;
    if (requestEmail(db, cfg, req, now())) return;
    if (api) return reply.status(401).send({ error: 'Not signed in' });
    return reply.redirect('/login', 302);
  };
}

export function readCookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

export interface CookieOptions { maxAgeSeconds: number; secure: boolean; path?: string }

/** A Set-Cookie value: always httpOnly and SameSite=Lax (the OAuth redirect back from Google is a top-level GET). */
export function serializeCookie(name: string, value: string, o: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${o.path ?? '/'}`, `Max-Age=${o.maxAgeSeconds}`, 'HttpOnly', 'SameSite=Lax'];
  if (o.secure) parts.push('Secure');
  return parts.join('; ');
}
