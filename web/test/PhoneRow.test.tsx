import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { Check, Clock } from 'lucide-react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThreadSummaryDTO } from '@supermail/shared';
import { ThreadRow, type ThreadRowProps } from '../src/components/ThreadRow';
import { liftAfterLongPress, pressDown, stubPhone, stubRowWidth, swipe } from './phone';

const thread = (over: Partial<ThreadSummaryDTO> = {}): ThreadSummaryDTO => ({
  id: 'a:1', accountId: 'a', subject: 'The subject', snippet: 'The snippet', fromName: 'Ana', fromEmail: 'irina@example.com', lastMessageAt: Date.UTC(2026, 9, 28, 9), unread: true, inInbox: true,
  groupId: 'dev', groupName: 'Dev', reason: { source: 'mark', text: 'why', at: null }, snoozedUntil: null, hasAttachments: false, suggestRule: false, ...over,
});

function renderRow(over: Partial<ThreadRowProps> = {}) {
  const props: ThreadRowProps = { thread: thread(), accountColor: '#2563eb', selected: false, onSelect: vi.fn(), onOpen: vi.fn(), ...over };
  render(<MemoryRouter><ThreadRow {...props} /></MemoryRouter>);
  return props;
}
const row = () => screen.getByTestId('thread-row');

describe('the phone row', () => {
  beforeEach(() => stubPhone());

  it('is a 72px row of sender and time, subject, then snippet with the chip and the paperclip', () => {
    renderRow({ thread: thread({ hasAttachments: true }), chip: { label: 'Dev', color: '#16a34a' } });
    expect(row().className).toContain('h-[72px]');
    const lines = within(row()).getAllByTestId('row-line');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toHaveTextContent('Ana');
    expect(lines[0]!.querySelector('time')).not.toBeNull();
    expect(lines[0]!.querySelector('[data-testid="account-dot"]')).not.toBeNull();
    expect(lines[1]).toHaveTextContent('The subject');
    expect(lines[2]).toHaveTextContent('Dev');
    expect(lines[2]).toHaveTextContent('The snippet');
    expect(within(lines[2]!).getByTestId('attachment-icon')).toBeInTheDocument();
  });

  it('sets sender and subject in the 15px body size', () => {
    renderRow();
    const lines = within(row()).getAllByTestId('row-line');
    expect(lines[0]!.querySelector('[data-testid="row-sender"]')!.className).toContain('text-base');
    expect(lines[1]!.className).toContain('text-base');
  });

  it('bolds the sender and keeps the 2px accent bar only when unread', () => {
    renderRow();
    expect(screen.getByTestId('row-sender').className).toContain('font-semibold');
    expect(row().className).toContain('border-l-accent');
  });

  it('has no bold and no bar when read', () => {
    renderRow({ thread: thread({ unread: false }) });
    expect(screen.getByTestId('row-sender').className).not.toContain('font-semibold');
    expect(row().className).toContain('border-l-transparent');
  });

  it('opens the email on tap', () => {
    const p = renderRow();
    fireEvent.click(row());
    expect(p.onSelect).toHaveBeenCalled();
    expect(p.onOpen).toHaveBeenCalledTimes(1);
  });

  it('stays a real link and a list option', () => {
    renderRow({ href: '/spam/a%3A1' });
    expect(row()).toHaveAttribute('role', 'option');
    expect(row()).toHaveAttribute('href', '/spam/a%3A1');
  });

  it('has no hover actions, shortcuts or tooltip-only control', () => {
    renderRow({ actions: [{ label: 'Done', keyHint: 'e', icon: Check, run: vi.fn() }], onToggle: vi.fn() });
    expect(screen.queryByRole('button', { name: 'Done', hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Select/, hidden: true })).not.toBeInTheDocument();
  });

  it('keeps the browser off text selection and panning sideways', () => {
    renderRow();
    expect(row().className).toContain('touch-pan-y');
    expect(row().className).toContain('select-none');
    expect(row()).toHaveAttribute('draggable', 'false');
  });

  it('dims a done row but not its frame', () => {
    renderRow({ dimmed: true });
    expect(row()).toHaveAttribute('data-done', 'true');
    expect(row().className).toContain('[&>*]:opacity-60');
  });
});

