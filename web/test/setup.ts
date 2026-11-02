import { configure } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  try {
    localStorage.clear();
  } catch {
    // some tests make localStorage throw on purpose
  }
});

// findBy*/waitFor default to 1 s, which a loaded machine can miss.
configure({ asyncUtilTimeout: 5_000 });
