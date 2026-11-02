import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { MessageDTO, ThreadDetailDTO, ThreadSummaryDTO } from '@supermail/shared';
import { endScreens, stubPhone } from './phoneEnv';

vi.mock('../src/api/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/api/client')>();
  return {
    ...real,
    api: {
      thread: vi.fn(),
      accounts: vi.fn(),
      groups: vi.fn(),
      send: vi.fn(),
    },
  };
});

const { api } = await import('../src/api/client');
const { Compose, draftFor } = await import('../src/views/Compose');
const { CommandPalette } = await import('../src/components/CommandPalette');
const { Composer, AUTOSAVE_MS } = await import('../src/components/Composer');
const { OutboxToasts, UNDO_SEND_MS, resetOutbox, useReopenRequest } = await import('../src/state/outbox');
const { draftKey, loadDraft, resetDrafts } = await import('../src/state/drafts');

const ME = 'me@gmail.com';

function message(over: Partial<MessageDTO> = {}): MessageDTO {
  return {
    id: 'a:m1',
    gmailMessageId: 'm1',
    from: { name: 'Ana', email: 'irina@example.com' },
    to: [{ name: null, email: ME }, { name: 'Bo', email: 'bo@example.com' }],
    cc: [{ name: null, email: 'cy@example.com' }],
    date: Date.UTC(2026, 9, 29, 9, 0),
    subject: 'Hello',
    html: null,
    text: 'original',
    attachments: [],
    ...over,
  };
}

function summary(): ThreadSummaryDTO {
  return {
    id: 'a:t1',
    accountId: 'a',
    subject: 'Hello',
    snippet: 'hi',
    fromName: 'Ana',
    fromEmail: 'irina@example.com',
    lastMessageAt: Date.UTC(2026, 9, 29, 10, 0),
    unread: false,
    inInbox: true,
    groupId: 'important',
    groupName: 'Important',
    reason: { source: 'heuristic', text: 'In Important', at: null },
    snoozedUntil: null,
    hasAttachments: false,
    suggestRule: false,
  };
}

