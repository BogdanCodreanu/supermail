import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { MessageDTO, ThreadSummaryDTO } from '@supermail/shared';
import { endScreens, pressBack, stubKeyboard, stubPhone } from './phoneEnv';

vi.mock('../src/api/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/api/client')>();
  return {
    ...real,
    api: {
      thread: vi.fn(),
      spamThread: vi.fn(),
      read: vi.fn(),
      accounts: vi.fn(),
      groups: vi.fn(),
      done: vi.fn(),
      restore: vi.fn(),
      snooze: vi.fn(),
      teach: vi.fn(),
      teachPreview: vi.fn(),
      move: vi.fn(),
      undo: vi.fn(),
      send: vi.fn(),
      reportSpam: vi.fn(),
      notSpam: vi.fn(),
    },
  };
});

const { api } = await import('../src/api/client');
const { Thread } = await import('../src/views/Thread');
const { SpamThread } = await import('../src/views/SpamThread');
const { AppToasts, resetToasts } = await import('../src/state/toasts');
const { resetOutbox } = await import('../src/state/outbox');
const { draftKey, loadDraft, resetDrafts } = await import('../src/state/drafts');

const NOW = Date.UTC(2026, 9, 29, 12, 0);

function message(over: Partial<MessageDTO> = {}): MessageDTO {
  return {
    id: 'a:m1',
    gmailMessageId: 'm1',
    from: { name: 'Irina Vasile', email: 'irina@example.com' },
    to: [{ name: null, email: 'me@gmail.com' }],
    cc: [],
    date: NOW - 3_600_000,
    subject: 'Hello',
    html: null,
    text: 'latest body',
    attachments: [],
    ...over,
  };
}

