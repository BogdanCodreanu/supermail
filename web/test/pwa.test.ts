import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildId, stampBuild } from '../src/lib/swBuild';
import { registerServiceWorker } from '../src/lib/registerServiceWorker';

const file = (name: string) => join(dirname(fileURLToPath(import.meta.url)), '..', name);
const pub = (name: string) => file(`public/${name}`);
const ORIGIN = 'https://mail.example.com';

type Listener = (e: never) => void;

/** Runs the real sw.js against fake browser parts. */
function loadWorker(stamp = 'build-1', fetched: (req: Req) => Promise<Res> = async () => response()) {
  const listeners = new Map<string, Listener>();
  const stores = new Map<string, Map<string, Res>>();
  const store = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const s = stores.get(name)!;
    return {
      addAll: async (urls: string[]) => void urls.forEach((u) => s.set(u, response())),
      put: async (req: Req, res: Res) => void s.set(new URL(req.url, ORIGIN).pathname, res),
      match: async (req: Req | string, opts?: { ignoreVary?: boolean }) => {
        const hit = s.get(typeof req === 'string' ? req : new URL(req.url, ORIGIN).pathname);
        return hit?.vary && !opts?.ignoreVary ? undefined : hit;
      },
    };
  };
  const caches = {
    open: async (name: string) => store(name),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (req: Req | string) => {
      for (const name of stores.keys()) {
        const hit = await store(name).match(req);
        if (hit) return hit;
      }
      return undefined;
    },
  };
  const self = {
    addEventListener: (type: string, l: Listener) => listeners.set(type, l),
    location: { origin: ORIGIN },
    skipWaiting: vi.fn(async () => {}),
    clients: { claim: vi.fn(async () => {}) },
  };
  const net = vi.fn(fetched);
  new Function('self', 'caches', 'fetch', stampBuild(readFileSync(pub('sw.js'), 'utf8'), stamp))(self, caches, net);
  const run = async (type: string, extra: object = {}) => {
    const waits: Promise<unknown>[] = [];
    let answer: Promise<Res> | undefined;
    (listeners.get(type) as (e: object) => void)({ ...extra, waitUntil: (p: Promise<unknown>) => waits.push(p), respondWith: (p: Promise<Res>) => (answer = p) });
    await Promise.all(waits);
    return answer;
  };
  return { self, stores, net, run, fetchOf: (path: string, init: Partial<Req> = {}) => run('fetch', { request: { url: new URL(path, ORIGIN).href, method: 'GET', mode: 'cors', ...init } }) };
}
interface Req { url: string; method: string; mode: string }
interface Res { ok: boolean; type: string; status: number; vary?: boolean; clone(): Res }
function response(over: Partial<Res> = {}): Res {
  const r: Res = { ok: true, type: 'basic', status: 200, clone: () => r, ...over };
  return r;
}

describe('sw.js: what it leaves alone', () => {
  it.each([
    ['the event stream', '/api/events'],
    ['an attachment download', '/api/threads/a:1/attachments/9?download=1'],
    ['any API read', '/api/me'],
    ['the OAuth redirect', '/auth/google/callback?code=abc&state=xyz'],
    ['sign-in', '/auth/login'],
  ])('never answers %s', async (_, path) => {
    const w = loadWorker();
    expect(await w.fetchOf(path)).toBeUndefined();
    expect(await w.fetchOf(path, { mode: 'navigate' })).toBeUndefined();
  });

  it('leaves writes to the browser', async () => {
    const w = loadWorker();
    expect(await w.fetchOf('/assets/app-abc.js', { method: 'POST' })).toBeUndefined();
  });

  it('leaves other origins to the browser', async () => {
    const w = loadWorker();
    expect(await w.fetchOf('https://lh3.googleusercontent.com/assets/photo.png')).toBeUndefined();
  });
});