// The owner's own later message must not become the reply target.
const DETAIL: ThreadDetailDTO = {
  thread: summary(),
  messages: [
    message(),
    message({ id: 'a:m2', gmailMessageId: 'm2', from: { name: null, email: ME }, to: [{ name: 'Ana', email: 'irina@example.com' }], cc: [], subject: 'Re: Hello' }),
  ],
};

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function renderAt(url: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/', url]} initialIndex={1}>
        <Routes>
          <Route path="/compose" element={<Compose />} />
          <Route path="*" element={<Where />} />
        </Routes>
        <OutboxToasts />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function field(label: string): HTMLElement {
  return screen.getByRole('group', { name: label });
}

function ctrlEnter(target: Element) {
  act(() => {
    fireEvent.keyDown(target, { key: 'Enter', ctrlKey: true });
  });
}

describe('draftFor', () => {
  it('replies to the latest message from someone else, with Re:', () => {
    const d = draftFor(DETAIL, 'reply', new Set([ME]));
    expect(d.to).toEqual(['irina@example.com']);
    expect(d.cc).toEqual([]);
    expect(d.subject).toBe('Re: Hello');
    expect(d.replyToMessageId).toBe('a:m1');
  });

  it('reply all keeps everyone except the owner', () => {
    const d = draftFor(DETAIL, 'replyAll', new Set([ME]));
    expect(d.to).toEqual(['irina@example.com', 'bo@example.com']);
    expect(d.cc).toEqual(['cy@example.com']);
  });

  it('forward starts with no recipients and Fwd:, and never doubles a prefix', () => {
    const d = draftFor(DETAIL, 'forward', new Set([ME]));
    expect(d.to).toEqual([]);
    expect(d.subject).toBe('Fwd: Hello');
    const re = draftFor({ ...DETAIL, messages: [message({ subject: 'RE: Hello' })] }, 'reply', new Set([ME]));
    expect(re.subject).toBe('Re: Hello');
  });
});

describe('Compose', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetOutbox();
    resetDrafts();
    vi.mocked(api.thread).mockResolvedValue(DETAIL);
    vi.mocked(api.accounts).mockResolvedValue([
      { id: 'a', email: ME, color: '#2563eb', status: 'ok' },
      { id: 'b', email: 'work@gmail.com', color: '#16a34a', status: 'ok' },
    ]);
    vi.mocked(api.groups).mockResolvedValue([]);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const REPLY = '/compose?thread=a%3At1&mode=reply';
  const toInput = () => within(field('To')).getByRole('combobox');
  const loadedReply = async () => {
    renderAt(REPLY);
    await within(await screen.findByRole('group', { name: 'To' })).findByText('irina@example.com');
  };
  const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

  it('a reply prefills To with the original sender and the subject with Re:', async () => {
    await loadedReply();
    expect(screen.getByLabelText('Subject')).toHaveValue('Re: Hello');
    // From is fixed to the thread's account, shown in the footer
    expect(screen.getByText(ME)).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'From' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toHaveClass('bg-accent', 'text-on-accent');
  });

  it('Ctrl+Enter closes at once and sends once after the 5 s undo window, then says Sent', async () => {
    await loadedReply();
    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Thanks!' } });
    vi.mocked(api.send).mockResolvedValue({ threadId: 'a:t1' });

    ctrlEnter(screen.getByLabelText('Message'));
    ctrlEnter(document.body);
    expect(screen.getByTestId('where')).toHaveTextContent('/');
    expect(screen.getByRole('status')).toHaveTextContent('Sending…');
    expect(api.send).not.toHaveBeenCalled();

    await advance(UNDO_SEND_MS);
    expect(api.send).toHaveBeenCalledTimes(1);
    expect(api.send).toHaveBeenCalledWith({
      accountId: 'a',
      to: ['irina@example.com'],
      cc: [],
      bcc: [],
      subject: 'Re: Hello',
      text: 'Thanks!',
      replyToThreadId: 'a:t1',
      replyToMessageId: 'a:m1',
    });
    expect(screen.getByRole('status')).toHaveTextContent('Sent');
    expect(loadDraft(draftKey('reply', 'a:t1'))).toBeNull();
    ctrlEnter(document.body);
    await advance(UNDO_SEND_MS);
    expect(api.send).toHaveBeenCalledTimes(1);
  });

  it('Undo cancels the send and reopens the composer with the content intact', async () => {
    await loadedReply();
    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Thanks!' } });
    ctrlEnter(screen.getByLabelText('Message'));
    expect(screen.getByTestId('where')).toHaveTextContent('/');

    fireEvent.click(within(screen.getByRole('status')).getByRole('button', { name: /Undo/ }));
    await advance(10);
    expect(screen.getByLabelText('Message')).toHaveValue('Thanks!');
    expect(screen.getByText('Draft restored')).toBeInTheDocument();
    await advance(UNDO_SEND_MS * 2);
    expect(api.send).not.toHaveBeenCalled();
  });

  it('z undoes the send from the list', async () => {
    await loadedReply();
    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Thanks!' } });
    ctrlEnter(screen.getByLabelText('Message'));
    fireEvent.keyDown(document.body, { key: 'z' });
    await advance(10);
    expect(screen.getByLabelText('Message')).toHaveValue('Thanks!');
    await advance(UNDO_SEND_MS);
    expect(api.send).not.toHaveBeenCalled();
  });

  it('a failed send shows an error with Retry and keeps the draft', async () => {
    await loadedReply();
    vi.useFakeTimers();
    vi.mocked(api.send).mockRejectedValueOnce(new Error('Gmail said no')).mockResolvedValueOnce({ threadId: 'a:t1' });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Thanks!' } });
    ctrlEnter(screen.getByLabelText('Message'));
    await advance(UNDO_SEND_MS);
    expect(screen.getByRole('alert')).toHaveTextContent(/Couldn't send.*Gmail said no/);
    expect(loadDraft(draftKey('reply', 'a:t1'))?.text).toBe('Thanks!');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await advance(10);
    expect(api.send).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status')).toHaveTextContent('Sent');
    expect(loadDraft(draftKey('reply', 'a:t1'))).toBeNull();
  });

  it('forward sends with forward: true', async () => {
    vi.mocked(api.send).mockResolvedValue({ threadId: 'a:t1' });
    renderAt('/compose?thread=a%3At1&mode=forward');
    expect(await screen.findByDisplayValue('Fwd: Hello')).toBeInTheDocument();
    vi.useFakeTimers();
    fireEvent.change(toInput(), { target: { value: 'dan@example.com' } });
    fireEvent.keyDown(toInput(), { key: 'Enter' });
    expect(within(field('To')).getByText('dan@example.com')).toBeInTheDocument();
    ctrlEnter(toInput());
    await advance(UNDO_SEND_MS);
    expect(api.send).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.send).mock.calls[0]![0]).toMatchObject({ to: ['dan@example.com'], forward: true, replyToThreadId: 'a:t1' });
  });

  it('a new message picks the From account (first by default) and includes typed but uncommitted recipients', async () => {
    vi.mocked(api.send).mockResolvedValue({ threadId: 'b:t9' });
    renderAt('/compose');
    const from = await screen.findByRole('combobox', { name: 'From' });
    await waitFor(() => expect(from).toHaveValue('a'));
    vi.useFakeTimers();
    fireEvent.change(from, { target: { value: 'b' } });
    fireEvent.change(toInput(), { target: { value: 'x@example.com' } });
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Hi' } });
    ctrlEnter(screen.getByLabelText('Message'));
    await advance(UNDO_SEND_MS);
    expect(api.send).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.send).mock.calls[0]![0]).toEqual({ accountId: 'b', to: ['x@example.com'], cc: [], bcc: [], subject: 'Hi', text: '' });
  });

  it('does not send without recipients, or with an invalid one', async () => {
    renderAt('/compose');
    await screen.findByRole('combobox', { name: 'From' });
    ctrlEnter(screen.getByLabelText('Message'));
    expect(screen.getByRole('alert')).toHaveTextContent(/recipient/i);

    fireEvent.change(toInput(), { target: { value: 'nope@nowhere' } });
    ctrlEnter(screen.getByLabelText('Message'));
    expect(screen.getByRole('alert')).toHaveTextContent(/nope@nowhere.*isn't a valid email/);
    expect(within(field('To')).getByTestId('recipient-chip')).toHaveAttribute('data-invalid', 'true');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByTestId('where')).not.toBeInTheDocument();
  });

  it('Cc Bcc are hidden behind a link', async () => {
    renderAt('/compose');
    await screen.findByRole('combobox', { name: 'From' });
    expect(screen.queryByRole('group', { name: 'Cc' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cc Bcc' }));
    expect(field('Cc')).toBeInTheDocument();
    expect(field('Bcc')).toBeInTheDocument();
  });

  it('autosaves the draft 800 ms after typing, and restores it on reopen', async () => {
    await loadedReply();
    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'half a thought' } });
    expect(screen.getByText('Saving…')).toBeInTheDocument();
    await advance(AUTOSAVE_MS);
    expect(screen.getByText('Draft saved')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('sm.draft.reply:a:t1')!)).toMatchObject({ text: 'half a thought', to: ['irina@example.com'] });
    vi.useRealTimers();

    cleanup();
    resetDrafts(); // only localStorage remains, as after a reload
    await loadedReply();
    expect(screen.getByLabelText('Message')).toHaveValue('half a thought');
  });

  it('Esc keeps the draft and closes without asking', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    await loadedReply();
    const body = screen.getByLabelText('Message');
    fireEvent.change(body, { target: { value: 'half a thought' } });
    fireEvent.keyDown(body, { key: 'Escape' });
    expect(await screen.findByTestId('where')).toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled();
    expect(loadDraft(draftKey('reply', 'a:t1'))?.text).toBe('half a thought');
  });

  it('the Close button keeps the draft too', async () => {
    await loadedReply();
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'later' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(await screen.findByTestId('where')).toBeInTheDocument();
    expect(loadDraft(draftKey('reply', 'a:t1'))?.text).toBe('later');
  });

  it('leaving by a link before the autosave fires still saves the draft', async () => {
    await loadedReply();
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'unsaved' } });
    expect(localStorage.getItem('sm.draft.reply:a:t1')).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
    expect(await screen.findByTestId('where')).toHaveTextContent('/settings');
    expect(JSON.parse(localStorage.getItem('sm.draft.reply:a:t1')!).text).toBe('unsaved');
  });

  it('beforeunload is handled only while a save is pending, and writes the draft', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    await loadedReply();
    expect(add.mock.calls.filter(([t]) => t === 'beforeunload')).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'quick' } });
    expect(add.mock.calls.filter(([t]) => t === 'beforeunload')).toHaveLength(1);

    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false); // saved, so nothing to ask
    expect(JSON.parse(localStorage.getItem('sm.draft.reply:a:t1')!).text).toBe('quick');
  });

  it('beforeunload asks when the draft cannot be stored', async () => {
    await loadedReply();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'quick' } });
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('Discard asks in an in-app dialog; Esc there cancels, Enter discards', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    await loadedReply();
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'half a thought' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    let dialog = screen.getByRole('dialog', { name: 'Discard draft?' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('where')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    dialog = screen.getByRole('dialog', { name: 'Discard draft?' });
    fireEvent.keyDown(dialog, { key: 'Enter' });
    expect(await screen.findByTestId('where')).toBeInTheDocument();
    expect(loadDraft(draftKey('reply', 'a:t1'))).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('Discard on an untouched reply closes without asking', async () => {
    await loadedReply();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByTestId('where')).toBeInTheDocument();
  });

  it('Esc leaves an untouched reply and stores no draft', async () => {
    await loadedReply();
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Escape' });
    expect(await screen.findByTestId('where')).toBeInTheDocument();
    expect(loadDraft(draftKey('reply', 'a:t1'))).toBeNull();
  });
});

