import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { API_HEADER } from '@supermail/shared';
import type { AppConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { bus } from '../src/events.js';
import { ALLOW_ALL, type AppDeps, buildApp, NOOP_HOOK } from '../src/http/app.js';

const config: AppConfig = {
  port: 8787,
  host: '127.0.0.1',
  dataDir: '/tmp/unused',
  publicUrl: 'http://localhost:8787',
  ownerEmail: 'o@x.com',
  googleClientFile: '/nonexistent/client_secret.json',
  pollSeconds: 30,
  limits: { bodyCacheMB: 1024, indexMB: 1024, logsMB: 50, totalMB: 3072, minFreeDiskGB: 20 },
  secureCookies: false,
};

let webDir: string;
let app: FastifyInstance | undefined;

beforeAll(() => {
  webDir = mkdtempSync(join(tmpdir(), 'sm-web-'));
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>SuperMail</title><div id="root"></div>');
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function deps(): AppDeps {
  return {
    db: openDb(':memory:'),
    config,
    gmailFor: () => {
      throw new Error('no gmail in tests');
    },
    now: () => Date.now(),
    onThreadChange: NOOP_HOOK,
    storage: ALLOW_ALL,
  };
}

describe('buildApp', () => {
  it('rejects non-GET /api requests without the x-supermail header', async () => {
    app = await buildApp(deps(), [], { webDir });
    const res = await app.inject({ method: 'POST', url: '/api/anything' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: expect.any(String) });
  });

  it('lets a non-GET /api request with the header through to routing', async () => {
    app = await buildApp(deps(), [], { webDir });
    const res = await app.inject({ method: 'POST', url: '/api/anything', headers: { [API_HEADER]: '1' } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: expect.any(String) });
  });

  it('serves index.html as the SPA fallback for unknown pages', async () => {
    app = await buildApp(deps(), [], { webDir });
    const res = await app.inject({ method: 'GET', url: '/nonexistent-page' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('<div id="root">');
  });

  it('does not fall back to index.html for /api and /auth paths', async () => {
    app = await buildApp(deps(), [], { webDir });
    for (const url of ['/api/nope', '/auth/nope']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: expect.any(String) });
    }
  });

  it('formats thrown errors as {error}', async () => {
    app = await buildApp(deps(), [
      async (a) => {
        a.get('/api/boom', async () => {
          throw Object.assign(new Error('teapot'), { statusCode: 418 });
        });
      },
    ], { webDir });
    const res = await app.inject({ method: 'GET', url: '/api/boom' });
    expect(res.statusCode).toBe(418);
    expect(res.json()).toEqual({ error: 'teapot' });
  });

  it('registers route plugins with deps', async () => {
    const d = deps();
    app = await buildApp(d, [
      async (a, received) => {
        a.get('/api/ping', async () => ({ same: received === d }));
      },
    ], { webDir });
    const res = await app.inject({ method: 'GET', url: '/api/ping' });
    expect(res.json()).toEqual({ same: true });
  });

  it('streams bus events over SSE at /api/events', async () => {
    app = await buildApp(deps(), [], { webDir });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: ctrl.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    // Wait for the stream to open before publishing.
    while (!buf.includes('\n\n')) buf += decoder.decode((await reader.read()).value, { stream: true });
    bus.publish({ type: 'thread.removed', id: 'a:t1' });
    while (!buf.includes('data: ')) buf += decoder.decode((await reader.read()).value, { stream: true });
    while (!buf.slice(buf.indexOf('data: ')).includes('\n\n')) {
      buf += decoder.decode((await reader.read()).value, { stream: true });
    }
    const line = buf.split('\n').find((l) => l.startsWith('data: '))!;
    expect(JSON.parse(line.slice('data: '.length))).toEqual({ type: 'thread.removed', id: 'a:t1' });
    ctrl.abort();
  });
});

describe('bus', () => {
  it('unsubscribes and isolates throwing listeners', () => {
    const got: string[] = [];
    const offBad = bus.subscribe(() => {
      throw new Error('bad listener');
    });
    const off = bus.subscribe((e) => got.push(e.type));
    bus.publish({ type: 'storage.degraded', degraded: true });
    off();
    offBad();
    bus.publish({ type: 'storage.degraded', degraded: false });
    expect(got).toEqual(['storage.degraded']);
  });
});
