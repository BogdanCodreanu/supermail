import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
    // The suites are big and run in parallel: 5 s is not enough on a busy machine.
    testTimeout: 20_000,
      include: ['test/**/*.test.{ts,tsx}'],
      environment: 'jsdom',
      setupFiles: ['./test/setup.ts'],
    },
  }),
);
