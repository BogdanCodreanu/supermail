import { existsSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { API_HEADER } from '@supermail/shared';
import { isApiRequest, requestPath } from '../auth/sessions.js';
import type { AppConfig } from '../config.js';
import type { DB } from '../db/index.js';
import { bus } from '../events.js';
import type { GmailApi } from '../google/gmailApi.js';
import type { PushService } from '../push/service.js';

export type ThreadHook = (threadId: string, reason: 'new' | 'changed') => void;
export interface StorageGate { canIndexMore(): boolean; canCacheBodies(): boolean }
export interface AppDeps { db: DB; config: AppConfig; gmailFor: (accountId: string) => GmailApi; now: () => number; onThreadChange: ThreadHook; storage: StorageGate; /** Absent in tests that have nothing to do with notifications. */ push?: PushService }
export const ALLOW_ALL: StorageGate = { canIndexMore: () => true, canCacheBodies: () => true }; // both true; replaced by Task 7 in main.ts
export const NOOP_HOOK: ThreadHook = () => {}; // replaced by Task 5 in main.ts
export type RoutePlugin = (app: FastifyInstance, deps: AppDeps) => Promise<void>;

export interface BuildOptions {
  /** Directory of the built web app. Defaults to `web/dist` at the repo root. */
  webDir?: string;
  logger?: FastifyServerOptions['logger'];
}

export const DEFAULT_WEB_DIR = fileURLToPath(new URL('../../../web/dist/', import.meta.url));
export const SSE_HEARTBEAT_MS = 25_000;

const SAFE_METHODS = new Set(['GET', 'HEAD']);

function isServerPath(req: FastifyRequest): boolean {
  const path = requestPath(req);
  return isApiRequest(req) || path === '/auth' || path.startsWith('/auth/');
}

/**
 * Builds the Fastify app. Route plugins are called in order on the root instance, so hooks they add
 * (for example Task 2's session preHandler) apply to every route, including `/api/events`.
 */
export async function buildApp(deps: AppDeps, plugins: RoutePlugin[], opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, forceCloseConnections: true, trustProxy: '127.0.0.1' });
  const webDir = opts.webDir ?? DEFAULT_WEB_DIR;
  const hasWeb = existsSync(join(webDir, 'index.html'));

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    void reply.status(status).send({ error: status >= 500 ? 'Internal server error' : err.message });
  });

  app.setNotFoundHandler((req, reply) => {
    if (SAFE_METHODS.has(req.method) && !isServerPath(req) && hasWeb) {
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    }
    return reply.status(404).send({ error: 'Not found' });
  });

  // CSRF guard: a cross-site form or fetch cannot add a custom header without CORS preflight. Checked on the
  // decoded path, so a percent-encoded /api path is guarded too.
  app.addHook('onRequest', async (req, reply) => {
    if (isApiRequest(req) && !SAFE_METHODS.has(req.method) && req.headers[API_HEADER] !== '1') {
      return reply.status(403).send({ error: `missing ${API_HEADER} header` });
    }
  });

  if (hasWeb) await app.register(fastifyStatic, { root: webDir, index: 'index.html' });

  for (const plugin of plugins) await plugin(app, deps);

  const streams = new Set<ServerResponse>();
  app.addHook('onClose', async () => {
    for (const res of streams) res.end();
  });

  app.get('/api/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 5000\n: connected\n\n');
    streams.add(res);
    const off = bus.subscribe((e) => {
      res.write(`data: ${JSON.stringify(e)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), SSE_HEARTBEAT_MS);
    const cleanup = () => {
      clearInterval(heartbeat);
      off();
      streams.delete(res);
    };
    req.raw.on('close', cleanup);
    res.on('error', cleanup);
  });

  await app.ready();
  return app;
}
