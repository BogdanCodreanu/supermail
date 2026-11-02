import { render, screen, waitFor } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BottomSheet } from '../src/components/BottomSheet';

// jsdom drops a traversal when pushState follows it, so these count the calls that break real Chrome. The netting
// itself is in backStack.test.ts, and the swap was watched in Chrome.
describe('BottomSheet and history', () => {
  // Long enough for a traversal left by the test before to land: it would pop this test's sheet.
  const settle = () => new Promise((r) => setTimeout(r, 30));
  beforeEach(settle);
  afterEach(settle);

  it('pushes one entry and never goes back under StrictMode, which runs effects twice', async () => {
    const push = vi.spyOn(window.history, 'pushState');
    const go = vi.spyOn(window.history, 'go');
    const back = vi.spyOn(window.history, 'back');
    render(
      <StrictMode>
        <BottomSheet label="Snooze" onClose={vi.fn()}>body</BottomSheet>
      </StrictMode>,
    );
    await settle();
    expect(push).toHaveBeenCalledTimes(1);
    expect(go).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
  });

  it('hands its entry to the next sheet instead of going back', async () => {
    const closeSecond = vi.fn();
    function Swap() {
      const [which, setWhich] = useState<'a' | 'b'>('a');
      return which === 'a' ? (
        <BottomSheet key="first" label="First" onClose={vi.fn()}>
          <button type="button" onClick={() => setWhich('b')}>next</button>
        </BottomSheet>
      ) : (
        <BottomSheet key="second" label="Second" onClose={closeSecond}>body</BottomSheet>
      );
    }
    render(<Swap />);
    await settle();
    const push = vi.spyOn(window.history, 'pushState');
    const go = vi.spyOn(window.history, 'go');
    const back = vi.spyOn(window.history, 'back');
    screen.getByRole('button', { name: 'next' }).click();
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Second' })).toBeInTheDocument());
    await settle();
    expect(push).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
    expect(closeSecond).not.toHaveBeenCalled();
  });
});
