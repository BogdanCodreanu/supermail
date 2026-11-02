import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThreadSummaryDTO } from '@supermail/shared';
import { whenBackSettled } from '../src/components/phone/backStack';
import { RowSheet, threadSheetItems } from '../src/components/phone/RowSheet';
import type { ThreadActions } from '../src/components/ThreadContextMenu';

const thread = (over: Partial<ThreadSummaryDTO> = {}): ThreadSummaryDTO => ({
  id: 'a:1', accountId: 'a', subject: 'The subject', snippet: 's', fromName: 'Ana', fromEmail: 'irina@example.com', lastMessageAt: 1, unread: true, inInbox: true,
  groupId: 'dev', groupName: 'Dev', reason: { source: 'mark', text: 'why', at: null }, snoozedUntil: null, hasAttachments: false, suggestRule: false, ...over,
});
const actions = (): ThreadActions => ({ done: vi.fn(), moveToInbox: vi.fn(), pickSnooze: vi.fn(), reportSpam: vi.fn(), toggleRead: vi.fn(), important: vi.fn(), notImportant: vi.fn(), pickGroup: vi.fn() });
const settled = () => new Promise<void>((r) => whenBackSettled(r));

function show(t: ThreadSummaryDTO, a = actions(), onSelectMode?: () => void) {
  const open = vi.fn();
  const onClose = vi.fn();
  render(<RowSheet thread={t} items={threadSheetItems(t, { open, actions: a, onSelectMode })} onClose={onClose} />);
  return { a, open, onClose };
}
const labels = () => within(screen.getByRole('dialog')).getAllByRole('button').map((b) => b.textContent);

describe('RowSheet', () => {
  beforeEach(settled);

  it('heads the sheet with the sender and the subject', () => {
    show(thread());
    const sheet = screen.getByRole('dialog', { name: 'Actions for The subject' });
    expect(within(sheet).getByText('Ana')).toBeInTheDocument();
    expect(within(sheet).getByText('The subject')).toBeInTheDocument();
  });

  it('offers the actions in the briefed order', () => {
    show(thread(), actions(), vi.fn());
    expect(labels()).toEqual(['Reply', 'Reply all', 'Forward', 'Done', 'Snooze', 'Mark as read', 'Report spam', 'Important to me', 'Not important', 'Move to group', 'Select']);
  });

  it('keeps the list tight, so all eleven actions fit a 360x740 phone without a scrollbar', () => {
    show(thread(), actions(), vi.fn());
    const list = screen.getByRole('button', { name: 'Reply' }).parentElement!;
    expect(list.className).not.toMatch(/\bpy-/);
    expect(list.previousElementSibling!.className).toContain('pb-2');
  });

  it('has no Select where the list cannot select', () => {
    show(thread());
    expect(labels()).not.toContain('Select');
  });

  it('says Mark as unread on a read thread', () => {
    show(thread({ unread: false }));
    expect(labels()).toContain('Mark as unread');
  });

  it('turns Done into Move to inbox on a done thread', () => {
    const { a } = show(thread({ inInbox: false, doneAt: 5 }));
    fireEvent.click(screen.getByRole('button', { name: 'Move to inbox' }));
    expect(a.moveToInbox).toHaveBeenCalledTimes(1);
    expect(a.done).not.toHaveBeenCalled();
  });

  it.each([
    ['Done', 'done'],
    ['Snooze', 'pickSnooze'],
    ['Mark as read', 'toggleRead'],
    ['Report spam', 'reportSpam'],
    ['Important to me', 'important'],
    ['Not important', 'notImportant'],
    ['Move to group', 'pickGroup'],
  ] as const)('%s closes the sheet and runs the existing action', (label, method) => {
    const { a, onClose } = show(thread());
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(a[method]).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Reply', 'reply'],
    ['Reply all', 'replyAll'],
    ['Forward', 'forward'],
  ] as const)('%s opens the composer only after the sheet has left history', async (label, mode) => {
    const { open, onClose } = show(thread());
    await settled();
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    await settled();
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'a:1' }), mode);
  });

  it('enters selection mode from Select', () => {
    const onSelectMode = vi.fn();
    show(thread(), actions(), onSelectMode);
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    expect(onSelectMode).toHaveBeenCalledTimes(1);
  });

  it('gives every item a 48px target with press feedback, and no key hints', () => {
    show(thread());
    for (const item of within(screen.getByRole('dialog')).getAllByRole('button')) {
      expect(item.className).toContain('min-h-12');
      expect(item.className).toContain('active:bg-hover');
      expect(item.className).toContain('touch-manipulation');
      expect(item.querySelector('kbd')).toBeNull();
    }
  });
});
