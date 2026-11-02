import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountDTO, ThreadSummaryDTO } from '@supermail/shared';
import { api, ApiError } from '../src/api/client';
import { applyServerEvent } from '../src/api/events';
import { qk } from '../src/api/client';
import { AppToasts, resetToasts } from '../src/state/toasts';
import { Spam } from '../src/views/Spam';

vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  return { ...actual, api: { accounts: vi.fn(), spam: vi.fn(), notSpam: vi.fn(), undo: vi.fn(), groups: vi.fn() } };
});
const mocked = vi.mocked(api);

const accounts: AccountDTO[] = [
  { id: 'a', email: 'me@gmail.com', color: '#2563eb', status: 'ok' },
  { id: 'b', email: 'ops@work.com', color: '#16a34a', status: 'ok' },
];

function thread(id: string, subject: string, over: Partial<ThreadSummaryDTO> = {}): ThreadSummaryDTO {
  return {
    id, accountId: id.split(':')[0]!, subject, snippet: 'snippet', fromName: 'Spammer', fromEmail: 'x@spam.example', lastMessageAt: Date.now() - 3_600_000,
    unread: true, inInbox: false, groupId: 'unsorted', groupName: 'Spam', reason: { source: 'default', text: 'In Gmail spam', at: null },
    snoozedUntil: null, hasAttachments: false, suggestRule: false, doneAt: null, ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetToasts();
  Element.prototype.scrollIntoView = vi.fn();
  mocked.accounts.mockResolvedValue(accounts.slice(0, 1));
  mocked.spam.mockResolvedValue({ threads: [thread('a:1', 'You won'), thread('a:2', 'Cheap pills')], nextCursor: null });
  mocked.notSpam.mockImplementation(async (id) => ({ undoId: `u-${id}`, thread: thread(id, 'rescued', { inInbox: true }) }));
  mocked.undo.mockResolvedValue({ undoId: 'u-undo', thread: null });
});

function SpamReaderStub() {
  return <div>reader {useParams().id}</div>;
}

function renderSpam() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/', '/spam']} initialIndex={1}>
        <Routes>
          <Route path="/" element={<div>inbox page</div>} />
          <Route path="/spam" element={<Spam />} />
          <Route path="/spam/:id" element={<SpamReaderStub />} />
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
const rowOf = (subject: string) => screen.getByText(subject).closest('[role="option"]') as HTMLElement;