describe('Composer inline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetOutbox();
    resetDrafts();
    vi.mocked(api.thread).mockResolvedValue(DETAIL);
    vi.mocked(api.accounts).mockResolvedValue([{ id: 'a', email: ME, color: '#2563eb', status: 'ok' }]);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function renderInline(onClose = vi.fn(), onSent = vi.fn()) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onThreadKey = vi.fn();
    const onKey = (e: KeyboardEvent) => e.key === 'e' && onThreadKey();
    window.addEventListener('keydown', onKey);
    onTestFinished(() => window.removeEventListener('keydown', onKey));
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/t/a%3At1']}>
          <Composer mode="reply" threadId="a:t1" variant="inline" onClose={onClose} onSent={onSent} />
          <OutboxToasts />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return { onClose, onSent, onThreadKey };
  }

  it('is a bordered card without a page heading; thread keys do not fire from inside it', async () => {
    const { onThreadKey } = renderInline();
    const region = await screen.findByRole('region', { name: 'Reply' });
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    expect(region.parentElement).toHaveClass('rounded-md', 'border');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Send' }), { key: 'e' });
    expect(onThreadKey).not.toHaveBeenCalled();
  });

  it('calls onClose at once and onSent after the send goes out; Undo asks the thread to reopen it', async () => {
    const { onClose, onSent } = renderInline();
    await screen.findByRole('region', { name: 'Reply' });
    vi.useFakeTimers();
    vi.mocked(api.send).mockResolvedValue({ threadId: 'a:t1' });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Yes' } });
    ctrlEnter(screen.getByLabelText('Message'));
    expect(onClose).toHaveBeenCalledTimes(1);
    await advance(UNDO_SEND_MS);
    expect(onSent).toHaveBeenCalledWith('a:t1');
  });

  it('Undo of an inline send leaves a reopen request for the thread view', async () => {
    const seen: unknown[] = [];
    function Probe() {
      seen.push(useReopenRequest());
      return null;
    }
    renderInline();
    render(<Probe />);
    await screen.findByRole('region', { name: 'Reply' });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Yes' } });
    ctrlEnter(screen.getByLabelText('Message'));
    fireEvent.click(screen.getByRole('button', { name: /Undo/ }));
    expect(seen.at(-1)).toEqual({ mode: 'reply', threadId: 'a:t1' });
    expect(api.send).not.toHaveBeenCalled();
  });

  const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
});

