import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BottomSheet } from '../src/components/BottomSheet';
import { whenBackSettled } from '../src/components/phone/backStack';

describe('BottomSheet', () => {
  // The sheet a test leaves behind goes back through history; a popstate before that lands would be taken for it.
  beforeEach(() => new Promise<void>((done) => whenBackSettled(done)));

  it('is a labelled modal in a portal, and takes focus', () => {
    render(<BottomSheet label="Snooze" onClose={vi.fn()}>body</BottomSheet>);
    const sheet = screen.getByRole('dialog', { name: 'Snooze' });
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    expect(sheet).toHaveFocus();
    expect(screen.getByRole('heading', { name: 'Snooze' })).toBeInTheDocument();
  });

  it('closes on Escape, on the scrim, and on the Android back gesture', () => {
    const onClose = vi.fn();
    render(<BottomSheet label="Snooze" onClose={onClose}>body</BottomSheet>);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close', hidden: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
    act(() => void window.dispatchEvent(new PopStateEvent('popstate')));
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
