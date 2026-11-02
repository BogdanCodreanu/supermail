import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateGroupRequest, GroupDTO, TeachPreviewDTO, ThreadSummaryDTO } from '@supermail/shared';

const api = vi.hoisted(() => ({ teachPreview: vi.fn(), createGroup: vi.fn(), groups: vi.fn() }));
vi.mock('../src/api/client', async (importOriginal) => ({ ...(await importOriginal<object>()), api }));

import { GroupPicker } from '../src/components/GroupPicker';
import { GROUP_PALETTE } from '../src/lib/newGroup';

const group = (id: string, name: string, position: number, color = '#64748b'): GroupDTO => ({ id, name, position, color, notify: true, kind: 'builtin', inboxCount: 0, unreadCount: 0 });
const GROUPS = [group('important', 'Important', 0), group('dev', 'Dev', 1), group('news', 'News', 2)];
const thread: ThreadSummaryDTO = {
  id: 'a:1', accountId: 'a', subject: 'Weekend la Brașov?', snippet: '', fromName: 'Jordan', fromEmail: 'jordan@x.com', lastMessageAt: 1, unread: false, inInbox: true,
  groupId: 'important', groupName: 'Important', reason: { source: 'default', text: '', at: null }, snoozedUntil: null, hasAttachments: false, suggestRule: false,
};
const PREVIEW: TeachPreviewDTO = {
  subject: thread.subject, senderName: 'Jordan', sender: { value: 'jordan@x.com', count: 12 }, domain: { value: 'x.com', count: 40 }, list: { value: 'list.x.com', count: 8 },
};

const onPick = vi.fn();
const onClose = vi.fn();

async function open(groups = GROUPS) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <GroupPicker open thread={thread} groups={groups} onPick={onPick} onClose={onClose} />
    </QueryClientProvider>,
  );
  await screen.findByRole('radio', { name: /Everyone at x\.com · 40/ });
  return { qc, input: screen.getByRole('textbox', { name: 'Filter groups' }) };
}

beforeEach(() => {
  for (const fn of [onPick, onClose, api.teachPreview, api.createGroup, api.groups]) fn.mockReset();
  api.teachPreview.mockResolvedValue(PREVIEW);
  api.createGroup.mockImplementation(async (r: CreateGroupRequest) => group('g-new', r.name, 9, r.color));
});

describe('GroupPicker', () => {
  it('names the email in its header', async () => {
    await open();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Jordan')).toBeInTheDocument();
    expect(within(dialog).getByText('Weekend la Brașov?')).toBeInTheDocument();
  });

  it('offers the scopes with counts, the sender first chosen', async () => {
    await open();
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual(['Only this email', 'All from jordan@x.com · 12', 'Everyone at x.com · 40', 'This mailing list · 8']);
    expect(screen.getByRole('radio', { name: /All from/ })).toBeChecked();
  });

  it('left and right change the scope while the filter has focus', async () => {
    const { input } = await open();
    fireEvent.keyDown(input, { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: /Everyone at/ })).toBeChecked();
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    expect(screen.getByRole('radio', { name: /Only this email/ })).toBeChecked();
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    expect(screen.getByRole('radio', { name: /This mailing list/ })).toBeChecked();
  });

  it('a click changes the scope and leaves the focus in the filter', async () => {
    const { input } = await open();
    fireEvent.click(screen.getByRole('radio', { name: /Everyone at/ }));
    expect(screen.getByRole('radio', { name: /Everyone at/ })).toBeChecked();
    expect(onPick).not.toHaveBeenCalled();
    expect(input).toHaveFocus();
  });

  it('picking a group applies the chosen scope', async () => {
    const { input } = await open();
    fireEvent.keyDown(input, { key: 'ArrowRight' });
    fireEvent.click(screen.getByRole('button', { name: 'Dev' }));
    expect(onPick).toHaveBeenCalledWith({ id: 'dev', name: 'Dev' }, 'domain');
  });

  it('Enter picks the highlighted group', async () => {
    const { input } = await open();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith({ id: 'dev', name: 'Dev' }, 'sender');
  });

  it('offers to create a group when nothing has that exact name', async () => {
    const { input } = await open();
    fireEvent.change(input, { target: { value: 'de' } });
    expect(screen.getByRole('button', { name: 'Dev' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create group "de"' })).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'DEV ' } });
    expect(screen.queryByRole('button', { name: /Create group/ })).toBeNull();
    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.queryByRole('button', { name: /Create group/ })).toBeNull();
  });

  it('Enter creates the group with the first unused colour and applies the scope', async () => {
    const { input } = await open([group('important', 'Important', 0, GROUP_PALETTE[0]), group('dev', 'Dev', 1, GROUP_PALETTE[1]!.toUpperCase())]);
    fireEvent.change(input, { target: { value: ' Travel ' } });
    fireEvent.keyDown(input, { key: 'ArrowRight' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onPick).toHaveBeenCalledWith({ id: 'g-new', name: 'Travel' }, 'domain'));
    expect(api.createGroup).toHaveBeenCalledWith({ name: 'Travel', color: GROUP_PALETTE[2] });
  });

  it('a click on the row creates it too, and the new group lands in the group caches', async () => {
    const { qc, input } = await open();
    qc.setQueryData(['groups', null], GROUPS);
    fireEvent.change(input, { target: { value: 'Travel' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create group "Travel"' }));
    await waitFor(() => expect(onPick).toHaveBeenCalled());
    expect(qc.getQueryData<GroupDTO[]>(['groups', null])!.map((g) => g.id)).toContain('g-new');
  });

  it('after arrowing past a partial match, Enter on the row creates', async () => {
    const { input } = await open();
    fireEvent.change(input, { target: { value: 'de' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.createGroup).toHaveBeenCalledWith(expect.objectContaining({ name: 'de' })));
  });

  it('shows an error inline and stays open', async () => {
    api.createGroup.mockRejectedValue(new Error('A group named "Travel" already exists'));
    const { input } = await open();
    fireEvent.change(input, { target: { value: 'Travel' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByRole('alert')).toHaveTextContent('A group named "Travel" already exists');
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('creates once, however fast Enter is pressed', async () => {
    let finish!: (g: GroupDTO) => void;
    api.createGroup.mockReturnValue(new Promise((r) => (finish = r)));
    const { input } = await open();
    fireEvent.change(input, { target: { value: 'Travel' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(api.createGroup).toHaveBeenCalledTimes(1);
    finish(group('g-new', 'Travel', 9));
    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
  });
});
