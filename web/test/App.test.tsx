import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useBlocker } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  me: vi.fn(),
  accounts: vi.fn(),
  groups: vi.fn(),
  threads: vi.fn(),
  storage: vi.fn(),
  labels: vi.fn(),
  thread: vi.fn(),
}));
vi.mock('../src/api/client', async (importOriginal) => ({ ...(await importOriginal<object>()), api }));

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener() {}
  close() {}
}

beforeEach(() => {
  vi.stubGlobal('EventSource', FakeEventSource);
  for (const fn of Object.values(api)) fn.mockReset();
  api.accounts.mockResolvedValue([]);
  api.groups.mockResolvedValue([]);
  api.threads.mockResolvedValue({ threads: [], nextCursor: null });
  api.storage.mockReturnValue(new Promise(() => {}));
  api.labels.mockResolvedValue([]);
  api.thread.mockReturnValue(new Promise(() => {}));
});

async function renderApp(path: string, extra: Parameters<typeof createMemoryRouter>[0] = []) {
  const { appRoutes, ROUTER_FUTURE } = await import('../src/App');
  const router = createMemoryRouter([...extra, ...appRoutes()], { initialEntries: [path], future: ROUTER_FUTURE });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('App routes (data router)', () => {
  it('shows a skeleton of the inbox layout while signing in, not a blank screen', async () => {
    api.me.mockReturnValue(new Promise(() => {}));
    await renderApp('/');
    const skeleton = screen.getByRole('status');
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
    expect(skeleton).toHaveTextContent('Loading SuperMail');
    expect(skeleton).toHaveTextContent('SuperMail');
  });

  it('renders the signed-in pages once /api/me answers', async () => {
    api.me.mockResolvedValue({ email: 'me@a.com' });
    await renderApp('/settings');
    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeInTheDocument();
  });

  it('sends unknown paths to the inbox', async () => {
    api.me.mockResolvedValue({ email: 'me@a.com' });
    const router = await renderApp('/nope');
    expect(await screen.findByText(/nothing left in your inbox/i)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
  });

  it('supports useBlocker (the composer needs a data router)', async () => {
    api.me.mockResolvedValue({ email: 'me@a.com' });
    function Guarded() {
      const blocker = useBlocker(true);
      return <div>guarded {blocker.state}</div>;
    }
    const router = await renderApp('/guarded', [{ path: '/guarded', element: <Guarded /> }]);
    expect(await screen.findByText('guarded unblocked')).toBeInTheDocument();
    void router.navigate('/settings');
    expect(await screen.findByText('guarded blocked')).toBeInTheDocument();
  });

  it('notes the thread being read, for the inbox to come back to', async () => {
    api.me.mockResolvedValue({ email: 'me@a.com' });
    vi.resetModules();
    const { lastOpenedThread } = await import('../src/state/listMemory');
    await renderApp('/t/a%3A7');
    await vi.waitFor(() => expect(lastOpenedThread()).toBe('a:7'));
  });

  it('a tapped notification for another email opens it; for the open email it loads it again', async () => {
    api.me.mockResolvedValue({ email: 'me@a.com' });
    let open: ((url: string) => void) | undefined;
    vi.resetModules();
    vi.doMock('../src/lib/push', async (importOriginal) => ({
      ...(await importOriginal<object>()),
      refreshPush: vi.fn(),
      onOpenRequest: (go: (url: string) => void) => {
        open = go;
        return () => {};
      },
    }));
    const summary = { id: 'a:7', accountId: 'a', subject: 'Lunch?', snippet: '', fromName: 'Ana', fromEmail: 'ana@x.ro', lastMessageAt: 1, unread: false, inInbox: true, groupId: 'important', groupName: 'Important', reason: { source: 'heuristic', text: '', at: null }, snoozedUntil: null, hasAttachments: false, suggestRule: false };
    api.thread.mockImplementation(async (id: string) => ({ thread: { ...summary, id }, messages: [] }));
    const router = await renderApp('/t/a%3A7');
    await vi.waitFor(() => expect(open).toBeDefined());
    await vi.waitFor(() => expect(api.thread).toHaveBeenCalledTimes(1));
    open!('/t/a%3A7');
    await vi.waitFor(() => expect(api.thread).toHaveBeenCalledTimes(2));
    open!('/t/a%3A9');
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/t/a%3A9'));
    vi.doUnmock('../src/lib/push');
  });
});
