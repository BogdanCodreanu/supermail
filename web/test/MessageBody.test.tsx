import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageDTO, ThreadDetailDTO, ThreadSummaryDTO } from '@supermail/shared';
import { blockRemoteContent, buildSrcdoc, fitFrame, hasOwnColours, MessageBody, sanitizeHtml } from '../src/components/MessageBody';

vi.mock('../src/api/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/api/client')>();
  return {
    ...real,
    api: {
      thread: vi.fn(),
      read: vi.fn(),
      accounts: vi.fn(),
      groups: vi.fn(),
    },
  };
});

const { api } = await import('../src/api/client');
const { Thread } = await import('../src/views/Thread');

function message(over: Partial<MessageDTO> = {}): MessageDTO {
  return {
    id: 'a:m1',
    gmailMessageId: 'm1',
    from: { name: 'Ana', email: 'irina@example.com' },
    to: [{ name: null, email: 'me@gmail.com' }],
    cc: [],
    date: Date.UTC(2026, 9, 29, 9, 0),
    subject: 'Hello',
    html: null,
    text: null,
    attachments: [],
    ...over,
  };
}

function srcdocOf(container: HTMLElement): { iframe: HTMLIFrameElement; srcdoc: string } {
  const iframe = container.querySelector('iframe');
  if (!iframe) throw new Error('no iframe rendered');
  return { iframe, srcdoc: iframe.getAttribute('srcdoc') ?? '' };
}

/** A stand-in for the frame's document: jsdom has no layout, so sizes are given. */
function fakeFrameDoc({ width, height }: { width: number; height: number }): Document {
  const doc = document.implementation.createHTMLDocument('frame');
  Object.defineProperty(doc.documentElement, 'scrollWidth', { configurable: true, value: width });
  Object.defineProperty(doc.body, 'scrollWidth', { configurable: true, value: width });
  Object.defineProperty(doc.body, 'scrollHeight', { configurable: true, value: height });
  return doc;
}

describe('fitFrame', () => {
  it('uses the content height when the content fits the pane', () => {
    expect(fitFrame({ contentW: 600, contentH: 800, containerW: 700 })).toEqual({ scale: 1, frameW: null, frameH: 800, boxH: 800 });
  });

  it('scales wider content down to the pane and corrects the height', () => {
    expect(fitFrame({ contentW: 800, contentH: 1000, containerW: 600 })).toEqual({ scale: 0.75, frameW: 800, frameH: 1000, boxH: 750 });
  });

  it('does not scale when the pane width is unknown', () => {
    expect(fitFrame({ contentW: 800, contentH: 100, containerW: 0 }).scale).toBe(1);
  });
});

