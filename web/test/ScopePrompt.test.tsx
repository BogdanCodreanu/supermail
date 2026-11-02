import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeachPreviewDTO, ThreadSummaryDTO } from '@supermail/shared';

const api = vi.hoisted(() => ({ teachPreview: vi.fn() }));
vi.mock('../src/api/client', async (importOriginal) => ({ ...(await importOriginal<object>()), api }));

import { ScopePrompt } from '../src/components/ScopePrompt';

const thread: ThreadSummaryDTO = {
  id: 'a:1', accountId: 'a', subject: 'Weekend la Brașov?', snippet: '', fromName: 'Jordan', fromEmail: 'jordan@x.com', lastMessageAt: 1, unread: false, inInbox: true,
  groupId: 'important', groupName: 'Important', reason: { source: 'default', text: '', at: null }, snoozedUntil: null, hasAttachments: false, suggestRule: false,
};
const PREVIEW: TeachPreviewDTO = {
  subject: thread.subject, senderName: 'Jordan', sender: { value: 'jordan@x.com', count: 12 }, domain: { value: 'x.com', count: 40 }, list: { value: 'list.x.com', count: 8 },
};

const onConfirm = vi.fn();
const onClose = vi.fn();

async function open(over: Partial<Parameters<typeof ScopePrompt>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ScopePrompt open title="Mark as important" thread={thread} confirmKeys={['+']} onConfirm={onConfirm} onClose={onClose} {...over} />
    </QueryClientProvider>,
  );
  await screen.findByRole('radio', { name: /Everyone at x\.com · 40/ });
  return screen.getByRole('dialog', { name: 'Mark as important' });
}

const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    fireEvent.keyDown(document.activeElement!, { key, ...init });
  });

beforeEach(() => {
  onConfirm.mockReset();
  onClose.mockReset();
  api.teachPreview.mockReset();
  api.teachPreview.mockResolvedValue(PREVIEW);
});

describe('ScopePrompt', () => {
  it('names the action and the email, and lists the scopes with their counts', async () => {
    const dialog = await open();
    expect(within(dialog).getByText('Jordan')).toBeInTheDocument();
    expect(within(dialog).getByText('Weekend la Brașov?')).toBeInTheDocument();
    expect(within(dialog).getAllByRole('radio').map((r) => r.textContent)).toEqual([
      expect.stringContaining('Only this email'),
      expect.stringContaining('All from jordan@x.com · 12'),
      expect.stringContaining('Everyone at x.com · 40'),
      expect.stringContaining('This mailing list · 8'),
    ]);
  });

  it('starts on the sender, and puts the focus there so the keys work at once', async () => {
    await open();
    const sender = screen.getByRole('radio', { name: /All from/ });
    expect(sender).toBeChecked();
    expect(sender).toHaveFocus();
  });

  it('Enter confirms the highlighted scope, and the arrows move it', async () => {
    await open();
    press('ArrowDown');
    expect(screen.getByRole('radio', { name: /Everyone at/ })).toBeChecked();
    press('Enter');
    expect(onConfirm).toHaveBeenCalledWith('domain');
  });

  it('the arrows wrap around', async () => {
    await open();
    press('ArrowUp');
    press('ArrowUp');
    expect(screen.getByRole('radio', { name: /This mailing list/ })).toBeChecked();
  });

  it.each([['1', 'thread'], ['2', 'sender'], ['3', 'domain'], ['4', 'list']])('number key %s picks %s directly', async (key, scope) => {
    await open();
    press(key);
    expect(onConfirm).toHaveBeenCalledWith(scope);
  });

  it('a number past the end does nothing', async () => {
    api.teachPreview.mockResolvedValue({ ...PREVIEW, list: null });
    await open();
    press('4');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('the same key again confirms the highlighted scope', async () => {
    await open();
    press('+');
    expect(onConfirm).toHaveBeenCalledWith('sender');
  });

  it('holding the key down does not confirm', async () => {
    await open();
    press('+', { repeat: true });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('another teaching key does not confirm', async () => {
    await open();
    press('-');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('a click confirms that scope', async () => {
    await open();
    fireEvent.click(screen.getByRole('radio', { name: /This mailing list/ }));
    expect(onConfirm).toHaveBeenCalledWith('list');
  });

  it('Escape cancels', async () => {
    await open();
    press('Escape');
    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('keeps other keys from the page shortcuts behind it', async () => {
    const page = vi.fn();
    window.addEventListener('keydown', page);
    await open();
    press('c');
    press('/');
    window.removeEventListener('keydown', page);
    expect(page).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('shows its keys as hints', async () => {
    const dialog = await open();
    for (const key of ['Enter', 'Escape', '+']) expect(dialog.querySelector(`[data-key="${key}"]`)).not.toBeNull();
    expect(dialog.querySelector('[data-key="1"]')).not.toBeNull();
  });

  it('offers no domain for free mail', async () => {
    api.teachPreview.mockResolvedValue({ ...PREVIEW, domain: null, list: null });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ScopePrompt open title="Mark as important" thread={thread} onConfirm={onConfirm} onClose={onClose} />
      </QueryClientProvider>,
    );
    await screen.findByRole('radio', { name: /All from jordan@x\.com · 12/ });
    expect(screen.queryByRole('radio', { name: /Everyone at/ })).toBeNull();
  });

  it('still works while the counts are loading or if they fail', async () => {
    api.teachPreview.mockRejectedValue(new Error('nope'));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ScopePrompt open title="Mark as important" thread={thread} onConfirm={onConfirm} onClose={onClose} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('radio', { name: /All from jordan@x\.com/ })).toBeChecked();
    press('Enter');
    expect(onConfirm).toHaveBeenCalledWith('sender');
  });

  it('starts on this email when the thread has no sender', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    api.teachPreview.mockResolvedValue({ ...PREVIEW, sender: null, domain: null, list: null });
    render(
      <QueryClientProvider client={qc}>
        <ScopePrompt open title="Mark as important" thread={{ ...thread, fromEmail: null, fromName: null }} onConfirm={onConfirm} onClose={onClose} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('radio', { name: /Only this email/ })).toBeChecked();
    expect(screen.queryByRole('radio', { name: /All from/ })).toBeNull();
  });
});
