import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRowGestures, type RowGestureOptions } from '../src/components/phone/useRowGestures';

const WIDTH = 360;

function Row(props: Partial<RowGestureOptions>) {
  const g = useRowGestures({ onLongPress: vi.fn(), ...props });
  return (
    <div data-testid="frame" ref={g.frameRef}>
      <div data-testid="reveal" ref={g.revealRef} />
      <a href="/t/1" data-testid="row" ref={g.rowRef} {...g.handlers}>row</a>
    </div>
  );
}

const row = () => screen.getByTestId('row');
const down = (x = 200, y = 100) => fireEvent.pointerDown(row(), { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y });
const move = (x: number, y = 100) => fireEvent.pointerMove(row(), { pointerId: 1, pointerType: 'touch', clientX: x, clientY: y });
const up = (x: number, y = 100) => fireEvent.pointerUp(row(), { pointerId: 1, pointerType: 'touch', clientX: x, clientY: y });

describe('useRowGestures', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: WIDTH, left: 0, top: 0, right: WIDTH, bottom: 72, height: 72, x: 0, y: 0, toJSON: () => ({}) });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const finishAnimation = () => act(() => void vi.advanceTimersByTime(600));

  it('follows the finger once the move is clearly sideways', () => {
    render(<Row right={{ onCommit: vi.fn() }} />);
    down(100);
    move(150);
    expect(row().style.transform).toContain('px');
    expect(row().style.transform).not.toBe('');
  });

  it('commits a right drag past 25% of the width', () => {
    const onCommit = vi.fn();
    render(<Row right={{ onCommit }} />);
    down(50);
    move(100);
    move(50 + WIDTH * 0.4);
    up(50 + WIDTH * 0.4);
    finishAnimation();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('commits a left drag past 25% of the width', () => {
    const onCommit = vi.fn();
    render(<Row left={{ onCommit }} />);
    down(320);
    move(280);
    move(320 - WIDTH * 0.4);
    up(320 - WIDTH * 0.4);
    finishAnimation();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('a quick flick commits well short of the distance a slow drag needs, as a real thumb swipes', () => {
    const onCommit = vi.fn();
    render(<Row left={{ onCommit }} />);
    down(250);
    act(() => void vi.advanceTimersByTime(30));
    move(220);
    act(() => void vi.advanceTimersByTime(30));
    move(180);
    act(() => void vi.advanceTimersByTime(30));
    move(170);
    up(170);
    finishAnimation();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('a thumb arcing upwards on the way across still swipes', () => {
    const onCommit = vi.fn();
    render(<Row right={{ onCommit }} />);
    down(60, 200);
    move(72, 190);
    move(200, 150);
    up(200, 150);
    finishAnimation();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('a short slow nudge still does nothing', () => {
    const onCommit = vi.fn();
    render(<Row right={{ onCommit }} />);
    down(100);
    act(() => void vi.advanceTimersByTime(300));
    move(130);
    act(() => void vi.advanceTimersByTime(300));
    move(150);
    act(() => void vi.advanceTimersByTime(300));
    up(150);
    finishAnimation();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('springs back and does nothing below the threshold', () => {
    const onCommit = vi.fn();
    render(<Row right={{ onCommit }} />);
    down(50);
    move(100);
    act(() => void vi.advanceTimersByTime(300));
    move(50 + WIDTH * 0.2);
    act(() => void vi.advanceTimersByTime(300));
    up(50 + WIDTH * 0.2);
    finishAnimation();
    expect(onCommit).not.toHaveBeenCalled();
    expect(row().style.transform).toBe('');
  });

  it('springs back when the finger returns under the threshold before lifting', () => {
    const onCommit = vi.fn();
    render(<Row right={{ onCommit }} />);
    down(50);
    move(100);
    move(50 + WIDTH * 0.4);
    move(60 + WIDTH * 0.1);
    up(60 + WIDTH * 0.1);
    finishAnimation();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('buzzes once on crossing the threshold, and again only after coming back', () => {
    const vibrate = vi.fn();
    vi.stubGlobal('navigator', { ...navigator, vibrate });
    render(<Row right={{ onCommit: vi.fn() }} />);
    down(50);
    move(100);
    move(50 + WIDTH * 0.4);
    move(50 + WIDTH * 0.45);
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledWith(10);
    move(70);
    move(50 + WIDTH * 0.4);
    expect(vibrate).toHaveBeenCalledTimes(2);
  });

  it('works where the browser cannot vibrate', () => {
    vi.stubGlobal('navigator', { ...navigator, vibrate: undefined });
    const onCommit = vi.fn();
    render(<Row right={{ onCommit }} />);
    down(50);
    move(100);
    move(50 + WIDTH * 0.4);
    up(50 + WIDTH * 0.4);
    finishAnimation();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('lets a vertical scroll win: a mostly vertical move never swipes, even if it drifts sideways later', () => {
    const onCommit = vi.fn();
    render(<Row right={{ onCommit }} />);
    down(100, 100);
    move(104, 130);
    move(100 + WIDTH * 0.5, 140);
    up(100 + WIDTH * 0.5, 140);
    finishAnimation();
    expect(onCommit).not.toHaveBeenCalled();
    expect(row().style.transform).toBe('');
  });

  it('ignores a touch that starts within 24px of the left edge, for the Android back gesture', () => {
    const onCommit = vi.fn();
    const onLongPress = vi.fn();
    render(<Row right={{ onCommit }} onLongPress={onLongPress} />);
    down(23);
    move(100);
    move(23 + WIDTH * 0.5);
    up(23 + WIDTH * 0.5);
    finishAnimation();
    expect(onCommit).not.toHaveBeenCalled();
    expect(row().style.transform).toBe('');
  });

  it('accepts a touch from 24px in', () => {
    const onCommit = vi.fn();
    render(<Row right={{ onCommit }} />);
    down(24);
    move(70);
    move(24 + WIDTH * 0.5);
    up(24 + WIDTH * 0.5);
    finishAnimation();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('has no swipe in a direction with no action, as on Spam and Skipped', () => {
    const onCommit = vi.fn();
    render(<Row right={{ onCommit }} />);
    down(320);
    move(280);
    move(100);
    up(100);
    finishAnimation();
    expect(onCommit).not.toHaveBeenCalled();
    expect(row().style.transform).toBe('');
  });

  it('springs back when the browser takes the touch over', () => {
    const onCommit = vi.fn();
    render(<Row right={{ onCommit }} />);
    down(50);
    move(100);
    move(50 + WIDTH * 0.5);
    fireEvent.pointerCancel(row(), { pointerId: 1, pointerType: 'touch' });
    finishAnimation();
    expect(onCommit).not.toHaveBeenCalled();
    expect(row().style.transform).toBe('');
  });

  it('leaves the mouse alone', () => {
    const onCommit = vi.fn();
    render(<Row right={{ onCommit }} />);
    fireEvent.pointerDown(row(), { pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: 50, clientY: 100 });
    fireEvent.pointerMove(row(), { pointerId: 1, pointerType: 'mouse', clientX: 300, clientY: 100 });
    fireEvent.pointerUp(row(), { pointerId: 1, pointerType: 'mouse', clientX: 300, clientY: 100 });
    finishAnimation();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('opens the long-press action after 450ms, not before', () => {
    const onLongPress = vi.fn();
    render(<Row onLongPress={onLongPress} />);
    down();
    act(() => void vi.advanceTimersByTime(449));
    expect(onLongPress).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('cancels the long-press when the finger moves or lifts', () => {
    const onLongPress = vi.fn();
    render(<Row onLongPress={onLongPress} />);
    down(100, 100);
    move(100, 125);
    act(() => void vi.advanceTimersByTime(600));
    expect(onLongPress).not.toHaveBeenCalled();
    up(100, 125);
    down(100, 100);
    up(100, 100);
    act(() => void vi.advanceTimersByTime(600));
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('keeps the long-press through a small tremor of the finger', () => {
    const onLongPress = vi.fn();
    render(<Row onLongPress={onLongPress} />);
    down(100, 100);
    move(103, 102);
    act(() => void vi.advanceTimersByTime(450));
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('swallows the context menu and the click after a long-press, so the link does not open', () => {
    const onLongPress = vi.fn();
    const onClick = vi.fn((e: MouseEvent) => e.preventDefault());
    render(<Row onLongPress={onLongPress} />);
    row().addEventListener('click', onClick);
    down();
    act(() => void vi.advanceTimersByTime(450));
    expect(fireEvent.contextMenu(row())).toBe(false);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    up(200);
    fireEvent.click(row());
    expect(onClick).not.toHaveBeenCalled();
  });

  describe('lifting the finger after a long-press', () => {
    /** What Chrome does on the lift: a tap on whatever opened under the finger. */
    function sheetButton() {
      const onClick = vi.fn();
      const b = document.createElement('button');
      b.addEventListener('click', onClick);
      document.body.append(b);
      return { b, onClick };
    }
    const press = () => {
      down();
      act(() => void vi.advanceTimersByTime(450));
    };

    it('does not close the sheet or run the item under it', () => {
      const { b, onClick } = sheetButton();
      render(<Row />);
      press();
      up(200);
      b.click();
      expect(onClick).not.toHaveBeenCalled();
      b.remove();
    });

    it('swallows that tap however long the finger stayed down', () => {
      const { b, onClick } = sheetButton();
      render(<Row />);
      press();
      act(() => void vi.advanceTimersByTime(5_000));
      up(200);
      b.click();
      expect(onClick).not.toHaveBeenCalled();
      b.remove();
    });

    it('swallows only that one tap', () => {
      const { b, onClick } = sheetButton();
      render(<Row />);
      press();
      up(200);
      b.click();
      b.click();
      expect(onClick).toHaveBeenCalledTimes(1);
      b.remove();
    });

    it('leaves the next real tap alone when the lift made none', () => {
      const { b, onClick } = sheetButton();
      render(<Row />);
      press();
      up(200);
      act(() => void vi.advanceTimersByTime(600));
      b.click();
      expect(onClick).toHaveBeenCalledTimes(1);
      b.remove();
    });

    it('leaves taps alone once the browser has taken the touch over', () => {
      const { b, onClick } = sheetButton();
      render(<Row />);
      press();
      fireEvent.pointerCancel(row(), { pointerId: 1, pointerType: 'touch' });
      act(() => void vi.advanceTimersByTime(600));
      b.click();
      expect(onClick).toHaveBeenCalledTimes(1);
      b.remove();
    });
  });

  it('swallows the click after a swipe', () => {
    const onClick = vi.fn((e: MouseEvent) => e.preventDefault());
    render(<Row right={{ onCommit: vi.fn() }} />);
    row().addEventListener('click', onClick);
    down(50);
    move(100);
    up(100);
    fireEvent.click(row());
    expect(onClick).not.toHaveBeenCalled();
  });

  it('leaves a plain tap to the link', () => {
    const onClick = vi.fn((e: MouseEvent) => e.preventDefault());
    render(<Row right={{ onCommit: vi.fn() }} />);
    row().addEventListener('click', onClick);
    down(100, 100);
    up(100, 100);
    fireEvent.click(row());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('opens the sheet on a right-click, which is how a mouse reaches it in a narrow window', () => {
    const onLongPress = vi.fn();
    render(<Row onLongPress={onLongPress} />);
    expect(fireEvent.contextMenu(row())).toBe(false);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('does nothing while disabled, as in selection mode', () => {
    const onCommit = vi.fn();
    const onLongPress = vi.fn();
    render(<Row right={{ onCommit }} onLongPress={onLongPress} disabled />);
    down(50);
    move(100);
    move(300);
    up(300);
    act(() => void vi.advanceTimersByTime(600));
    expect(onCommit).not.toHaveBeenCalled();
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('drops a timer and an animation still running when the row unmounts', () => {
    const onCommit = vi.fn();
    const onLongPress = vi.fn();
    const { unmount } = render(<Row right={{ onCommit }} onLongPress={onLongPress} />);
    down(50);
    unmount();
    act(() => void vi.advanceTimersByTime(600));
    expect(onLongPress).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
