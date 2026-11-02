import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BottomSheet } from '../src/components/BottomSheet';

const HEIGHT = 400;

describe('BottomSheet focus', () => {
  it('takes focus itself', () => {
    render(<BottomSheet label="Snooze" onClose={vi.fn()}>body</BottomSheet>);
    expect(screen.getByRole('dialog')).toHaveFocus();
  });

  it('leaves it on a field inside that asked for it, or the keyboard would never open', () => {
    render(<BottomSheet label="New group" onClose={vi.fn()}><input aria-label="Name" autoFocus /></BottomSheet>);
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
  });
});

describe('BottomSheet above the keyboard', () => {
  function stubViewport(height: number, offsetTop = 0) {
    const vv = Object.assign(new EventTarget(), { height, offsetTop });
    vi.stubGlobal('visualViewport', vv);
    vi.stubGlobal('innerHeight', 740);
    return vv;
  }
  const backdrop = () => screen.getByRole('dialog').parentElement!;

  it('sits on the keyboard, and goes back down when it closes', () => {
    const vv = stubViewport(740);
    render(<BottomSheet label="Snooze" onClose={vi.fn()}>body</BottomSheet>);
    expect(backdrop().style.bottom).toBe('0px');
    act(() => {
      vv.height = 440;
      vv.dispatchEvent(new Event('resize'));
    });
    expect(backdrop().style.bottom).toBe('300px');
    act(() => {
      vv.height = 740;
      vv.dispatchEvent(new Event('resize'));
    });
    expect(backdrop().style.bottom).toBe('0px');
  });

  it('counts a visual viewport the browser has scrolled', () => {
    const vv = stubViewport(440, 100);
    render(<BottomSheet label="Snooze" onClose={vi.fn()}>body</BottomSheet>);
    expect(backdrop().style.bottom).toBe('200px');
    act(() => {
      vv.offsetTop = 0;
      vv.dispatchEvent(new Event('scroll'));
    });
    expect(backdrop().style.bottom).toBe('300px');
  });

  it('never fits taller than the space left above the keyboard', () => {
    stubViewport(300);
    render(<BottomSheet label="Snooze" onClose={vi.fn()}>body</BottomSheet>);
    expect(screen.getByRole('dialog').style.maxHeight).toBe('min(85dvh, 284px)');
  });

  it('works where the browser has no visual viewport', () => {
    vi.stubGlobal('visualViewport', undefined);
    render(<BottomSheet label="Snooze" onClose={vi.fn()}>body</BottomSheet>);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('BottomSheet drag to close', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 360, left: 0, top: 340, right: 360, bottom: 740, height: HEIGHT, x: 0, y: 340, toJSON: () => ({}) });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const handle = () => screen.getByTestId('sheet-handle');
  const sheet = () => screen.getByRole('dialog');
  const down = (y = 350) => fireEvent.pointerDown(handle(), { pointerId: 1, pointerType: 'touch', clientX: 180, clientY: y });
  const move = (y: number) => fireEvent.pointerMove(handle(), { pointerId: 1, pointerType: 'touch', clientX: 180, clientY: y });
  const up = (y: number) => fireEvent.pointerUp(handle(), { pointerId: 1, pointerType: 'touch', clientX: 180, clientY: y });
  const finish = () => act(() => void vi.advanceTimersByTime(600));

  it('follows the finger down', () => {
    render(<BottomSheet label="Snooze" onClose={vi.fn()}>body</BottomSheet>);
    down(350);
    move(450);
    expect(sheet().style.transform).toBe('translateY(100px)');
  });

  it('does not lift above its resting place', () => {
    render(<BottomSheet label="Snooze" onClose={vi.fn()}>body</BottomSheet>);
    down(350);
    move(250);
    expect(sheet().style.transform).toBe('translateY(0px)');
  });

  it('closes past 30% of its height', () => {
    const onClose = vi.fn();
    render(<BottomSheet label="Snooze" onClose={onClose}>body</BottomSheet>);
    down(350);
    move(350 + HEIGHT * 0.31);
    up(350 + HEIGHT * 0.31);
    finish();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('springs back below 30%', () => {
    const onClose = vi.fn();
    render(<BottomSheet label="Snooze" onClose={onClose}>body</BottomSheet>);
    down(350);
    move(350 + HEIGHT * 0.29);
    up(350 + HEIGHT * 0.29);
    finish();
    expect(onClose).not.toHaveBeenCalled();
    expect(sheet().style.transform).toBe('');
  });

  it('springs back when the browser takes the touch over', () => {
    const onClose = vi.fn();
    render(<BottomSheet label="Snooze" onClose={onClose}>body</BottomSheet>);
    down(350);
    move(350 + HEIGHT * 0.5);
    fireEvent.pointerCancel(handle(), { pointerId: 1, pointerType: 'touch' });
    finish();
    expect(onClose).not.toHaveBeenCalled();
    expect(sheet().style.transform).toBe('');
  });

  it('gives the handle a 44px target that keeps the page from scrolling', () => {
    render(<BottomSheet label="Snooze" onClose={vi.fn()}>body</BottomSheet>);
    expect(handle().className).toContain('h-11');
    expect(handle().className).toContain('touch-none');
  });

  it('does not close after it has gone', () => {
    const onClose = vi.fn();
    const { unmount } = render(<BottomSheet label="Snooze" onClose={onClose}>body</BottomSheet>);
    down(350);
    move(350 + HEIGHT * 0.5);
    up(350 + HEIGHT * 0.5);
    unmount();
    finish();
    expect(onClose).not.toHaveBeenCalled();
  });
});
