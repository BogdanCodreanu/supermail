import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { mockApi } from './mock/plugin';
import { buildId, stampBuild } from './src/lib/swBuild';

const api = 'http://127.0.0.1:8787';
// `npm run dev:mock`: the in-memory mock API (web/mock) on its own port instead of the proxy to the real server.
const mock = process.env.MOCK === '1';

/** Gives public/sw.js this build's id, so each release gets its own cache. */
function stampServiceWorker(): Plugin {
  return {
    name: 'supermail-stamp-sw',
    apply: 'build',
    writeBundle(options, bundle) {
      const file = join(options.dir!, 'sw.js');
      writeFileSync(file, stampBuild(readFileSync(file, 'utf8'), buildId(Object.keys(bundle))));
    },
  };
}

export default defineConfig({
  plugins: [react(), stampServiceWorker(), ...(mock ? [mockApi()] : [])],
  resolve: {
    alias: {
      '@supermail/shared': fileURLToPath(new URL('../shared/src/api.ts', import.meta.url)),
    },
  },
  server: mock
    ? { port: 5199, strictPort: true }
    : {
        port: 5173,
        proxy: {
          '/api': { target: api, changeOrigin: false },
          '/auth': { target: api, changeOrigin: false },
          '/privacy': { target: api, changeOrigin: false },
        },
      },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