describe('sw.js: navigation', () => {
  it('asks the network first and stores nothing, so mail in /t/ pages is never kept', async () => {
    const page = response();
    const w = loadWorker('b', async () => page);
    await w.run('install');
    const before = [...w.stores.get('supermail-b')!.keys()];
    expect(await (await w.fetchOf('/t/a%3A1', { mode: 'navigate' }))).toBe(page);
    expect(w.net).toHaveBeenCalledTimes(1);
    expect([...w.stores.get('supermail-b')!.keys()]).toEqual(before);
  });

  it('passes a redirect through, as a signed-out / goes to /login', async () => {
    const redirect = response({ ok: false, type: 'opaqueredirect', status: 0 });
    const w = loadWorker('b', async () => redirect);
    expect(await (await w.fetchOf('/', { mode: 'navigate' }))).toBe(redirect);
  });

  it('shows the offline page when the network fails', async () => {
    const w = loadWorker('b', async () => {
      throw new TypeError('Failed to fetch');
    });
    await w.run('install');
    const shown = await w.fetchOf('/t/a%3A1', { mode: 'navigate' });
    expect(shown).toBe(w.stores.get('supermail-b')!.get('/offline.html'));
  });

  it('never replays a stored page while online', async () => {
    const fresh = response();
    const w = loadWorker('b', async () => fresh);
    await w.run('install');
    expect(await w.fetchOf('/offline-looking', { mode: 'navigate' })).toBe(fresh);
  });
});

describe('sw.js: hashed assets', () => {
  it('stores a hashed asset and serves it from the cache after that', async () => {
    const w = loadWorker('b');
    await w.fetchOf('/assets/index-abc.js');
    await w.fetchOf('/assets/index-abc.js');
    expect(w.net).toHaveBeenCalledTimes(1);
    expect(w.stores.get('supermail-b')!.has('/assets/index-abc.js')).toBe(true);
  });

  it('finds a stored asset that was sent with Vary: Origin, whichever kind of request asks', async () => {
    const stored = response({ vary: true });
    const w = loadWorker('b', async () => stored);
    await w.fetchOf('/assets/index-abc.js');
    w.net.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await w.fetchOf('/assets/index-abc.js')).toBe(stored);
  });

  it.each([
    ['a failed response', response({ ok: false, status: 500 })],
    ['an opaque response', response({ ok: false, type: 'opaque', status: 0 })],
  ])('does not store %s', async (_, res) => {
    const w = loadWorker('b', async () => res);
    expect(await w.fetchOf('/assets/index-abc.js')).toBe(res);
    expect(w.stores.get('supermail-b')?.has('/assets/index-abc.js') ?? false).toBe(false);
  });
});

describe('sw.js: versions', () => {
  it('caches the app shell under this build at install, and takes over at once', async () => {
    const w = loadWorker('b7');
    await w.run('install');
    const shell = [...w.stores.get('supermail-b7')!.keys()];
    expect(shell).toContain('/offline.html');
    expect(shell).toContain('/manifest.webmanifest');
    expect(shell.every((p) => !/^\/(api|auth|t)\b/.test(p) && p !== '/' && p !== '/index.html')).toBe(true);
    expect(w.self.skipWaiting).toHaveBeenCalled();
  });

  it('every cached file exists in public/, or the install would fail', async () => {
    const w = loadWorker('b7');
    await w.run('install');
    for (const path of w.stores.get('supermail-b7')!.keys()) expect(existsSync(pub(path.slice(1))), path).toBe(true);
  });

  it('drops older builds on activate, keeps this one and anything not ours', async () => {
    const w = loadWorker('new');
    const { caches } = { caches: w.stores };
    caches.set('supermail-old', new Map());
    caches.set('someone-else', new Map());
    await w.run('install');
    await w.run('activate');
    expect([...caches.keys()].sort()).toEqual(['someone-else', 'supermail-new']);
    expect(w.self.clients.claim).toHaveBeenCalled();
  });
});

describe('the build stamp', () => {
  it('leaves a placeholder in the source for the build to fill', () => {
    expect(readFileSync(pub('sw.js'), 'utf8')).toContain('__BUILD__');
  });

  it('replaces every placeholder', () => {
    expect(stampBuild('a __BUILD__ b __BUILD__', 'x1')).toBe('a x1 b x1');
  });

  it('gives a new id to a new set of hashed files, in any order', () => {
    expect(buildId(['a-1.js', 'b-1.css'])).toBe(buildId(['b-1.css', 'a-1.js']));
    expect(buildId(['a-1.js', 'b-1.css'])).not.toBe(buildId(['a-2.js', 'b-1.css']));
  });
});

