import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UndoToast } from '../src/components/UndoToast';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('UndoToast', () => {
  it('is a status message normally and an alert for errors', () => {
    const { rerender } = render(<UndoToast message="Marked done" onClose={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Marked done');
    rerender(<UndoToast message="Couldn't mark done" tone="error" onClose={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't mark done");
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('closes by itself after 5 s by default', () => {
    const onClose = vi.fn();
    render(<UndoToast message="Marked done" onClose={onClose} />);
    act(() => vi.advanceTimersByTime(4_900));
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(200));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('pauses while hovered and resumes with the time that was left', () => {
    const onClose = vi.fn();
    render(<UndoToast message="Marked done" onClose={onClose} />);
    const toast = screen.getByRole('status');
    act(() => vi.advanceTimersByTime(3_000));
    fireEvent.mouseEnter(toast);
    act(() => vi.advanceTimersByTime(60_000));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseLeave(toast);
    act(() => vi.advanceTimersByTime(1_900));
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(200));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('pauses while a control inside it has focus', () => {
    const onClose = vi.fn();
    render(<UndoToast message="Marked done" onUndo={vi.fn()} onClose={onClose} />);
    const undo = screen.getByRole('button', { name: /undo/i });
    fireEvent.focus(undo);
    act(() => vi.advanceTimersByTime(60_000));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.blur(undo);
    act(() => vi.advanceTimersByTime(5_100));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows Undo with its z hint, the follow-up action, and an icon Dismiss button', () => {
    const onUndo = vi.fn();
    const run = vi.fn();
    const onClose = vi.fn();
    render(<UndoToast message="Bolt is important to you" onUndo={onUndo} action={{ label: 'Apply to whole domain', run }} onClose={onClose} />);
    const undo = screen.getByRole('button', { name: /undo/i });
    expect(undo.querySelector('[data-key="z"]')).not.toBeNull();
    fireEvent.click(undo);
    fireEvent.click(screen.getByRole('button', { name: 'Apply to whole domain' }));
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    expect(dismiss.querySelector('svg')).not.toBeNull();
    expect(dismiss).not.toHaveTextContent(/[✕×]/);
    fireEvent.click(dismiss);
    expect([onUndo, run, onClose].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
  });
});
