import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubPhone } from './phoneEnv';

const { UndoToast } = await import('../src/components/UndoToast');

/** jsdom's PointerEvent has no clientY of its own to speak of: fireEvent fills in what it can. */
function drag(el: Element, from: number, to: number) {
  fireEvent.pointerDown(el, { pointerId: 1, clientY: from });
  fireEvent.pointerMove(el, { pointerId: 1, clientY: to });
}

beforeEach(stubPhone);
afterEach(() => vi.useRealTimers());

describe('the toast on the phone', () => {
  it('spans the screen minus 16px gutters, above the bar or the FAB and the safe area', () => {
    render(<UndoToast message="Done" onClose={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveClass('inset-x-4', 'bottom-[calc(var(--toast-lift)+env(safe-area-inset-bottom))]');
  });

  it('has an Undo of at least 44px, without a key hint, and a 44px dismiss', () => {
    const onUndo = vi.fn();
    render(<UndoToast message="Done" onUndo={onUndo} onClose={vi.fn()} />);
    const undo = screen.getByRole('button', { name: 'Undo' });
    expect(undo).toHaveClass('h-11', 'min-w-11');
    expect(within(undo).queryByText('Z')).toBeNull();
    expect(document.querySelector('kbd')).toBeNull();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toHaveClass('h-11', 'w-11');
    fireEvent.click(undo);
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('follows the finger down and dismisses past the mark', () => {
    const onClose = vi.fn();
    render(<UndoToast message="Done" onClose={onClose} />);
    const toast = screen.getByRole('status');
    drag(toast, 600, 660);
    expect(toast.style.transform).toBe('translateY(60px)');
    fireEvent.pointerUp(toast, { pointerId: 1, clientY: 660 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('springs back from a short drag, or a dragged-upward one', () => {
    const onClose = vi.fn();
    render(<UndoToast message="Done" onClose={onClose} />);
    const toast = screen.getByRole('status');
    drag(toast, 600, 620);
    fireEvent.pointerUp(toast, { pointerId: 1, clientY: 620 });
    expect(onClose).not.toHaveBeenCalled();
    expect(toast.style.transform).toBe('');
    drag(toast, 600, 500);
    expect(toast.style.transform).toBe('');
    fireEvent.pointerUp(toast, { pointerId: 1, clientY: 500 });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('holds its timer while dragged, and a tap never pauses it for good', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<UndoToast message="Done" onClose={onClose} duration={1000} />);
    const toast = screen.getByRole('status');
    fireEvent.mouseEnter(toast); // what a tap sends, with no mouseleave after it
    act(() => void vi.advanceTimersByTime(1000));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a drag that starts on Undo stays a tap', () => {
    const onClose = vi.fn();
    render(<UndoToast message="Done" onUndo={vi.fn()} onClose={onClose} />);
    const undo = screen.getByRole('button', { name: 'Undo' });
    drag(undo, 600, 680);
    fireEvent.pointerUp(undo, { pointerId: 1, clientY: 680 });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('the toast on a computer', () => {
  it('does not move under the pointer', () => {
    vi.unstubAllGlobals();
    const onClose = vi.fn();
    render(<UndoToast message="Done" onClose={onClose} />);
    const toast = screen.getByRole('status');
    drag(toast, 600, 680);
    fireEvent.pointerUp(toast, { pointerId: 1, clientY: 680 });
    expect(toast.style.transform).toBe('');
    expect(onClose).not.toHaveBeenCalled();
  });
});
