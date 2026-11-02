import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThreadSummaryDTO } from '@supermail/shared';

// The toasts live at the app root, so they outlive the screen that showed them.
const api = vi.hoisted(() => ({
  me: vi.fn(),
  accounts: vi.fn(),
  groups: vi.fn(),
  threads: vi.fn(),
  thread: vi.fn(),
  read: vi.fn(),
  done: vi.fn(),
  undo: vi.fn(),
  send: vi.fn(),
}));
vi.mock('../src/api/client', async (importOriginal) => ({ ...(await importOriginal<object>()), api }));

const { appRoutes, ROUTER_FUTURE } = await import('../src/App');
const { resetToasts } = await import('../src/state/toasts');
const { resetOutbox } = await import('../src/state/outbox');

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener() {}
  close() {}
}

function summary(id: string, over: Partial<ThreadSummaryDTO> = {}): ThreadSummaryDTO {
  return {
    id,
    accountId: 'a',
    subject: `Subject ${id}`,
    snippet: 'hi',
    fromName: 'Ana',
    fromEmail: 'irina@example.com',
    lastMessageAt: Date.UTC(2026, 9, 29, 12, 0),
    unread: false,
    inInbox: true,
    groupId: 'important',
    groupName: 'Important',
    reason: { source: 'heuristic', text: 'In Important: automatic guess', at: null },
    snoozedUntil: null,
    hasAttachments: false,
    suggestRule: false,
    ...over,
  };
}

beforeEach(() => {
  vi.stubGlobal('EventSource', FakeEventSource);
  for (const fn of Object.values(api)) fn.mockReset();
  resetToasts();
  resetOutbox();
  Element.prototype.scrollIntoView = vi.fn();
  // jsdom has no layout: give the inbox's virtual list a viewport so its rows render.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
  Element.prototype.scrollTo ??= () => {};
  api.me.mockResolvedValue({ email: 'me@a.com' });
  api.accounts.mockResolvedValue([{ id: 'a', email: 'me@a.com', color: '#2563eb', status: 'ok' }]);
  api.groups.mockResolvedValue([]);
  api.threads.mockResolvedValue({ threads: [summary('a:2')], nextCursor: null });
  api.thread.mockImplementation(async (id: string) => ({
    thread: summary(id),
    messages: [{ id: `${id}:m`, gmailMessageId: 'm', from: { name: 'Ana', email: 'irina@example.com' }, to: [], cc: [], date: 0, subject: 'Hi', html: null, text: `body of ${id}`, attachments: [] }],
  }));
  api.done.mockResolvedValue({ undoId: 'u-done', thread: summary('a:1', { inInbox: false }) });
  api.undo.mockResolvedValue({ undoId: 'u-undo', thread: summary('a:1') });
});

function renderApp(path: string) {
  const router = createMemoryRouter(appRoutes(), { initialEntries: [path], future: ROUTER_FUTURE });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('app-level toasts', () => {
  it('Done in a thread goes back to the inbox, the toast stays, and z there undoes it', async () => {
    const router = renderApp('/t/a%3A1');
    await screen.findByText('body of a:1');
    fireEvent.keyDown(window, { key: 'e' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    await screen.findByText('Subject a:2');
    expect(screen.getByRole('status')).toHaveTextContent('· Done');

    act(() => {
      fireEvent.keyDown(document.body, { key: 'z' });
    });
    await waitFor(() => expect(api.undo).toHaveBeenCalledWith('u-done'));
    expect(await screen.findByText('Undone')).toBeInTheDocument();
    // The thread is back in the list, selected.
    expect(await screen.findByText('Subject a:1')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Subject a:1').closest('[data-thread-id]')).toHaveAttribute('aria-selected', 'true'));
  });

  it("the toast's Undo button works on the inbox too", async () => {
    const router = renderApp('/t/a%3A1');
    await screen.findByText('body of a:1');
    fireEvent.keyDown(window, { key: 'e' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    const toast = await screen.findByRole('status');
    fireEvent.click(within(toast).getByRole('button', { name: /Undo/ }));
    await waitFor(() => expect(api.undo).toHaveBeenCalledWith('u-done'));
  });

  it('the send toast shows on any screen once a reply is queued', async () => {
    renderApp('/t/a%3A1');
    await screen.findByText('body of a:1');
    fireEvent.keyDown(window, { key: 'r' });
    fireEvent.change(await screen.findByLabelText('Message'), { target: { value: 'Thanks' } });
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter', ctrlKey: true });
    expect(await screen.findByText('Sending…')).toBeInTheDocument();
  });
});
