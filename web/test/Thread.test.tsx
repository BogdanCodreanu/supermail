import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageDTO, ThreadDetailDTO, ThreadSummaryDTO } from '@supermail/shared';

vi.mock('../src/api/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/api/client')>();
  return {
    ...real,
    api: {
      thread: vi.fn(),
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
    },
  };
});

const { api } = await import('../src/api/client');
const { Thread } = await import('../src/views/Thread');
const { AppToasts, resetToasts } = await import('../src/state/toasts');
const { resetOutbox, UNDO_SEND_MS } = await import('../src/state/outbox');
const { draftKey, loadDraft, resetDrafts } = await import('../src/state/drafts');
const { formatRelative } = await import('../src/components/MessageHeader');

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
  const loc = useLocation();
  return (
    <div data-testid="where" data-state={JSON.stringify(loc.state)}>
      {loc.pathname + loc.search}
    </div>
  );
}

function renderThread(entry: { pathname: string; state?: unknown } = { pathname: '/t/a%3At1' }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/t/:id" element={<><Thread /><Where /></>} />
          <Route path="*" element={<Where />} />
        </Routes>
        <AppToasts />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const ok = (thread: ThreadSummaryDTO | null = null, undoId = 'u1') => ({ undoId, thread });

beforeEach(() => {
  vi.clearAllMocks();
  resetToasts();
  resetOutbox();
  resetDrafts();
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(api.accounts).mockResolvedValue([{ id: 'a', email: 'me@gmail.com', color: '#2563eb', status: 'ok' }]);
  vi.mocked(api.groups).mockResolvedValue([]);
  vi.mocked(api.thread).mockImplementation(async (id) => ({
    thread: summary({ id, subject: `Subject ${id}` }),
    messages: [message({ text: `body of ${id}` })],
  }));
});

describe('thread toolbar', () => {
  it('has a labelled icon button with a key hint for every action', async () => {
    renderThread();
    const bar = await screen.findByRole('toolbar', { name: 'Thread actions' });
    const expected: [string, string][] = [
      ['Done', 'Done · e'],
      ['Snooze', 'Snooze · h'],
      ['Mark unread', 'Mark unread · u'],
      ['Always group to…', 'Always group to… · l'],
      ['Important', 'Important · +'],
      ['Not important', 'Not important · -'],
      ['Reply', 'Reply · r'],
      ['Reply all', 'Reply all · a'],
      ['Forward', 'Forward · f'],
    ];
    for (const [name, title] of expected) {
      expect(within(bar).getByRole('button', { name })).toHaveAttribute('title', title);
    }
  });

  it('has one Back, in the header; the toolbar has none', async () => {
    renderThread();
    const bar = await screen.findByRole('toolbar', { name: 'Thread actions' });
    expect(within(bar).queryByRole('button', { name: 'Back' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Back' })).toHaveLength(1);
  });

  it('shows the subject with its group and account', async () => {
    renderThread();
    expect(await screen.findByRole('heading', { level: 1, name: 'Subject a:t1' })).toHaveClass('text-lg');
    expect(screen.getByText('Important')).toBeInTheDocument();
  });

  it('on a Done thread the first button is Move to inbox, and e brings it back instead of marking it done again', async () => {
    const base = await api.thread('a:t1');
    vi.mocked(api.thread).mockResolvedValue({ ...base, thread: { ...base.thread, inInbox: false, doneAt: 1 } });
    vi.mocked(api.restore).mockResolvedValue(ok(summary({ inInbox: true }), 'u-restore'));
    renderThread();
    await screen.findByText('body of a:t1');
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Move to inbox' }));
    expect(await screen.findByText('Subject a:t1 · Moved to inbox')).toBeInTheDocument();
    expect(api.restore).toHaveBeenCalledWith('a:t1');
    expect(api.done).not.toHaveBeenCalled();
  });

  it('Done shows an undo toast and continues to the next thread in the list; z undoes and returns', async () => {
    vi.mocked(api.done).mockResolvedValue(ok(summary({ inInbox: false }), 'u-done'));
    vi.mocked(api.undo).mockResolvedValue(ok(summary({ inInbox: true })));
    renderThread({ pathname: '/t/a%3At1', state: { ids: ['a:t1', 'a:t2', 'a:t3'] } });
    await screen.findByText('body of a:t1');

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('Subject a:t1 · Done')).toBeInTheDocument();
    expect(api.done).toHaveBeenCalledWith('a:t1');
    expect(screen.getByTestId('where')).toHaveTextContent('/t/a%3At2');
    expect(await screen.findByText('body of a:t2')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'z' });
    await waitFor(() => expect(api.undo).toHaveBeenCalledWith('u-done'));
    expect(await screen.findByText('Undone')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/t/a%3At1');
  });

  it('! reports spam without asking, moves to the next thread like Done, and z undoes and returns', async () => {
    vi.mocked(api.reportSpam).mockResolvedValue(ok(null, 'u-spam'));
    vi.mocked(api.undo).mockResolvedValue(ok(summary({ inInbox: true })));
    renderThread({ pathname: '/t/a%3At1', state: { ids: ['a:t1', 'a:t2'] } });
    await screen.findByText('body of a:t1');

    fireEvent.keyDown(window, { key: '!' });
    expect(await screen.findByText(/Reported as spam$/)).toBeInTheDocument();
    expect(api.reportSpam).toHaveBeenCalledWith('a:t1');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/t/a%3At2');

    fireEvent.keyDown(window, { key: 'z' });
    await waitFor(() => expect(api.undo).toHaveBeenCalledWith('u-spam'));
    expect(await screen.findByText('Undone')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/t/a%3At1');
  });

  it('the toolbar reports spam too, and keeps the toast when there is no next thread', async () => {
    vi.mocked(api.reportSpam).mockResolvedValue(ok(null, 'u-spam'));
    renderThread();
    await screen.findByText('body of a:t1');
    fireEvent.click(screen.getByRole('button', { name: 'Report spam' }));
    expect(await screen.findByText(/Reported as spam$/)).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/');
  });

  it('Done on a thread opened without a list goes back to the inbox', async () => {
    vi.mocked(api.done).mockResolvedValue(ok());
    renderThread();
    await screen.findByText('body of a:t1');
    fireEvent.keyDown(window, { key: 'e' });
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/));
  });

  it('Snooze opens the picker and confirms with the time', async () => {
    vi.mocked(api.snooze).mockResolvedValue(ok());
    renderThread({ pathname: '/t/a%3At1', state: { ids: ['a:t1', 'a:t2'] } });
    await screen.findByText('body of a:t1');
    fireEvent.click(screen.getByRole('button', { name: 'Snooze' }));
    const dialog = screen.getByRole('dialog', { name: 'Snooze until…' });
    fireEvent.click(within(dialog).getByText('Tomorrow morning'));
    expect(await screen.findByText(/^Subject a:t1 · Snoozed until /)).toBeInTheDocument();
    expect(api.snooze).toHaveBeenCalledWith('a:t1', expect.any(Number));
    expect(screen.getByTestId('where')).toHaveTextContent('/t/a%3At2');
  });

  describe('teaching asks what it is about', () => {
    const preview = { subject: 'Subject a:t1', senderName: 'Irina Vasile', sender: { value: 'irina@example.com', count: 12 }, domain: { value: 'example.com', count: 40 }, list: null };
    const inPrompt = (key: string) => fireEvent.keyDown(document.activeElement!, { key });

    beforeEach(() => {
      vi.mocked(api.teachPreview).mockResolvedValue(preview);
      vi.mocked(api.teach).mockResolvedValue({ ...ok(summary()), affected: 12 });
      vi.mocked(api.move).mockResolvedValue({ ...ok(summary({ groupId: 'low_priority', groupName: 'Low priority' })), affected: 1 });
    });

    it('the Important button opens the prompt and teaches nothing yet', async () => {
      renderThread();
      await screen.findByText('body of a:t1');
      fireEvent.click(screen.getByRole('button', { name: 'Important' }));
      const dialog = await screen.findByRole('dialog', { name: 'Mark as important' });
      expect(within(dialog).getByText('Irina Vasile')).toBeInTheDocument();
      expect(within(dialog).getByText('Subject a:t1')).toBeInTheDocument();
      expect(await within(dialog).findByRole('radio', { name: /All from irina@example\.com · 12/ })).toBeChecked();
      expect(api.teach).not.toHaveBeenCalled();
    });

    it('+ then + marks the sender and the toast says how many moved', async () => {
      renderThread();
      await screen.findByText('body of a:t1');
      fireEvent.keyDown(window, { key: '+' });
      await screen.findByRole('dialog', { name: 'Mark as important' });
      inPrompt('+');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(await screen.findByText('Irina Vasile → Important · 12 emails')).toBeInTheDocument();
      expect(api.teach).toHaveBeenCalledWith({ threadId: 'a:t1', action: 'important', scope: 'sender' });
      expect(screen.queryByRole('button', { name: /whole domain/i })).toBeNull();
    });

    it('- with the domain chosen teaches the domain', async () => {
      renderThread();
      await screen.findByText('body of a:t1');
      fireEvent.keyDown(window, { key: '-' });
      await screen.findByRole('radio', { name: /Everyone at example\.com · 40/ });
      inPrompt('ArrowDown');
      inPrompt('Enter');
      await waitFor(() => expect(api.teach).toHaveBeenCalledWith({ threadId: 'a:t1', action: 'not_important', scope: 'domain' }));
    });

    it('"only this email" is a one-off move', async () => {
      renderThread();
      await screen.findByText('body of a:t1');
      fireEvent.keyDown(window, { key: '-' });
      await screen.findByRole('dialog', { name: 'Mark as not important' });
      inPrompt('1');
      await waitFor(() => expect(api.move).toHaveBeenCalledWith('a:t1', 'low_priority'));
      expect(api.teach).not.toHaveBeenCalled();
      expect(await screen.findByText('Subject a:t1 → Low priority')).toBeInTheDocument();
    });

    it('moves the thread on screen before the server answers, and puts it back if it fails', async () => {
      let fail!: (e: Error) => void;
      vi.mocked(api.teach).mockReturnValue(new Promise((_, reject) => (fail = reject)));
      renderThread();
      await screen.findByText('body of a:t1');
      expect(screen.queryByText('Low priority')).toBeNull();
      fireEvent.keyDown(window, { key: '-' });
      await screen.findByRole('dialog', { name: 'Mark as not important' });
      inPrompt('-');
      expect(await screen.findByText('Low priority')).toBeInTheDocument();
      fail(new Error('Server down'));
      expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't teach: Server down");
      await waitFor(() => expect(screen.queryByText('Low priority')).toBeNull());
    });

    it('asks nothing before the thread has loaded, and the keys keep working', async () => {
      vi.mocked(api.thread).mockRejectedValue(new Error('offline'));
      renderThread();
      await screen.findByText(/Couldn't load this thread/);
      fireEvent.keyDown(window, { key: '+' });
      fireEvent.keyDown(window, { key: 'l' });
      fireEvent.keyDown(window, { key: 's' });
      expect(screen.queryByRole('dialog', { name: /important|group/i })).toBeNull();
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/));
    });

    it('"Make this a rule" opens the same prompt for the current group', async () => {
      vi.mocked(api.thread).mockImplementation(async (id) => ({ thread: summary({ id, suggestRule: true, groupId: 'dev', groupName: 'Dev' }), messages: [message({ text: `body of ${id}` })] }));
      renderThread();
      fireEvent.click(await screen.findByRole('button', { name: /Make this a rule/ }));
      await screen.findByRole('dialog', { name: 'Always group to Dev' });
      inPrompt('Enter');
      await waitFor(() => expect(api.teach).toHaveBeenCalledWith({ threadId: 'a:t1', action: 'always_group', scope: 'sender', groupId: 'dev' }));
    });
  });

  it('Mark unread confirms with a toast that names the email', async () => {
    vi.mocked(api.read).mockResolvedValue(ok(summary({ unread: true })));
    renderThread();
    await screen.findByText('body of a:t1');
    fireEvent.keyDown(window, { key: 'u' });
    expect(await screen.findByText('Subject a:t1 · Marked unread')).toBeInTheDocument();
    expect(api.read).toHaveBeenCalledWith('a:t1', false);
  });

  it('shows a failed action as an error toast', async () => {
    vi.mocked(api.done).mockRejectedValue(new Error('offline'));
    renderThread();
    await screen.findByText('body of a:t1');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByText("Couldn't mark done: offline")).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/t/a%3At1');
  });

});