function summary(over: Partial<ThreadSummaryDTO> = {}): ThreadSummaryDTO {
  return {
    id: 'a:t1',
    accountId: 'a',
    subject: 'Lunch on Friday',
    snippet: 'hi',
    fromName: 'Irina Vasile',
    fromEmail: 'irina@example.com',
    lastMessageAt: NOW,
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

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderAt(path = '/t/a%3At1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/', path]} initialIndex={1}>
        <Routes>
          <Route path="/t/:id" element={<Thread />} />
          <Route path="/spam/:id" element={<SpamThread />} />
          <Route path="*" element={<Where />} />
        </Routes>
        <AppToasts />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const bar = () => screen.findByRole('toolbar', { name: 'Thread actions' });
const scroller = () => document.querySelector('main')!;

function scrollTo(y: number) {
  act(() => {
    scroller().scrollTop = y;
    fireEvent.scroll(scroller());
  });
}

beforeEach(() => {
  stubPhone();
  vi.clearAllMocks();
  resetToasts();
  resetOutbox();
  resetDrafts();
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(api.accounts).mockResolvedValue([{ id: 'a', email: 'me@gmail.com', color: '#2563eb', status: 'ok' }]);
  vi.mocked(api.groups).mockResolvedValue([{ id: 'dev', name: 'Dev', color: '#000000', position: 1, inboxCount: 0, unreadCount: 0, notify: true, kind: 'custom' }] as never);
  vi.mocked(api.teachPreview).mockResolvedValue({} as never);
  vi.mocked(api.thread).mockImplementation(async (id) => ({ thread: summary({ id }), messages: [message()] }));
});

afterEach(endScreens);

describe('the email screen', () => {
  it('has a compact top bar: Back, the subject and the overflow menu, and no desktop toolbar or header', async () => {
    renderAt();
    await bar();
    const top = document.querySelector('header')!;
    expect(within(top).getByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(within(top).getByText('Lunch on Friday')).toHaveClass('truncate');
    expect(within(top).getByRole('button', { name: 'More actions' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Respond' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Lunch on Friday' })).toBeInTheDocument();
  });

  it('goes back with the top bar', async () => {
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }));
    expect(await screen.findByTestId('where')).toHaveTextContent('/');
  });

  it('has a fixed bottom bar with Done, Snooze, Reply, Forward and More', async () => {
    renderAt();
    const toolbar = await bar();
    expect(within(toolbar).getAllByRole('button').map((b) => b.textContent)).toEqual(['Done', 'Snooze', 'Reply', 'Forward', 'More']);
    expect(toolbar).toHaveClass('fixed', 'bottom-0', 'pb-[env(safe-area-inset-bottom)]');
  });

  it('a Show done thread gets Move to inbox instead of Done', async () => {
    vi.mocked(api.thread).mockResolvedValue({ thread: summary({ inInbox: false }), messages: [message()] });
    vi.mocked(api.restore).mockResolvedValue({ undoId: 'u1', thread: summary() });
    renderAt();
    const toolbar = await bar();
    expect(within(toolbar).queryByRole('button', { name: 'Done' })).toBeNull();
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Move to inbox' }));
    await waitFor(() => expect(api.restore).toHaveBeenCalledWith('a:t1'));
  });

  it('Done runs from the bar and goes back to the list', async () => {
    vi.mocked(api.done).mockResolvedValue({ undoId: 'u1', thread: null });
    renderAt();
    fireEvent.click(within(await bar()).getByRole('button', { name: 'Done' }));
    expect(await screen.findByTestId('where')).toHaveTextContent('/');
    expect(api.done).toHaveBeenCalledWith('a:t1');
  });

  it('hides the bar on scroll down and brings it back on scroll up', async () => {
    renderAt();
    const toolbar = await bar();
    expect(toolbar).toHaveAttribute('data-hidden', 'false');
    scrollTo(120);
    expect(toolbar).toHaveAttribute('data-hidden', 'true');
    expect(toolbar).toHaveClass('translate-y-full');
    scrollTo(60);
    expect(toolbar).toHaveAttribute('data-hidden', 'false');
  });

  it('a few pixels of jitter leave the bar as it is', async () => {
    renderAt();
    const toolbar = await bar();
    scrollTo(120);
    scrollTo(117);
    expect(toolbar).toHaveAttribute('data-hidden', 'true');
  });

  it('does not change email on a sideways swipe: keeping scrolling simple', async () => {
    renderAt();
    await bar();
    const body = screen.getByText('latest body');
    fireEvent.pointerDown(body, { clientX: 300, clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(body, { clientX: 40, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(body, { clientX: 40, clientY: 200, pointerId: 1 });
    expect(api.thread).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('where')).toBeNull();
  });
});

describe('More', () => {
  const openMore = async () => {
    fireEvent.click(within(await bar()).getByRole('button', { name: 'More' }));
    return screen.findByRole('dialog', { name: 'More actions' });
  };

  it('lists the rest of the actions, the same from the top bar', async () => {
    renderAt();
    const sheet = await openMore();
    const labels = within(sheet).getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual(['Reply all', 'Mark unread', 'Move to group', 'Important', 'Not important', 'Report spam']);
    await pressBack();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(within(document.querySelector('header')!).getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('dialog', { name: 'More actions' })).toBeInTheDocument();
  });

  it('hands over to the picker without closing it', async () => {
    renderAt();
    const sheet = await openMore();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Move to group' }));
    expect(await screen.findByRole('dialog', { name: 'Move to group' })).toBeInTheDocument();
    await act(() => new Promise((r) => setTimeout(r, 40)));
    expect(screen.getByRole('dialog', { name: 'Move to group' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'More actions' })).toBeNull();
  });

  it('Important asks about the scope, in a sheet, and a tap applies it', async () => {
    vi.mocked(api.teach).mockResolvedValue({ undoId: 'u1', thread: summary(), affected: 1 });
    renderAt();
    fireEvent.click(within(await openMore()).getByRole('button', { name: 'Important' }));
    const prompt = await screen.findByRole('dialog', { name: /important/i });
    fireEvent.click(within(prompt).getByRole('radio', { name: /All from/ }));
    await waitFor(() => expect(api.teach).toHaveBeenCalledWith(expect.objectContaining({ action: 'important', scope: 'sender' })));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Report spam runs and moves on', async () => {
    vi.mocked(api.reportSpam).mockResolvedValue({ undoId: 'u1', thread: null });
    renderAt();
    fireEvent.click(within(await openMore()).getByRole('button', { name: 'Report spam' }));
    expect(await screen.findByTestId('where')).toHaveTextContent('/');
  });

  it('the back gesture closes the sheet first, then the screen goes back', async () => {
    renderAt();
    await openMore();
    await pressBack();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByTestId('where')).toBeNull();
    expect(await bar()).toBeInTheDocument();
  });
});

describe('reading', () => {
  it('attachments are full-width rows with open and download, at the touch size', async () => {
    vi.mocked(api.thread).mockResolvedValue({
      thread: summary(),
      messages: [message({ attachments: [{ attachmentId: 'x', filename: 'invoice.pdf', mimeType: 'application/pdf', size: 2048 }] })],
    });
    renderAt();
    const list = await screen.findByRole('list', { name: 'Attachments' });
    expect(list).toHaveClass('flex-col');
    const open = within(list).getByTitle('Open invoice.pdf');
    expect(open).toHaveClass('h-12', 'flex-1', 'md:h-7');
    expect(within(list).getByRole('link', { name: 'Download invoice.pdf' })).toHaveClass('h-12', 'w-12', 'md:h-7');
  });

  it('collapsed earlier messages stay tappable, two lines at the touch size', async () => {
    vi.mocked(api.thread).mockResolvedValue({
      thread: summary(),
      messages: [message({ id: 'a:m0', text: 'earlier' }), message({ id: 'a:m1', text: 'latest body' })],
    });
    renderAt();
    await screen.findByText('latest body');
    const collapsed = document.querySelector('[aria-expanded="false"]')!;
    expect(collapsed).toHaveClass('min-h-14', 'flex-wrap', 'md:flex-nowrap');
    fireEvent.click(collapsed);
    expect(await screen.findByText('earlier')).toBeInTheDocument();
  });

  it('opens "to me" in a sheet, not a popover', async () => {
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: /^to me/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Message details' });
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    expect(within(sheet).getByText('Irina Vasile <irina@example.com>')).toBeInTheDocument();
    await pressBack();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await bar()).toBeInTheDocument();
  });

  it('a failed load says so and offers Retry', async () => {
    vi.mocked(api.thread).mockRejectedValueOnce(new Error('Failed to fetch'));
    renderAt();
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load this thread: Failed to fetch");
    expect(screen.queryByRole('toolbar')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await bar()).toBeInTheDocument();
  });

  it('offline, a thread that never loaded says so instead of "Loading…", and loads itself on reconnecting', async () => {
    onlineManager.setOnline(false);
    onTestFinished(() => onlineManager.setOnline(true));
    renderAt();
    expect(await screen.findByRole('alert')).toHaveTextContent("You're offline, so this thread couldn't load.");
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).toBeNull();
    act(() => onlineManager.setOnline(true));
    expect(await bar()).toBeInTheDocument();
  });

  it('says it is offline rather than quoting the browser', async () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    vi.mocked(api.thread).mockRejectedValue(new Error('Failed to fetch'));
    renderAt();
    expect(await screen.findByRole('alert')).toHaveTextContent("You're offline, so this thread couldn't load.");
  });
});

