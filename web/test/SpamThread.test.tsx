import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageDTO, ThreadDetailDTO, ThreadSummaryDTO } from '@supermail/shared';
import { api, ApiError, qk } from '../src/api/client';
import { AppToasts, resetToasts } from '../src/state/toasts';
import { SpamThread } from '../src/views/SpamThread';

vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  return { ...actual, api: { accounts: vi.fn(), spamThread: vi.fn(), notSpam: vi.fn(), undo: vi.fn(), groups: vi.fn(), read: vi.fn() } };
});
const mocked = vi.mocked(api);

const ID = 'a:s1';

const summary: ThreadSummaryDTO = {
  id: ID, accountId: 'a', subject: 'You won a prize', snippet: 'Claim', fromName: 'Prize Dept', fromEmail: 'win@lottery.example', lastMessageAt: Date.now() - 3_600_000,
  unread: true, inInbox: false, groupId: 'unsorted', groupName: 'Spam', reason: { source: 'default', text: 'In Gmail spam', at: null },
  snoozedUntil: null, hasAttachments: true, suggestRule: false, doneAt: null,
};

function message(over: Partial<MessageDTO> = {}): MessageDTO {
  return {
    id: 'a:m1', gmailMessageId: 'm1', from: { name: 'Prize Dept', email: 'win@lottery.example' }, to: [{ name: null, email: 'me@gmail.com' }], cc: [],
    date: Date.now() - 3_600_000, subject: 'You won a prize', text: null, attachments: [{ attachmentId: 'att1', filename: 'invoice.exe', mimeType: 'application/x-msdownload', size: 2048 }],
    html: '<p>Claim <a href="https://shop.example/claim">here</a></p><img src="https://track.example/p.gif"><div style="background:url(https://track.example/b.png)">x</div>',
    ...over,
  };
}
const detail = (messages: MessageDTO[] = [message()]): ThreadDetailDTO => ({ thread: summary, messages });

function Where() {
  const { pathname } = useLocation();
  return <div data-testid="where">{pathname}</div>;
}

function renderReader() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(qk.spam(), { threads: [summary], nextCursor: null });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/spam', '/spam/a%3As1']} initialIndex={1}>
        <Routes>
          <Route path="/spam" element={<Where />} />
          <Route path="/spam/:id" element={<><SpamThread /><Where /></>} />
        </Routes>
        <AppToasts />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
}

const press = (key: string) =>
  act(() => {
    fireEvent.keyDown(document.body, { key });
  });

beforeEach(() => {
  vi.clearAllMocks();
  resetToasts();
  mocked.accounts.mockResolvedValue([{ id: 'a', email: 'me@gmail.com', color: '#2563eb', status: 'ok' }]);
  mocked.spamThread.mockResolvedValue(detail());
  mocked.notSpam.mockResolvedValue({ undoId: 'u-out', thread: { ...summary, inInbox: true } });
  mocked.undo.mockResolvedValue({ undoId: 'u-redo', thread: null });
});