describe('registering the worker', () => {
  beforeEach(() => vi.stubGlobal('addEventListener', (_: string, l: () => void) => l()));

  it('registers /sw.js in production', () => {
    const register = vi.fn(async () => ({}));
    vi.stubGlobal('navigator', { serviceWorker: { register } });
    registerServiceWorker(true);
    expect(register).toHaveBeenCalledWith('/sw.js');
  });

  it('stays out of development', () => {
    const register = vi.fn(async () => ({}));
    vi.stubGlobal('navigator', { serviceWorker: { register } });
    registerServiceWorker(false);
    expect(register).not.toHaveBeenCalled();
  });

  it('works where the browser has none', () => {
    vi.stubGlobal('navigator', {});
    expect(() => registerServiceWorker(true)).not.toThrow();
  });

  it('keeps a refused registration quiet: the app works without it', async () => {
    const register = vi.fn(async () => {
      throw new Error('no');
    });
    vi.stubGlobal('navigator', { serviceWorker: { register } });
    registerServiceWorker(true);
    await Promise.resolve();
    expect(register).toHaveBeenCalled();
  });
});

describe('manifest.webmanifest', () => {
  const manifest = () => JSON.parse(readFileSync(pub('manifest.webmanifest'), 'utf8')) as Record<string, unknown> & { icons: { src: string; sizes: string; purpose?: string; type: string }[] };
  const pngSize = (path: string) => {
    const b = readFileSync(path);
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
  };

  it('installs standalone at the root', () => {
    expect(manifest()).toMatchObject({ name: 'SuperMail', short_name: 'SuperMail', display: 'standalone', start_url: '/', scope: '/' });
  });

  it('uses a token colour for theme and background', () => {
    const css = readFileSync(file('src/styles.css'), 'utf8');
    expect(css).toContain(`--bg: ${manifest().background_color as string}`);
    expect(css).toContain(`--bg: ${manifest().theme_color as string}`);
  });

  it.each([
    ['icon-192.png', '192x192', undefined],
    ['icon-512.png', '512x512', undefined],
    ['icon-maskable-512.png', '512x512', 'maskable'],
  ])('lists %s at its real size', (src, sizes, purpose) => {
    const icon = manifest().icons.find((i) => i.src === `/${src}`)!;
    expect(icon).toMatchObject({ sizes, type: 'image/png' });
    expect(icon.purpose).toBe(purpose);
    expect(pngSize(pub(src)).join('x')).toBe(sizes);
  });

  it('has a monochrome notification badge: Android uses only its alpha', () => {
    const b = readFileSync(pub('badge-72.png'));
    expect(pngSize(pub('badge-72.png'))).toEqual([72, 72]);
    expect(b[25]).toBe(6); // PNG colour type 6: RGBA
  });

  it('has an opaque apple-touch-icon at 180', () => {
    expect(pngSize(pub('apple-touch-icon.png'))).toEqual([180, 180]);
  });
});

describe('index.html', () => {
  const html = () => readFileSync(file('index.html'), 'utf8');

  it('links the manifest and the touch icon', () => {
    expect(html()).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(html()).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
  });

  it('sets theme-color for both colour schemes, from the tokens', () => {
    expect(html()).toContain('<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff" />');
    expect(html()).toContain('<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0b1120" />');
    expect(html()).not.toContain('content="#2563eb"');
  });
});

describe('offline.html', () => {
  const page = () => readFileSync(pub('offline.html'), 'utf8');

  it('says you are offline and offers Retry', () => {
    expect(page()).toMatch(/You.re offline/);
    expect(page()).toContain('Retry');
  });

  it('needs nothing from the network, and adapts to dark mode', () => {
    expect(page()).not.toMatch(/(src|href)=["'](?!#)/);
    expect(page()).toContain('prefers-color-scheme: dark');
  });
});