describe('the full-screen composer', () => {
  const reply = async () => {
    fireEvent.click(within(await bar()).getByRole('button', { name: 'Reply' }));
    return screen.findByRole('region', { name: 'Reply' });
  };

  it('has Close, the title and Send, then the rows and a body that fills the height', async () => {
    renderAt();
    const form = await reply();
    expect(within(form).getByRole('button', { name: 'Close' })).toHaveClass('h-11', 'w-11');
    expect(within(form).getByRole('heading', { name: 'Reply' })).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Send' })).toHaveClass('h-11');
    expect(within(form).getByRole('group', { name: 'To' })).toBeInTheDocument();
    const body = within(form).getByLabelText('Message');
    expect(body).toHaveClass('flex-1', 'text-[16px]');
    expect(body.style.height).toBe('auto');
    expect(form.parentElement).toHaveClass('fixed', 'inset-x-0', 'h-dvh');
    expect(form.parentElement!.parentElement).toBe(document.body);
  });

  it('ends at the keyboard, following the visual viewport', async () => {
    const view = stubKeyboard(740);
    renderAt();
    const form = await reply();
    expect(form.parentElement!.style.height).toBe('740px');
    act(() => {
      view.height = 420;
      view.dispatchEvent(new Event('resize'));
    });
    expect(form.parentElement!.style.height).toBe('420px');
  });

  it('back saves the draft and closes, leaving the thread on screen', async () => {
    renderAt();
    const form = await reply();
    fireEvent.change(within(form).getByLabelText('Message'), { target: { value: 'See you there' } });
    await pressBack();
    expect(screen.queryByRole('region', { name: 'Reply' })).toBeNull();
    expect(loadDraft(draftKey('reply', 'a:t1'))?.text).toBe('See you there');
    expect(screen.queryByTestId('where')).toBeNull();
    expect(await bar()).toBeInTheDocument();
  });

  it('More > Reply all replaces the sheet and stays open', async () => {
    renderAt();
    fireEvent.click(within(await bar()).getByRole('button', { name: 'More' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'More actions' })).getByRole('button', { name: 'Reply all' }));
    expect(await screen.findByRole('region', { name: 'Reply all' })).toBeInTheDocument();
    await act(() => new Promise((r) => setTimeout(r, 40)));
    expect(screen.getByRole('region', { name: 'Reply all' })).toBeInTheDocument();
  });

  it('Discard asks in a sheet over the composer; back closes only the sheet', async () => {
    renderAt();
    const form = await reply();
    fireEvent.change(within(form).getByLabelText('Message'), { target: { value: 'Draft' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Discard' }));
    expect(await screen.findByRole('dialog', { name: 'Discard draft?' })).toBeInTheDocument();
    await pressBack();
    expect(screen.queryByRole('dialog', { name: 'Discard draft?' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Reply' })).toBeInTheDocument();
  });

  it('sends from the header with the undo window, and Undo brings the composer and its text back', async () => {
    vi.mocked(api.send).mockResolvedValue({ threadId: 'a:t1' });
    renderAt();
    const form = await reply();
    fireEvent.change(within(form).getByLabelText('Message'), { target: { value: 'Thanks' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Send' }));
    expect(screen.queryByRole('region', { name: 'Reply' })).toBeNull();
    const toast = await screen.findByRole('status');
    expect(toast).toHaveTextContent('Sending…');
    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
    expect(await screen.findByLabelText('Message')).toHaveValue('Thanks');
    expect(api.send).not.toHaveBeenCalled();
  });

  it('a composer that cannot load still has a way out, and Retry', async () => {
    vi.mocked(api.accounts).mockRejectedValue(new Error('nope'));
    renderAt();
    fireEvent.click(within(await bar()).getByRole('button', { name: 'Reply' }));
    await screen.findByRole('button', { name: 'Retry' });
    const close = screen.getByRole('button', { name: 'Close' });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull());
  });
});

describe('the spam reader', () => {
  it('offline says so instead of a skeleton', async () => {
    onlineManager.setOnline(false);
    onTestFinished(() => onlineManager.setOnline(true));
    renderAt('/spam/a%3As1');
    expect(await screen.findByRole('alert')).toHaveTextContent("You're offline, so this email couldn't load.");
    expect(screen.queryByRole('status')).toBeNull();
  });

  beforeEach(() => {
    vi.mocked(api.spamThread).mockResolvedValue({
      thread: summary({ id: 'a:s1', subject: 'You won' }),
      messages: [message({ html: '<img src="https://evil.test/p.gif"><p>hi</p>', attachments: [{ attachmentId: 'x', filename: 'prize.exe', mimeType: 'x', size: 1 }] })],
    });
    vi.mocked(api.notSpam).mockResolvedValue({ undoId: 'u1', thread: null } as never);
  });

  it('has its own bar with Not spam and nothing else, and goes back', async () => {
    renderAt('/spam/a%3As1');
    const toolbar = await screen.findByRole('toolbar', { name: 'Spam actions' });
    expect(within(toolbar).getAllByRole('button').map((b) => b.textContent)).toEqual(['Not spam']);
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Not spam' }));
    await waitFor(() => expect(api.notSpam).toHaveBeenCalledWith('a:s1'));
  });

  it('keeps every protection: nothing remote, attachments only named, nothing marked read', async () => {
    renderAt('/spam/a%3As1');
    await screen.findByRole('toolbar', { name: 'Spam actions' });
    const doc = screen.getByTitle('Hello').getAttribute('srcdoc')!;
    expect(doc).not.toContain('evil.test');
    expect(doc).toContain("img-src data:");
    expect(screen.getByText('Be careful with links in this email.')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Attachments' })).queryByRole('link')).toBeNull();
    expect(api.read).not.toHaveBeenCalled();
  });
});