describe('Spam screen', () => {
  it('lists spam under a line saying Gmail deletes it, with the panel titled Spam', async () => {
    renderSpam();
    expect(await screen.findByText('You won')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Spam' })).toBeInTheDocument();
    expect(screen.getByText('Gmail keeps spam for 30 days, then deletes it.')).toBeInTheDocument();
    expect(screen.getByRole('listbox', { name: 'Spam threads' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Spam' })).toBeInTheDocument();
  });

  it('rows link to the spam reader, never to /t/, and one click opens it', async () => {
    renderSpam();
    await screen.findByText('You won');
    expect(rowOf('You won')).toHaveAttribute('href', '/spam/a%3A1');
    fireEvent.click(rowOf('Cheap pills'));
    expect(await screen.findByText('reader a:2')).toBeInTheDocument();
  });

  it('Enter opens the selected row, and j moves the selection', async () => {
    renderSpam();
    await screen.findByText('You won');
    press('j');
    expect(rowOf('Cheap pills')).toHaveAttribute('aria-selected', 'true');
    press('Enter');
    expect(await screen.findByText('reader a:2')).toBeInTheDocument();
  });

  it('i is Not spam on the selected row: it leaves the list and offers Undo; z undoes it', async () => {
    const qc = renderSpam();
    await screen.findByText('You won');
    press('j');
    press('i');
    await waitFor(() => expect(mocked.notSpam).toHaveBeenCalledWith('a:2'));
    await waitFor(() => expect(screen.queryByText('Cheap pills')).not.toBeInTheDocument());
    expect(await screen.findByText('Not spam. Moved to the inbox')).toBeInTheDocument();
    expect(qc.getQueryData(qk.spam())).toMatchObject({ threads: [{ id: 'a:1' }] });

    mocked.spam.mockResolvedValue({ threads: [thread('a:1', 'You won'), thread('a:2', 'Cheap pills')], nextCursor: null });
    press('z');
    await waitFor(() => expect(mocked.undo).toHaveBeenCalledWith('u-a:2'));
    expect(await screen.findByText('Cheap pills')).toBeInTheDocument();
  });

  it('the hover button does the same, and works on the row under the mouse', async () => {
    renderSpam();
    await screen.findByText('You won');
    fireEvent.click(within(rowOf('Cheap pills').parentElement!).getByRole('button', { name: 'Not spam', hidden: true }));
    await waitFor(() => expect(mocked.notSpam).toHaveBeenCalledWith('a:2'));
  });

  it('puts the row back and says so when it fails', async () => {
    mocked.notSpam.mockRejectedValue(new Error('Gmail is down'));
    renderSpam();
    await screen.findByText('You won');
    press('i');
    expect(await screen.findByText("Couldn't move it to the inbox: Gmail is down")).toBeInTheDocument();
    expect(screen.getByText('You won')).toBeInTheDocument();
  });

  it('the context menu has only Open, Not spam and Copy link', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    renderSpam();
    await screen.findByText('You won');
    fireEvent.contextMenu(rowOf('You won'), { clientX: 10, clientY: 10 });
    const menu = screen.getByRole('menu', { name: /actions/i });
    expect(within(menu).getAllByRole('menuitem').map((i) => i.querySelector('.truncate')?.textContent)).toEqual(['Open', 'Not spam', 'Copy link']);
    expect(within(screen.getByRole('menuitem', { name: /^Not spam/ })).getByText('I')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: /^Copy link/ }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringMatching(/\/spam\/a%3A1$/)));
  });

  it('the Not spam menu item works', async () => {
    renderSpam();
    await screen.findByText('You won');
    fireEvent.contextMenu(rowOf('Cheap pills'), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole('menuitem', { name: /^Not spam/ }));
    await waitFor(() => expect(mocked.notSpam).toHaveBeenCalledWith('a:2'));
  });

  it('Escape goes back', async () => {
    renderSpam();
    await screen.findByText('You won');
    press('Escape');
    expect(await screen.findByText('inbox page')).toBeInTheDocument();
  });

  it('tags rows with their account when there are two or more', async () => {
    mocked.accounts.mockResolvedValue(accounts);
    renderSpam();
    await screen.findByText('You won');
    await waitFor(() => expect(within(rowOf('You won')).getByTestId('account-tag')).toHaveTextContent('me'));
  });

  it('shows no account tag with one account', async () => {
    renderSpam();
    await screen.findByText('You won');
    expect(screen.queryByTestId('account-tag')).not.toBeInTheDocument();
  });

  it('shows a skeleton while Gmail answers', async () => {
    mocked.spam.mockReturnValue(new Promise(() => undefined));
    renderSpam();
    expect(await screen.findByRole('status', { name: 'Loading spam' })).toBeInTheDocument();
    expect(screen.queryByText('No spam. Nice.')).not.toBeInTheDocument();
  });

  it('says No spam. Nice. when empty', async () => {
    mocked.spam.mockResolvedValue({ threads: [], nextCursor: null });
    renderSpam();
    expect(await screen.findByText('No spam. Nice.')).toBeInTheDocument();
  });

  it('shows the error with Retry, which reads Gmail again', async () => {
    mocked.spam.mockRejectedValueOnce(new ApiError(409, 'This Gmail account needs to be reconnected'));
    renderSpam();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This Gmail account needs to be reconnected');
    expect(screen.queryByText('No spam. Nice.')).not.toBeInTheDocument();
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('You won')).toBeInTheDocument();
  });

  it('live events keep the list right: a thread rescued in Gmail leaves it, and a thread.removed refreshes it', async () => {
    const qc = renderSpam();
    await screen.findByText('You won');
    act(() => applyServerEvent(qc, { type: 'thread.updated', thread: thread('a:1', 'You won', { inInbox: true }) }));
    await waitFor(() => expect(screen.queryByText('You won')).not.toBeInTheDocument());

    mocked.spam.mockResolvedValue({ threads: [thread('a:3', 'New spam')], nextCursor: null });
    act(() => applyServerEvent(qc, { type: 'thread.removed', id: 'a:3' }));
    expect(await screen.findByText('New spam')).toBeInTheDocument();
  });
});