describe('CommandPalette', () => {
  function renderPalette() {
    vi.mocked(api.groups).mockResolvedValue([
      { id: 'dev', name: 'Dev', position: 2, color: '#000', notify: false, kind: 'builtin', inboxCount: 3, unreadCount: 1 },
    ]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const done = vi.fn();
    const onGroup = vi.fn();
    function Host() {
      return (
        <>
          <CommandPalette context="list" onGroup={onGroup} />
          <Where />
        </>
      );
    }
    // A view's own shortcut handler, to prove palette commands go through the same bindings.
    const onKey = (e: KeyboardEvent) => e.key === 'e' && done();
    window.addEventListener('keydown', onKey);
    onTestFinished(() => window.removeEventListener('keydown', onKey));
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="*" element={<Host />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return { done, onGroup };
  }

  function open() {
    act(() => {
      fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    });
    return screen.getByRole('dialog', { name: 'Command palette' });
  }

  it('lists bindings, Skipped your inbox, Settings and each group', async () => {
    renderPalette();
    const dialog = open();
    expect(within(dialog).getByText('Done')).toBeInTheDocument();
    expect(within(dialog).getByText('Reply')).toBeInTheDocument();
    expect(within(dialog).getByText('Skipped your inbox')).toBeInTheDocument();
    expect(within(dialog).getByText('Settings')).toBeInTheDocument();
    expect(await within(dialog).findByText('Go to Dev')).toBeInTheDocument();
  });

  it('offers Report spam with its key, and the Spam page', () => {
    renderPalette();
    const dialog = open();
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'spam' } });
    const option = within(dialog).getByRole('option', { name: /Report spam/ });
    expect(option).toHaveAttribute('aria-disabled', 'false');
    expect(within(option).getByText('!')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('option', { name: /^Spam/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/spam');
  });

  it('runs a binding by replaying its key, and navigates for pages', async () => {
    const { done } = renderPalette();
    let dialog = open();
    const input = within(dialog).getByRole('combobox');
    fireEvent.change(input, { target: { value: 'done' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1)); // "done" means Done, not "Show / hide done"

    dialog = open();
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'settings' } });
    fireEvent.keyDown(within(dialog).getByRole('combobox'), { key: 'Enter' });
    expect(screen.getByTestId('where')).toHaveTextContent('/settings');
  });

  it('picks a group and closes on Escape', async () => {
    const { onGroup } = renderPalette();
    let dialog = open();
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'dev' } });
    fireEvent.click(await within(dialog).findByText('Go to Dev'));
    expect(onGroup).toHaveBeenCalledWith('dev');

    dialog = open();
    fireEvent.keyDown(within(dialog).getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('Compose on the phone', () => {
  beforeEach(stubPhone);
  afterEach(endScreens);

  it('fills the screen by itself, with no app header, and its rows are the touch size', async () => {
    renderAt('/compose');
    const form = await screen.findByRole('region', { name: 'New message' });
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    expect(form.parentElement).toHaveClass('fixed', 'h-dvh');
    expect(within(form).getByRole('button', { name: 'Cc Bcc' })).toHaveClass('h-11');
    expect(within(form).getByLabelText('Subject')).toHaveClass('text-[16px]', 'h-11');
    expect(form.querySelector('kbd')).toBeNull();
  });

  it('folds an idle recipient field away beside its chips, and the label opens it again', async () => {
    vi.mocked(api.thread).mockResolvedValue(DETAIL);
    renderAt('/compose?thread=a%3At1&mode=reply');
    const form = await screen.findByRole('region', { name: 'Reply' });
    const input = within(form).getByRole('combobox', { name: 'To recipients' });
    expect(input.className).toContain('max-md:[&:not(:focus)]:w-0');
    fireEvent.click(within(form).getByText('To'));
    expect(input).toHaveFocus();
  });

  it('adds no history entry of its own: the page is one, so Close goes straight back', async () => {
    renderAt('/compose');
    const form = await screen.findByRole('region', { name: 'New message' });
    fireEvent.click(within(form).getByRole('button', { name: 'Close' }));
    expect(await screen.findByTestId('where')).toHaveTextContent('/');
  });

  it('Discard from the confirmation sheet leaves the page', async () => {
    renderAt('/compose');
    const form = await screen.findByRole('region', { name: 'New message' });
    fireEvent.change(within(form).getByLabelText('Message'), { target: { value: 'Draft' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Discard' }));
    const sheet = await screen.findByRole('dialog', { name: 'Discard draft?' });
    await act(() => new Promise((r) => setTimeout(r, 10)));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Discard' }));
    expect(await screen.findByTestId('where')).toHaveTextContent('/');
  });
});
