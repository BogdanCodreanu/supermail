import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ThreadSummaryDTO } from '@supermail/shared';
import { ThreadRow } from '../src/components/ThreadRow';
import { accountLabels } from '../src/lib/accounts';

const thread: ThreadSummaryDTO = {
  id: 'b:1', accountId: 'b', subject: 'Build ready', snippet: 'ok', fromName: 'Vercel', fromEmail: 'ship@vercel.com',
  lastMessageAt: 100, unread: false, inInbox: true, groupId: 'dev', groupName: 'Dev',
  reason: { source: 'heuristic', text: 'In Dev', at: null }, snoozedUntil: null, hasAttachments: false, suggestRule: false,
};

describe('accountLabels', () => {
  it('uses the first word of the address, then the whole local part, then local@domain to stay unique', () => {
    expect(accountLabels([{ id: 'a', email: 'you@example.com' }, { id: 'b', email: 'work@example.com' }])).toEqual(
      new Map([['a', 'you'], ['b', 'work']]),
    );
    expect(accountLabels([{ id: 'a', email: 'alex.home@example.com' }, { id: 'b', email: 'alex.work@example.com' }])).toEqual(
      new Map([['a', 'alex.home'], ['b', 'alex.work']]),
    );
    expect(accountLabels([{ id: 'a', email: 'me@gmail.com' }, { id: 'b', email: 'me@example.com' }])).toEqual(
      new Map([['a', 'me@gmail'], ['b', 'me@example']]),
    );
  });
});

describe('ThreadRow in a merged view', () => {
  it('says which account received the email', () => {
    render(<ThreadRow thread={thread} accountColor="#16a34a" account={{ label: 'work', email: 'work@example.com' }} selected={false} onSelect={vi.fn()} onOpen={vi.fn()} />);
    const tag = screen.getByTestId('account-tag');
    expect(tag).toHaveTextContent('work');
    expect(tag).toHaveAttribute('title', 'Received at work@example.com');
  });

  it('shows only the dot when no account tag is given (a single-account view)', () => {
    render(<ThreadRow thread={thread} accountColor="#16a34a" selected={false} onSelect={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.queryByTestId('account-tag')).toBeNull();
    expect(screen.getByTestId('account-dot')).toBeInTheDocument();
  });
});

describe('ThreadRow hover', () => {
  it('moving the mouse over a row selects it, so keyboard actions apply to the hovered email', () => {
    const onSelect = vi.fn();
    render(<ThreadRow thread={thread} accountColor="#16a34a" selected={false} onSelect={onSelect} onOpen={vi.fn()} />);
    fireEvent.mouseMove(screen.getByTestId('thread-row'));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('a row that is already selected is not re-selected on every mouse move', () => {
    const onSelect = vi.fn();
    render(<ThreadRow thread={thread} accountColor="#16a34a" selected onSelect={onSelect} onOpen={vi.fn()} />);
    fireEvent.mouseMove(screen.getByTestId('thread-row'));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('a row sliding under a still mouse (scroll, no mouse move) does not take the selection', () => {
    const onSelect = vi.fn();
    render(<ThreadRow thread={thread} accountColor="#16a34a" selected={false} onSelect={onSelect} onOpen={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTestId('thread-row'));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