const ctrlEnter = (el: Element) => fireEvent.keyDown(el, { key: 'Enter', ctrlKey: true });
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe('inline reply', () => {
  it.each([
    ['reply', 'Reply'],
    ['replyAll', 'Reply all'],
    ['forward', 'Forward'],
  ])('a list asking for the %s composer opens it once the thread is here', async (compose, region) => {
    renderThread({ pathname: '/t/a%3At1', state: { ids: ['a:t1', 'a:t2'], compose } });
    expect(await screen.findByRole('region', { name: region })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/t/a%3At1');
  });

  it('the request is used up, so going back to this entry or reloading does not reopen the composer', async () => {
    renderThread({ pathname: '/t/a%3At1', state: { ids: ['a:t1', 'a:t2'], compose: 'reply' } });
    await screen.findByRole('region', { name: 'Reply' });
    await waitFor(() => expect(JSON.parse(screen.getByTestId('where').dataset.state!)).toEqual({ ids: ['a:t1', 'a:t2'] }));
  });

  it('r opens the reply composer under the last message, scrolled into view and focused, without leaving the thread', async () => {
    renderThread();
    await screen.findByText('body of a:t1');
    fireEvent.keyDown(window, { key: 'r' });
    const region = await screen.findByRole('region', { name: 'Reply' });
    expect(screen.getByTestId('where')).toHaveTextContent('/t/a%3At1');
    const articles = document.querySelectorAll('article');
    expect(articles[articles.length - 1]!.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await screen.findByLabelText('Message')).toHaveFocus();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    // The respond buttons give way to the composer.
    expect(screen.queryByRole('group', { name: 'Respond' })).toBeNull();
  });

  it('Reply all and Forward buttons open it too; switching mode keeps the typed body and one composer', async () => {
    renderThread();
    await screen.findByText('body of a:t1');
    const footer = screen.getByRole('group', { name: 'Respond' });
    fireEvent.click(within(footer).getByRole('button', { name: /^Reply all/ }));
    await screen.findByRole('region', { name: 'Reply all' });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hello there' } });

    const bar = screen.getByRole('toolbar', { name: 'Thread actions' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Forward' }));
    await screen.findByRole('region', { name: 'Forward' });
    expect(screen.queryByRole('region', { name: 'Reply all' })).toBeNull();
    expect(screen.getAllByLabelText('Message')).toHaveLength(1);
    expect(screen.getByLabelText('Message')).toHaveValue('Hello there');
    expect(screen.getByLabelText('Subject')).toHaveValue('Fwd: Hello');
    // The body moved: the reply-all draft doesn't keep a second copy.
    await waitFor(() => expect(loadDraft(draftKey('replyAll', 'a:t1'))).toBeNull());
  });

  it('Esc closes it and keeps the draft; r brings the draft back', async () => {
    renderThread();
    await screen.findByText('body of a:t1');
    fireEvent.keyDown(window, { key: 'r' });
    await screen.findByRole('region', { name: 'Reply' });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Half a thought' } });
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Reply' })).toBeNull());
    expect(screen.getByTestId('where')).toHaveTextContent('/t/a%3At1');
    expect(loadDraft(draftKey('reply', 'a:t1'))?.text).toBe('Half a thought');

    fireEvent.keyDown(window, { key: 'r' });
    expect(await screen.findByLabelText('Message')).toHaveValue('Half a thought');
  });

  it('sending closes it with "Sending… Undo"; Undo reopens it in the thread with the draft', async () => {
    renderThread();
    await screen.findByText('body of a:t1');
    fireEvent.keyDown(window, { key: 'r' });
    await screen.findByRole('region', { name: 'Reply' });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Sounds good' } });
    ctrlEnter(screen.getByLabelText('Message'));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Reply' })).toBeNull());
    const toast = screen.getByRole('status');
    expect(toast).toHaveTextContent('Sending…');

    fireEvent.click(within(toast).getByRole('button', { name: /Undo/ }));
    await screen.findByRole('region', { name: 'Reply' });
    expect(screen.getByLabelText('Message')).toHaveValue('Sounds good');
    expect(screen.getByTestId('where')).toHaveTextContent('/t/a%3At1');
    expect(api.send).not.toHaveBeenCalled();
  });

  it('shows "Sent" once the message goes out', async () => {
    vi.mocked(api.send).mockResolvedValue({ threadId: 'a:t1' });
    renderThread();
    await screen.findByText('body of a:t1');
    fireEvent.keyDown(window, { key: 'r' });
    await screen.findByRole('region', { name: 'Reply' });
    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'On my way' } });
      ctrlEnter(screen.getByLabelText('Message'));
      await advance(UNDO_SEND_MS);
      expect(api.send).toHaveBeenCalledWith(expect.objectContaining({ text: 'On my way', replyToThreadId: 'a:t1' }));
      expect(screen.getByRole('status')).toHaveTextContent('Sent');
      expect(screen.queryByRole('region', { name: 'Reply' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('messages', () => {
  const older = message({ id: 'a:m0', from: { name: 'Bob', email: 'bob@example.com' }, date: NOW - 86_400_000 * 2, text: null, html: '<p>Earlier   <b>words</b></p>' });
  const latest = message({
    id: 'a:m1',
    to: [{ name: null, email: 'me@gmail.com' }, { name: 'Bob', email: 'bob@example.com' }, { name: 'Cy', email: 'cy@example.com' }],
    cc: [{ name: 'Dee', email: 'dee@example.com' }],
  });

  beforeEach(() => {
    vi.mocked(api.thread).mockResolvedValue({ thread: summary(), messages: [older, latest] } satisfies ThreadDetailDTO);
  });

  it('starts older messages collapsed with an HTML-derived preview and a full-date tooltip', async () => {
    renderThread();
    await screen.findByText('latest body');
    const row = screen.getByRole('button', { name: /^Bob/ });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(within(row).getByText('Earlier words')).toBeInTheDocument();
    const date = within(row).getByText(formatRelative(older.date));
    expect(date.getAttribute('title')).toMatch(/2026/);
  });

  it('expands unread messages as well as the latest', async () => {
    const mine = message({ id: 'a:m00', from: { name: null, email: 'me@gmail.com' }, date: NOW - 86_400_000 * 3, text: 'my question' });
    vi.mocked(api.thread).mockResolvedValue({ thread: summary({ unread: true }), messages: [mine, older, latest] });
    vi.mocked(api.read).mockResolvedValue(ok(summary()));
    renderThread();
    await screen.findByText('latest body');
    // Bob's message came after my last one, so it is unread and starts open; mine starts collapsed.
    expect(screen.getByRole('button', { name: /^Bob/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /^me/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows "to me, Bob +2" and a details popover with From, To, Cc, Date and Account', async () => {
    renderThread();
    await screen.findByText('latest body');
    const details = screen.getByRole('button', { name: /to me, Bob \+2/ });
    expect(screen.getByText('irina@example.com')).toBeInTheDocument();
    fireEvent.click(details);
    const pop = screen.getByRole('dialog', { name: 'Message details' });
    expect(within(pop).getByText('From')).toBeInTheDocument();
    expect(within(pop).getByText(/Irina Vasile <irina@example.com>/)).toBeInTheDocument();
    expect(within(pop).getByText(/me@gmail.com, Bob <bob@example.com>, Cy <cy@example.com>/)).toBeInTheDocument();
    expect(within(pop).getByText(/Dee <dee@example.com>/)).toBeInTheDocument();
    expect(within(pop).getByText('Date')).toBeInTheDocument();
    expect(within(pop).getByText('Account')).toBeInTheDocument();
    // Escape closes the popover and does not leave the thread.
    fireEvent.keyDown(pop, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Message details' })).toBeNull();
    expect(screen.getByTestId('where')).toHaveTextContent('/t/a%3At1');
  });

  it('n / p move between messages, while j / k keep walking the list of threads', async () => {
    renderThread({ pathname: '/t/a%3At1', state: { ids: ['a:t1', 'a:t2'] } });
    await screen.findByText('latest body');
    fireEvent.keyDown(window, { key: 'p' });
    expect(document.querySelector('[data-focused="true"]')!.textContent).toContain('Bob');
    expect(screen.getByRole('button', { name: /^Bob/ })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(window, { key: 'n' });
    expect(document.querySelector('[data-focused="true"]')!.textContent).toContain('Irina');
    expect(screen.getByTestId('where')).toHaveTextContent('/t/a%3At1');
    fireEvent.keyDown(window, { key: 'j' });
    expect(screen.getByTestId('where')).toHaveTextContent('/t/a%3At2');
  });

  it('r on a focused message answers that message', async () => {
    renderThread();
    await screen.findByText('latest body');
    fireEvent.keyDown(window, { key: 'p' });
    fireEvent.keyDown(window, { key: 'r' });
    const region = await screen.findByRole('region', { name: 'Reply' });
    // Bob wrote the older message, so the reply goes to him.
    expect(within(region).getAllByTestId('recipient-chip').map((c) => c.textContent)).toEqual([expect.stringContaining('bob@example.com')]);
  });

  it('marks the focused message with the selection background and an accent bar', async () => {
    renderThread();
    await screen.findByText('latest body');
    act(() => {
      fireEvent.keyDown(window, { key: 'k' });
    });
    const focused = document.querySelector('[data-focused="true"]')!;
    expect(focused).toHaveClass('md:bg-sel', 'md:border-l-accent');
    expect(focused.textContent).toContain('Bob');
  });
});

describe('formatRelative', () => {
  const now = new Date(2026, 9, 29, 12, 0);
  it('reads like a person would say it', () => {
    expect(formatRelative(now.getTime() - 20_000, now)).toBe('now');
    expect(formatRelative(now.getTime() - 5 * 60_000, now)).toBe('5m ago');
    expect(formatRelative(now.getTime() - 3 * 3_600_000, now)).toBe('3h ago');
    expect(formatRelative(new Date(2026, 9, 28, 9, 0).getTime(), now)).toBe('Yesterday');
  });
});
