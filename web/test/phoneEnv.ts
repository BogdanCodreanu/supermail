import { act, cleanup } from '@testing-library/react';
import { vi } from 'vitest';
import { whenBackSettled } from '../src/components/phone/backStack';

/** The phone layout: useIsPhone asks matchMedia. */
export function stubPhone(): void {
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: media.includes('max-width: 767px'),
    media,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

/** Android's keyboard: only the visual viewport shrinks. */
export function stubKeyboard(height: number, offsetTop = 0) {
  const view = Object.assign(new EventTarget(), { height, offsetTop });
  vi.stubGlobal('visualViewport', view);
  vi.stubGlobal('innerHeight', 740);
  return view;
}

/** The Android back gesture, through the real history, as far as it goes. */
export async function pressBack(): Promise<void> {
  await act(async () => {
    window.history.back();
    await new Promise((r) => setTimeout(r, 20));
  });
}

/** Unmounts the sheets and waits for their history entries to go, so the next test starts clean. */
export async function endScreens(): Promise<void> {
  cleanup();
  await new Promise<void>((r) => whenBackSettled(r));
}