describe('email canvas', () => {
  it.each([
    ['a bgcolor', '<table bgcolor="#ffcc00"><tr><td>Sale</td></tr></table>'],
    ['a background attribute', '<td background="https://cdn.example.com/bg.png">x</td>'],
    ['an inline colour', '<p style="font-size:14px; color:#333">x</p>'],
    ['an inline background', "<div style='background-color: #f4f4f4'>x</div>"],
    ['a style block', '<style>body { background: #eee }</style><p>x</p>'],
    ['a font colour', '<font color="red">x</font>'],
  ])('keeps a white canvas for designed HTML (%s)', (_, html) => {
    expect(hasOwnColours(html)).toBe(true);
    const { container } = render(<MessageBody message={message({ html })} />);
    expect(container.querySelector('[data-canvas]')).toHaveAttribute('data-canvas', 'white');
    expect(srcdocOf(container).srcdoc).toContain('html{background:#fff');
  });

  it('renders HTML without colours of its own in the app theme: transparent, theme text and links', () => {
    document.documentElement.style.setProperty('--fg', '#e2e8f0');
    document.documentElement.style.setProperty('--accent', '#60a5fa');
    try {
      const html = '<div dir="ltr"><p style="margin:0; border-color:#ccc">Hi, see <a href="https://example.com">this</a></p></div>';
      expect(hasOwnColours(html)).toBe(false);
      const { container } = render(<MessageBody message={message({ html })} />);
      expect(container.querySelector('[data-canvas]')).toHaveAttribute('data-canvas', 'theme');
      const { srcdoc } = srcdocOf(container);
      expect(srcdoc).toContain('background:transparent');
      expect(srcdoc).not.toContain('background:#fff');
      expect(srcdoc).toContain('color:#e2e8f0');
      expect(srcdoc).toMatch(/a\{color:#60a5fa/);
    } finally {
      document.documentElement.style.removeProperty('--fg');
      document.documentElement.style.removeProperty('--accent');
    }
  });

  it('shows plain-text messages in the theme too, never on a white card', () => {
    const { container } = render(<MessageBody message={message({ text: 'plain words' })} />);
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('[data-canvas]')).toHaveAttribute('data-canvas', 'theme');
    expect(container.innerHTML).not.toMatch(/bg-white|#fff/);
  });
});

describe('blockRemote', () => {
  const srcdoc = (html: string) => buildSrcdoc(html, null, true);
  const body = (html: string) => {
    const doc = new DOMParser().parseFromString(srcdoc(html), 'text/html');
    return { doc, all: [...doc.body.querySelectorAll('*')] };
  };

  it.each([
    ['img src', '<img src="https://track.example/p.gif" alt="logo">'],
    ['protocol-relative img src', '<img src="//track.example/p.gif">'],
    ['upper-case scheme', '<img src="HTTP://track.example/p.gif">'],
    ['srcset', '<img srcset="https://a.example/1.png 1x, https://a.example/2.png 2x">'],
    ['background attribute', '<table background="https://a.example/bg.png"><tr><td>x</td></tr></table>'],
    ['video poster', '<video poster="https://a.example/p.png" src="https://a.example/v.mp4"></video>'],
    ['audio', '<audio src="https://a.example/a.mp3"></audio>'],
    ['source', '<picture><source srcset="https://a.example/1.png"><img src="https://a.example/2.png"></picture>'],
  ])('removes %s', (_name, html) => {
    const out = srcdoc(html);
    expect(out).not.toMatch(/(?:src|srcset|background|poster)\s*=\s*["']?(?:https?:)?\/\//i);
    expect(out).not.toContain('a.example');
    expect(out).not.toContain('track.example');
  });

  it.each([
    ['background image', '<div style="background-image:url(https://a.example/b.png)">x</div>'],
    ['background shorthand', '<div style="background: #fff url(\'https://a.example/b.png\') no-repeat">x</div>'],
    ['an upper-case URL()', '<div style="background:URL(https://a.example/b.png)">x</div>'],
    ['a data: url()', '<div style="background:url(data:image/png;base64,AAAA)">x</div>'],
    ['list-style-image', '<ul style="list-style-image:url(https://a.example/b.png)"><li>x</li></ul>'],
    ['image-set', '<div style="background-image:image-set(\'https://a.example/b.png\' 1x)">x</div>'],
    ['a CSS escape', '<div style="background:u\\72 l(https://a.example/b.png)">x</div>'],
  ])('removes %s from inline styles', (_name, html) => {
    const out = srcdoc(html);
    expect(out).not.toMatch(/url\(/i);
    expect(out).not.toContain('a.example');
  });

  it('keeps the rest of an inline style', () => {
    const { all } = body('<div style="color:#123456;background:url(https://a.example/b.png);padding:4px">x</div>');
    const style = all[0]!.getAttribute('style')!;
    expect(style).toContain('color:#123456');
    expect(style).toContain('padding:4px');
    expect(style).not.toContain('background');
  });

  it('removes SVG images but keeps inline data: images and alt text', () => {
    expect(srcdoc('<svg><image href="https://a.example/x.png"></image></svg>')).not.toContain('a.example');
    const { all } = body('<img src="data:image/png;base64,AAAA" alt="inline"><img src="https://a.example/x.png" alt="remote">');
    expect(all[0]!.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(all[1]!.hasAttribute('src')).toBe(false);
    expect(all[1]!.getAttribute('alt')).toBe('remote');
  });

  it('keeps links, opening safely in a new tab', () => {
    const { all } = body('<a href="https://shop.example/claim">Claim</a>');
    expect(all[0]!.getAttribute('href')).toBe('https://shop.example/claim');
    expect(all[0]!.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('the frame refuses remote content by itself, as a second line of defence', () => {
    const csp = /Content-Security-Policy" content="([^"]*)"/.exec(srcdoc('<p>x</p>'))![1]!;
    expect(csp).toContain('img-src data:');
    expect(csp).toContain('font-src data:');
    expect(csp).toContain("media-src 'none'");
    expect(csp).not.toContain('*');
  });

  it('normal mail is untouched', () => {
    const out = buildSrcdoc('<img src="https://a.example/x.png" style="background:url(https://a.example/b.png)">');
    expect(out).toContain('src="https://a.example/x.png"');
    expect(out).toContain('img-src * data: blob:');
  });

  it('blockRemoteContent only strips, it does not sanitize again', () => {
    expect(blockRemoteContent('<p>Hello <b>you</b></p>')).toBe('<p>Hello <b>you</b></p>');
  });

  it('MessageBody says so under an HTML message, and blocks the frame', () => {
    render(<MessageBody blockRemote message={message({ html: '<img src="https://a.example/x.png">', text: null })} />);
    expect(screen.getByText('Remote images are blocked in spam')).toBeInTheDocument();
    expect(screen.getByTitle('Hello').getAttribute('srcdoc')).not.toContain('a.example');
  });

  it('blocks the quoted part too when it is shown', () => {
    const html = '<p>Hi</p><div class="gmail_quote"><img src="https://a.example/x.png">old</div>';
    render(<MessageBody blockRemote message={message({ html, text: null })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show quoted text' }));
    expect(screen.getByTitle('Hello').getAttribute('srcdoc')).not.toContain('a.example');
  });

  it('has nothing to say about plain text', () => {
    render(<MessageBody blockRemote message={message({ html: null, text: 'hello' })} />);
    expect(screen.queryByText('Remote images are blocked in spam')).not.toBeInTheDocument();
  });

  it('says nothing on normal mail', () => {
    render(<MessageBody message={message({ html: '<p>Hi</p>', text: null })} />);
    expect(screen.queryByText('Remote images are blocked in spam')).not.toBeInTheDocument();
  });
});

describe('MessageBody', () => {
  it('renders hostile HTML inert in a sandboxed iframe (Review Focus 5)', () => {
    const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script><form><input></form><p>visible</p>';
    const { container } = render(<MessageBody message={message({ html: hostile })} />);
    const { iframe, srcdoc } = srcdocOf(container);

    expect(srcdoc).not.toMatch(/onerror/i);
    expect(srcdoc).not.toMatch(/<script/i);
    expect(srcdoc).not.toMatch(/<form/i);
    expect(srcdoc).not.toMatch(/<input/i);
    expect(srcdoc).toContain('visible');

    const sandbox = iframe.getAttribute('sandbox');
    expect(sandbox).not.toBeNull();
    expect(sandbox).not.toMatch(/allow-scripts/);
    expect(srcdoc).toMatch(/script-src 'none'/);
  });

  it('sandboxes the frame same-origin (to measure it) but never with scripts', () => {
    const { container } = render(<MessageBody message={message({ html: '<p>x</p>' })} />);
    const tokens = (srcdocOf(container).iframe.getAttribute('sandbox') ?? '').split(/\s+/);
    expect(tokens).not.toContain('allow-scripts');
    expect(tokens).not.toContain('allow-forms');
    expect(tokens).not.toContain('allow-top-navigation');
    expect(tokens.sort()).toEqual(['allow-popups', 'allow-popups-to-escape-sandbox', 'allow-same-origin']);
  });

  it('drops relative and same-origin resource URLs, so mail cannot make authenticated requests to SuperMail', () => {
    const out = sanitizeHtml(
      `<img src="/api/threads"><img src="${location.origin}/api/me"><img src="https://cdn.example.com/a.png"><img src="data:image/png;base64,AAAA">` +
        `<a href="/settings">rel</a><a href="#top">anchor</a><a href="mailto:a@b.c">mail</a>`,
    );
    const doc = new DOMParser().parseFromString(out, 'text/html');
    const srcs = [...doc.querySelectorAll('img')].map((i) => i.getAttribute('src'));
    expect(srcs).toEqual([null, null, 'https://cdn.example.com/a.png', 'data:image/png;base64,AAAA']);
    const hrefs = [...doc.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([null, '#top', 'mailto:a@b.c']);
  });

  it('sizes the frame to its content after load, with no inner scrollbar', () => {
    const { container } = render(<MessageBody message={message({ html: '<p>tall</p>' })} />);
    const { iframe } = srcdocOf(container);
    const doc = fakeFrameDoc({ width: 0, height: 1234 });
    Object.defineProperty(iframe, 'contentDocument', { configurable: true, value: doc });
    fireEvent.load(iframe);
    const box = iframe.parentElement!;
    expect(box.style.height).toBe('1234px');
    expect(iframe.style.height).toBe('1234px');
    expect(doc.documentElement.style.overflow).toBe('hidden');
    expect(iframe).toHaveClass('opacity-100');
  });

  it('collapses quoted history behind a toggle', () => {
    const html = '<div>New reply</div><div class="gmail_quote"><div class="gmail_attr">On Mon, Ana wrote:</div><blockquote>Old words</blockquote></div>';
    const { container } = render(<MessageBody message={message({ html })} />);
    expect(srcdocOf(container).srcdoc).not.toContain('Old words');
    const toggle = screen.getByRole('button', { name: 'Show quoted text' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(srcdocOf(container).srcdoc).toContain('Old words');
    expect(screen.getByRole('button', { name: 'Hide quoted text' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('collapses quoted plain text behind a toggle', () => {
    render(<MessageBody message={message({ text: 'Thanks!\nOn Mon, Ana wrote:\n> old line' })} />);
    expect(screen.queryByText(/old line/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show quoted text' }));
    expect(screen.getByText(/old line/)).toBeInTheDocument();
  });

  it('shows no toggle when there is no quote', () => {
    render(<MessageBody message={message({ html: '<p>just this</p>' })} />);
    expect(screen.queryByRole('button', { name: /quoted text/ })).toBeNull();
  });

  it('strips every on* handler, forbidden tags and javascript: links', () => {
    const out = sanitizeHtml(
      '<div onclick="x()" onmouseover="y()" style="color:red">hi</div><style>body{}</style><iframe src="https://e.com"></iframe>' +
        '<object data="x"></object><embed src="x"><button>b</button><a href="javascript:alert(1)">bad</a><svg onload="z()"></svg>',
    );
    expect(out).not.toMatch(/\son[a-z]+=/i);
    expect(out).not.toMatch(/<(style|iframe|object|embed|button|script|form|input)\b/i);
    expect(out).not.toMatch(/javascript:/i);
    expect(out).toContain('color:red');
  });

  it('opens links in a new tab without opener and keeps remote images', () => {
    const out = sanitizeHtml('<a href="https://example.com/x">x</a><img src="https://cdn.example.com/a.png">');
    const doc = new DOMParser().parseFromString(out, 'text/html');
    const a = doc.querySelector('a')!;
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(doc.querySelector('img')!.getAttribute('src')).toBe('https://cdn.example.com/a.png');
  });

  it('shows plain text in a pre when there is no HTML', () => {
    const { container } = render(<MessageBody message={message({ text: 'line one\nline <b>two</b>' })} />);
    expect(container.querySelector('iframe')).toBeNull();
    const pre = container.querySelector('pre')!;
    expect(pre).toHaveClass('whitespace-pre-wrap');
    expect(pre.textContent).toBe('line one\nline <b>two</b>');
  });

  it('sanitizes a 5 MB body without throwing', () => {
    const huge = '<p onclick="x()">' + 'a'.repeat(5 * 1024 * 1024) + '</p><script>1</script>';
    const out = sanitizeHtml(huge);
    expect(out.length).toBeGreaterThan(5 * 1024 * 1024);
    expect(out).not.toMatch(/<script|onclick/i);
  });
});

function summary(over: Partial<ThreadSummaryDTO> = {}): ThreadSummaryDTO {
  return {
    id: 'a:t1',
    accountId: 'a',
    subject: 'Hello',
    snippet: 'hi',
    fromName: 'Ana',
    fromEmail: 'irina@example.com',
    lastMessageAt: Date.UTC(2026, 9, 29, 9, 0),
    unread: true,
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

describe('Thread view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.accounts).mockResolvedValue([{ id: 'a', email: 'me@gmail.com', color: '#2563eb', status: 'ok' }]);
    vi.mocked(api.groups).mockResolvedValue([]);
  });

  function renderThread() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/t/a%3At1']}>
          <Routes>
            <Route path="/t/:id" element={<Thread />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('marks an unread thread read when it is opened, and shows the reason', async () => {
    const detail: ThreadDetailDTO = { thread: summary(), messages: [message({ text: 'body text' })] };
    vi.mocked(api.thread).mockResolvedValue(detail);
    vi.mocked(api.read).mockResolvedValue({ undoId: 'u1', thread: summary({ unread: false }) });
    renderThread();
    expect(await screen.findByText('body text')).toBeInTheDocument();
    await waitFor(() => expect(api.read).toHaveBeenCalledWith('a:t1', true));
    expect(api.read).toHaveBeenCalledTimes(1);
    expect(screen.getByText('In Important: automatic guess')).toBeInTheDocument();
  });

  it('does not mark an already-read thread', async () => {
    vi.mocked(api.thread).mockResolvedValue({ thread: summary({ unread: false }), messages: [message({ text: 'x' })] });
    renderThread();
    expect(await screen.findByText('x')).toBeInTheDocument();
    expect(api.read).not.toHaveBeenCalled();
  });
});