describe('Spam reader', () => {
  it('reads the thread through the spam route', async () => {
    renderReader();
    expect(await screen.findByRole('heading', { level: 1, name: 'You won a prize' })).toBeInTheDocument();
    expect(mocked.spamThread).toHaveBeenCalledWith(ID);
  });

  it('blocks remote images: no http src and no url( in the srcdoc', async () => {
    renderReader();
    const frame = await screen.findByTitle('You won a prize');
    const srcdoc = frame.getAttribute('srcdoc')!;
    expect(srcdoc).not.toMatch(/src\s*=\s*["']?https?:/i);
    expect(srcdoc).not.toMatch(/url\(/i);
    expect(srcdoc).not.toContain('track.example');
    expect(screen.getByText('Remote images are blocked in spam')).toBeInTheDocument();
  });

  it('keeps links visible and warns about them', async () => {
    renderReader();
    const frame = await screen.findByTitle('You won a prize');
    expect(frame.getAttribute('srcdoc')).toContain('href="https://shop.example/claim"');
    expect(screen.getByText('Be careful with links in this email.')).toBeInTheDocument();
  });

  it('lists attachment names with no open or download link', async () => {
    renderReader();
    const list = await screen.findByRole('list', { name: 'Attachments' });
    expect(within(list).getByText('invoice.exe')).toBeInTheDocument();
    expect(within(list).queryByRole('link')).not.toBeInTheDocument();
    expect(within(list).queryByRole('button')).not.toBeInTheDocument();
    expect(document.querySelector('a[href*="/api/attachments/"]')).toBeNull();
  });

  it('has Back and Not spam, and no reply, Done, snooze or teach actions', async () => {
    renderReader();
    await screen.findByTitle('You won a prize');
    const toolbar = screen.getByRole('toolbar', { name: 'Spam actions' });
    expect(within(toolbar).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Back', 'Not spamI']);
    expect(screen.getAllByRole('button', { name: /^Back/ })).toHaveLength(1);
    for (const name of [/Reply/, /Forward/, /^Done/, /Snooze/, /Important/, /Always group/, /Report spam/, /Delete/]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('does not mark anything read', async () => {
    renderReader();
    await screen.findByTitle('You won a prize');
    expect(api.read).not.toHaveBeenCalled();
  });

  it('the keys of a thread do nothing here', async () => {
    renderReader();
    await screen.findByTitle('You won a prize');
    for (const key of ['e', 'h', 'r', 'a', 'f', '+', '-', 'l', 'u', '!', 'j', 'k']) press(key);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mocked.notSpam).not.toHaveBeenCalled();
    expect(screen.getByTestId('where')).toHaveTextContent('/spam/a%3As1');
  });

  it('i moves it out of spam, goes back to the list and offers Undo', async () => {
    const qc = renderReader();
    await screen.findByTitle('You won a prize');
    press('i');
    await waitFor(() => expect(mocked.notSpam).toHaveBeenCalledWith(ID));
    expect(await screen.findByText('Not spam. Moved to the inbox')).toBeInTheDocument();
    expect(await screen.findByTestId('where')).toHaveTextContent(/^\/spam$/);
    expect(qc.getQueryData(qk.spam())).toMatchObject({ threads: [] });
  });

  it('a second i while the first is in flight does nothing', async () => {
    mocked.notSpam.mockReturnValue(new Promise(() => undefined));
    renderReader();
    await screen.findByTitle('You won a prize');
    press('i');
    press('i');
    await waitFor(() => expect(mocked.notSpam).toHaveBeenCalled());
    press('i');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(mocked.notSpam).toHaveBeenCalledTimes(1);
  });

  it('stays and says so when it fails', async () => {
    mocked.notSpam.mockRejectedValue(new Error('Gmail is down'));
    renderReader();
    await screen.findByTitle('You won a prize');
    fireEvent.click(screen.getByRole('button', { name: /Not spam/ }));
    expect(await screen.findByText("Couldn't move it to the inbox: Gmail is down")).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/spam/a%3As1');
  });

  it('Back and Escape go back to the list', async () => {
    renderReader();
    await screen.findByTitle('You won a prize');
    press('Escape');
    expect(await screen.findByTestId('where')).toHaveTextContent(/^\/spam$/);
  });

  it('says so when the thread is no longer in spam', async () => {
    mocked.spamThread.mockRejectedValue(new ApiError(404, 'This thread is no longer in spam'));
    renderReader();
    expect(await screen.findByText('This email is no longer in spam.')).toBeInTheDocument();
  });

  it('shows an error with Retry', async () => {
    mocked.spamThread.mockRejectedValueOnce(new ApiError(500, 'Internal server error'));
    renderReader();
    const alert = await screen.findByRole('alert');
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTitle('You won a prize')).toBeInTheDocument();
  });

  it('shows a skeleton while Gmail answers', async () => {
    mocked.spamThread.mockReturnValue(new Promise(() => undefined));
    renderReader();
    expect(await screen.findByRole('status', { name: 'Loading this email' })).toBeInTheDocument();
  });

  it('shows plain-text spam with no note about images', async () => {
    mocked.spamThread.mockResolvedValue(detail([message({ html: null, text: 'Claim your prize', attachments: [] })]));
    renderReader();
    expect(await screen.findByText('Claim your prize')).toBeInTheDocument();
    expect(screen.queryByText('Remote images are blocked in spam')).not.toBeInTheDocument();
    expect(screen.getByText('Be careful with links in this email.')).toBeInTheDocument();
  });

  it('a message of a longer thread folds on its header', async () => {
    mocked.spamThread.mockResolvedValue(detail([message({ html: null, text: 'first', attachments: [] }), message({ id: 'a:m2', gmailMessageId: 'm2', html: null, text: 'second', attachments: [] })]));
    renderReader();
    await screen.findByText('first');
    fireEvent.click(screen.getAllByRole('button', { name: /Prize Dept/ })[0]!);
    await waitFor(() => expect(screen.queryByText('first', { selector: 'pre' })).not.toBeInTheDocument());
    expect(screen.getByText('second')).toBeInTheDocument();
  });
});
