import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { createMockApi } from './handler';

/** New mail arrives over `/api/events` this often. */
export const INCOMING_EVERY_MS = 45_000;
const HEARTBEAT_MS = 25_000;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('error', reject);
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(Symbol.for('invalid-json'));
      }
    });
  });
}

/**
 * Dev-only Vite plugin: answers `/api/*` and `/auth/*` from the in-memory mock (mock/handler.ts), so the UI runs
 * without Google sign-in. `apply: 'serve'` keeps it out of `vite build` even when MOCK=1 is set.
 */
export function mockApi(): Plugin {
  return {
    name: 'supermail-mock-api',
    apply: 'serve',
    configureServer(server) {
      const api = createMockApi();
      const streams = new Set<ServerResponse>();
      const incoming = setInterval(() => api.tick(), INCOMING_EVERY_MS);
      const heartbeat = setInterval(() => {
        for (const res of streams) res.write(': heartbeat\n\n');
      }, HEARTBEAT_MS);
      api.subscribe((e) => {
        for (const res of streams) res.write(`data: ${JSON.stringify(e)}\n\n`);
      });
      server.httpServer?.once('close', () => {
        clearInterval(incoming);
        clearInterval(heartbeat);
        for (const res of streams) res.end();
      });

      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '/';
        if (!url.startsWith('/api/') && !url.startsWith('/auth/')) return next();

        if (url === '/api/events' || url.startsWith('/api/events?')) {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
          res.write('retry: 5000\n: connected\n\n');
          streams.add(res);
          req.on('close', () => streams.delete(res));
          return;
        }

        void readBody(req).then((body) => {
          const out =
            body === Symbol.for('invalid-json')
              ? { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ error: 'invalid JSON body' }) }
              : api.handle({ method: req.method ?? 'GET', url, headers: req.headers, body });
          res.writeHead(out.status, out.headers);
          res.end(out.body);
        }, next);
      });

      server.config.logger.info(`  SuperMail mock API: ${api.world.threads.length} threads, new mail every ${INCOMING_EVERY_MS / 1000} s`);
    },
  };
}