describe('swiping a phone row', () => {
  beforeEach(() => {
    stubPhone();
    stubRowWidth();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const swipes = () => ({
    right: { label: 'Done', icon: Check, tone: 'done' as const, onCommit: vi.fn() },
    left: { label: 'Snooze', icon: Clock, tone: 'snooze' as const, onCommit: vi.fn(), stays: true },
  });

  it('does the right action past the threshold, and selects the row first', () => {
    const s = swipes();
    const p = renderRow({ swipe: s });
    swipe(row(), 50, 250);
    act(() => void vi.advanceTimersByTime(300));
    expect(s.right.onCommit).toHaveBeenCalledTimes(1);
    expect(p.onSelect).toHaveBeenCalled();
    expect(p.onOpen).not.toHaveBeenCalled();
  });

  it('does the left action past the threshold', () => {
    const s = swipes();
    renderRow({ swipe: s });
    swipe(row(), 320, 100);
    expect(s.left.onCommit).toHaveBeenCalledTimes(1);
  });

  it('reveals the action behind the row, by name and icon, on the side it comes from', () => {
    const s = swipes();
    renderRow({ swipe: s });
    const reveal = screen.getByTestId('swipe-reveal');
    expect(reveal).toHaveAttribute('aria-hidden', 'true');
    expect(within(reveal).getByTestId('reveal-right')).toHaveTextContent('Done');
    expect(within(reveal).getByTestId('reveal-left')).toHaveTextContent('Snooze');
    fireEvent.pointerDown(row(), { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 50, clientY: 100 });
    fireEvent.pointerMove(row(), { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100 });
    expect(reveal).toHaveAttribute('data-side', 'right');
    expect(reveal).toHaveAttribute('data-armed', 'false');
    fireEvent.pointerMove(row(), { pointerId: 1, pointerType: 'touch', clientX: 250, clientY: 100 });
    expect(reveal).toHaveAttribute('data-armed', 'true');
  });

  it('has no swipe left on a list with none, as on Spam and Skipped', () => {
    const right = { label: 'Not spam', icon: Check, tone: 'done' as const, onCommit: vi.fn() };
    renderRow({ swipe: { right } });
    expect(screen.queryByTestId('reveal-left')).not.toBeInTheDocument();
    swipe(row(), 320, 100);
    act(() => void vi.advanceTimersByTime(300));
    expect(right.onCommit).not.toHaveBeenCalled();
  });

  it('opens the long-press action, and selects the row first', () => {
    const onLongPress = vi.fn();
    const p = renderRow({ onLongPress });
    pressDown(row());
    act(() => void vi.advanceTimersByTime(450));
    liftAfterLongPress(row());
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(p.onSelect).toHaveBeenCalled();
  });
});

describe('a phone row in selection mode', () => {
  beforeEach(() => {
    stubPhone();
    stubRowWidth();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a checkbox and ticks on tap instead of opening', () => {
    const onToggle = vi.fn();
    const p = renderRow({ selecting: true, onToggle });
    expect(screen.getByTestId('row-checkbox')).toBeInTheDocument();
    fireEvent.click(row());
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(p.onOpen).not.toHaveBeenCalled();
  });

  it('marks a ticked row', () => {
    renderRow({ selecting: true, checked: true, onToggle: vi.fn() });
    expect(row()).toHaveAttribute('aria-checked', 'true');
    expect(row().className).toContain('bg-sel');
  });

  it('does not swipe or long-press', () => {
    const right = { label: 'Done', icon: Check, tone: 'done' as const, onCommit: vi.fn() };
    const onLongPress = vi.fn();
    renderRow({ selecting: true, onToggle: vi.fn(), swipe: { right }, onLongPress });
    swipe(row(), 50, 250);
    pressDown(row());
    act(() => void vi.advanceTimersByTime(600));
    expect(right.onCommit).not.toHaveBeenCalled();
    expect(onLongPress).not.toHaveBeenCalled();
  });
});

describe('the computer row', () => {
  it('stays the one-line row, whatever a screen offers the phone', () => {
    renderRow({ swipe: {}, onLongPress: vi.fn() });
    expect(row().className).toContain('h-9');
    expect(screen.queryByTestId('swipe-reveal')).not.toBeInTheDocument();
  });
});

describe('PhoneRow account tag', () => {
  it('says which account received it, in the merged inbox', () => {
    stubPhone();
    const { container } = render(<MemoryRouter><ThreadRow thread={thread()} accountColor="#16a34a" account={{ label: 'work', email: 'work@example.com' }} selected={false} onSelect={vi.fn()} onOpen={vi.fn()} /></MemoryRouter>);
    const tag = container.querySelector('[data-testid="account-tag"]');
    expect(tag).toHaveTextContent('work');
    expect(tag).toHaveAttribute('title', 'Received at work@example.com');
  });
});
