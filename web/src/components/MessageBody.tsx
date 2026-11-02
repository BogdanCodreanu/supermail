import DOMPurify from 'dompurify';
import { Ellipsis, ImageOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { MessageDTO } from '@supermail/shared';
import { splitQuotedHtml, splitQuotedText } from '../lib/quotes';
import { useIsPhone } from '../lib/useIsPhone';

// Email HTML is hostile by default (Review Focus 5). It is sanitized here, then rendered in an iframe
// whose sandbox never allows scripts, so nothing in it can run (the frame's CSP says the same). It is
// same-origin only so the app can read its content size and fit the frame to it; resource URLs that
// point back at SuperMail are dropped, so mail cannot make authenticated requests to the API.

const FORBID_TAGS = ['script', 'style', 'form', 'input', 'button', 'iframe', 'object', 'embed'];

// FORBID_ATTR has no wildcard, so the common handlers are listed and a hook drops any other `on*`.
const ON_ATTRS = [
  'onabort', 'onafterprint', 'onanimationend', 'onanimationiteration', 'onanimationstart', 'onbeforeprint',
  'onbeforeunload', 'onblur', 'oncanplay', 'onchange', 'onclick', 'oncontextmenu', 'oncopy', 'oncut',
  'ondblclick', 'ondrag', 'ondragend', 'ondragenter', 'ondragleave', 'ondragover', 'ondragstart', 'ondrop',
  'onerror', 'onfocus', 'onfocusin', 'onfocusout', 'onhashchange', 'oninput', 'oninvalid', 'onkeydown',
  'onkeypress', 'onkeyup', 'onload', 'onmessage', 'onmousedown', 'onmouseenter', 'onmouseleave',
  'onmousemove', 'onmouseout', 'onmouseover', 'onmouseup', 'onpageshow', 'onpaste', 'onpointerdown',
  'onpointerenter', 'onpointerleave', 'onpointermove', 'onpointerup', 'onreset', 'onresize', 'onscroll',
  'onselect', 'onsubmit', 'ontoggle', 'ontouchend', 'ontouchmove', 'ontouchstart', 'ontransitionend',
  'onunload', 'onwheel',
];

export const SANDBOX = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox';

// A private instance, so these hooks never leak into another DOMPurify user.
const purify = DOMPurify(window);
const URL_ATTRS = new Set(['src', 'href', 'srcset', 'background', 'poster', 'xlink:href']);
const SAFE_RELATIVE = /^(#|mailto:|tel:|data:|cid:)/i;

/** True for a URL that resolves to SuperMail itself (relative ones do, inside the frame). */
function pointsHome(value: string, list: boolean): boolean {
  // srcset lists several "url descriptor" entries; any one pointing home drops the attribute.
  const urls = (list ? value.split(',') : [value]).map((u) => u.trim().split(/\s+/)[0] ?? '');
  return urls.some((u) => {
    if (SAFE_RELATIVE.test(u)) return false;
    try {
      return new URL(u, window.location.href).origin === window.location.origin;
    } catch {
      return true;
    }
  });
}

purify.addHook('uponSanitizeAttribute', (_node, data) => {
  if (/^on/i.test(data.attrName)) data.keepAttr = false;
  else if (URL_ATTRS.has(data.attrName.toLowerCase()) && pointsHome(data.attrValue, data.attrName.toLowerCase() === 'srcset')) data.keepAttr = false;
});
purify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/** Sanitized body HTML: no scripts, styles blocks, forms, frames or event handlers; links open in a new tab. */
export function sanitizeHtml(html: string): string {
  return purify.sanitize(html, { FORBID_TAGS, FORBID_ATTR: ON_ATTRS, ADD_ATTR: ['target'] });
}

// Spam must not learn that it was opened, so what it loads by itself goes. Inline `data:` images stay, and so do
// links: a link only loads when the owner clicks it.
const REMOTE_ATTRS = new Set(['src', 'srcset', 'background', 'poster', 'lowsrc', 'data', 'href', 'xlink:href']);
const INLINE_IMAGE = /^\s*data:image\//i;
/** Whatever in a style can load a URL, or hide one behind a CSS escape or comment. */
const CSS_LOADS = /url\s*\(|image\s*\(|image-set|src\s*\(|@import|\\|\/\*/i;
/** A `;` that ends a declaration, not one inside `url(data:…;base64,…)`. */
const DECLARATION_END = /;(?![^(]*\))/;

/** Takes out everything sanitized mail would load by itself: image and media URLs, and any url() in its styles. */
export function blockRemoteContent(clean: string): string {
  const { body } = new DOMParser().parseFromString(clean, 'text/html');
  for (const el of body.querySelectorAll('*')) {
    const isLink = el.localName === 'a' || el.localName === 'area';
    for (const { name, value } of [...el.attributes]) {
      const attr = name.toLowerCase();
      if (attr === 'style') {
        const kept = value.split(DECLARATION_END).filter((d) => !CSS_LOADS.test(d)).join(';');
        if (kept.trim()) el.setAttribute(name, kept);
        else el.removeAttribute(name);
      } else if (REMOTE_ATTRS.has(attr) && !(isLink && attr.endsWith('href')) && !(attr === 'src' && INLINE_IMAGE.test(value))) {
        el.removeAttribute(name);
      }
    }
  }
  return body.innerHTML;
}

// A second line of defence inside the frame. Remote images and inline styles are allowed (spec §4.5).
const CSP = [
  "default-src 'none'",
  'img-src * data: blob:',
  "style-src 'unsafe-inline' *",
  'font-src * data:',
  'media-src *',
  "script-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

/** The same for spam: the frame itself refuses anything remote, should the stripping ever miss something. */
const BLOCKED_CSP = [
  "default-src 'none'",
  'img-src data:',
  "style-src 'unsafe-inline'",
  'font-src data:',
  "media-src 'none'",
  "script-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

// The frame is sized to the body, so the body must not size itself to the frame (height:100%, 100vh).
// Images keep the aspect ratio of their width/height attributes, so they reserve space before loading.
const FRAME_BASE =
  'html,body{height:auto!important;min-height:0!important}' +
  'body{margin:0;font:13px/1.6 "Inter Variable",Inter,-apple-system,"Segoe UI",system-ui,sans-serif;overflow-wrap:anywhere}' +
  'img{max-width:100%;height:auto}pre{white-space:pre-wrap}';
/** Designed mail (newsletters) sets its own colours: it keeps the white canvas it was designed on. */
/** Email text is larger on the phone. Decided by the app, not a media query: the frame's own width says nothing (wide mail is laid out wide). */
const PHONE_TEXT = 'body{font-size:15px}';
const WHITE_CANVAS = 'html{background:#fff;color-scheme:light}body{padding:12px 16px;color:#0f172a}';

/** The app's colours for mail that has none of its own (the frame can't read the app's CSS variables). */
export interface FrameTheme { fg: string; link: string; scheme: string }
const LIGHT: FrameTheme = { fg: '#0f172a', link: '#2563eb', scheme: 'light' };

/** Mail without colours of its own reads in the app's theme, lined up with plain-text mail. */
function themedCanvas(t: FrameTheme): string {
  return `html{background:transparent;color-scheme:${t.scheme}}body{padding:8px 0;color:${t.fg}}a{color:${t.link}}`;
}

const DECLARES_COLOUR = /(?:^|[;{\s"'])(?:color|background(?:-color|-image)?)\s*:/i;
const STYLE_ATTR = /\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const COLOUR_ATTR = /<[a-z][^>]*\s(?:bgcolor|background)\s*=|<font\b[^>]*\scolor\s*=|<body\b[^>]*\s(?:text|link)\s*=/i;

/** Whether the mail sets colours or backgrounds of its own (style attributes or blocks, bgcolor, <font color>). */
export function hasOwnColours(html: string): boolean {
  if (COLOUR_ATTR.test(html)) return true;
  for (const m of html.matchAll(STYLE_ATTR)) if (DECLARES_COLOUR.test(m[1]!)) return true;
  for (const m of html.matchAll(STYLE_BLOCK)) if (DECLARES_COLOUR.test(m[1]!)) return true;
  return false;
}

/** The full document for the iframe's `srcdoc`: on a white canvas, or in `theme` when given. */
export function buildSrcdoc(html: string, theme: FrameTheme | null = null, blockRemote = false, phone = false): string {
  const clean = sanitizeHtml(html);
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${blockRemote ? BLOCKED_CSP : CSP}">` +
    '<base target="_blank">' +
    `<style>${FRAME_BASE}${phone ? PHONE_TEXT : ''}${theme ? themedCanvas(theme) : WHITE_CANVAS}</style></head><body>${blockRemote ? blockRemoteContent(clean) : clean}</body></html>`
  );
}

const SAFE_CSS_VALUE = /^[#\w\s(),.%-]+$/;
function cssVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const v = style.getPropertyValue(name).trim();
  return v && SAFE_CSS_VALUE.test(v) ? v : fallback;
}

/** The app's current text and link colours, as a string so the snapshot compares by value. */
function readTheme(): string {
  const style = getComputedStyle(document.documentElement);
  const scheme = /dark/.test(style.colorScheme ?? '') ? 'dark' : 'light';
  return JSON.stringify({ fg: cssVar(style, '--fg', LIGHT.fg), link: cssVar(style, '--accent', LIGHT.link), scheme } satisfies FrameTheme);
}

function subscribeScheme(onChange: () => void): () => void {
  const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  mq?.addEventListener?.('change', onChange);
  return () => mq?.removeEventListener?.('change', onChange);
}

/** Follows the app theme, light or dark, as the system switches. */
function useAppTheme(): FrameTheme {
  const raw = useSyncExternalStore(subscribeScheme, readTheme, () => JSON.stringify(LIGHT));
  return useMemo(() => JSON.parse(raw) as FrameTheme, [raw]);
}

export interface FrameFit {
  /** Below 1 when the content is wider than the pane and is scaled down to fit. */
  scale: number;
  /** The frame's layout width: the content's own width when scaled, else null (the pane's width). */
  frameW: number | null;
  frameH: number;
  /** The visible height after scaling. */
  boxH: number;
}

/** How to size the frame so the content shows whole: no inner scrollbars, wide mail scaled down to the pane. */
export function fitFrame({ contentW, contentH, containerW }: { contentW: number; contentH: number; containerW: number }): FrameFit {
  if (containerW <= 0 || contentW <= containerW + 1) return { scale: 1, frameW: null, frameH: contentH, boxH: contentH };
  const scale = containerW / contentW;
  return { scale, frameW: contentW, frameH: contentH, boxH: Math.ceil(contentH * scale) };
}

/** The content's size inside the frame, or null when its document isn't there yet. */
function contentSize(doc: Document | null): { w: number; h: number } | null {
  const html = doc?.documentElement;
  const body = doc?.body;
  if (!html || !body) return null;
  const h = Math.ceil(Math.max(html.getBoundingClientRect().height, body.scrollHeight));
  const w = Math.ceil(Math.max(html.scrollWidth, body.scrollWidth));
  return h > 0 ? { w, h } : null;
}

/** A first guess at the height, reserved while the frame loads. */
function estimateHeight(html: string): number {
  const text = html.replace(/<[^>]*>/g, '').length;
  const blocks = (html.match(/<(p|div|tr|br|li|h\d|img)\b/gi) ?? []).length;
  return Math.min(Math.max(120, Math.round(text / 90) * 21 + blocks * 12 + 40), 900);
}

/** The longest the frame stays hidden waiting for its images before it shows anyway. */
const REVEAL_AFTER_MS = 1500;

function HtmlFrame({ html, title, themed, blockRemote }: { html: string; title: string; themed: boolean; blockRemote: boolean }) {
  const theme = useAppTheme();
  const phone = useIsPhone();
  const srcdoc = useMemo(() => buildSrcdoc(html, themed ? theme : null, blockRemote, phone), [html, themed, theme, blockRemote, phone]);
  const estimate = useMemo(() => estimateHeight(html), [html]);
  const boxRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [fit, setFit] = useState<FrameFit | null>(null);
  const [ready, setReady] = useState(false);
  const detach = useRef<() => void>(() => undefined);

  const measure = useCallback(() => {
    const frame = frameRef.current;
    const box = boxRef.current;
    const doc = frame?.contentDocument ?? null;
    if (!frame || !box || !doc?.body) return false;
    doc.documentElement.style.overflow = 'hidden'; // sized to fit, so it never scrolls inside
    const size = contentSize(doc);
    if (!size) return false;
    const next = fitFrame({ contentW: size.w, contentH: size.h, containerW: box.clientWidth });
    setFit((cur) => (cur && cur.boxH === next.boxH && cur.frameW === next.frameW && cur.frameH === next.frameH ? cur : next));
    return true;
  }, []);

  // A new body starts hidden at the estimate; it shows once loaded (images included) or after a short wait.
  useEffect(() => {
    setFit(null);
    setReady(false);
    const t = setTimeout(() => {
      measure();
      setReady(true);
    }, REVEAL_AFTER_MS);
    return () => {
      clearTimeout(t);
      detach.current();
    };
  }, [srcdoc, measure]);

  // A narrower or wider pane re-fits from the pane's width.
  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    let width = box.clientWidth;
    const ro = new ResizeObserver(() => {
      if (box.clientWidth === width) return;
      width = box.clientWidth;
      setFit((cur) => (cur ? { ...cur, scale: 1, frameW: null } : cur));
      requestAnimationFrame(() => measure());
    });
    ro.observe(box);
    return () => ro.disconnect();
  }, [measure]);

  const onLoad = () => {
    detach.current();
    const doc = frameRef.current?.contentDocument;
    if (doc?.body) {
      // Late changes (lazy images, web fonts) re-fit the frame.
      const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure());
      ro?.observe(doc.documentElement);
      ro?.observe(doc.body);
      const onImage = () => measure();
      doc.addEventListener('load', onImage, true);
      // Keys pressed after clicking into the mail still reach the app's shortcuts.
      const onKey = (e: KeyboardEvent) => {
        const copy = new KeyboardEvent('keydown', {
          key: e.key, code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, bubbles: true, cancelable: true,
        });
        window.dispatchEvent(copy);
        if (copy.defaultPrevented) e.preventDefault();
      };
      doc.addEventListener('keydown', onKey);
      detach.current = () => {
        ro?.disconnect();
        doc.removeEventListener('load', onImage, true);
        doc.removeEventListener('keydown', onKey);
      };
    }
    measure();
    setReady(true);
  };

  const height = fit?.boxH ?? estimate;
  // On the phone the white canvas runs to the screen's edges (the message's 16px gutters), not a card on a dark page.
  return (
    <div ref={boxRef} data-canvas={themed ? 'theme' : 'white'} className={`overflow-hidden ${themed ? 'rounded' : '-mx-4 md:mx-0 md:rounded'}`} style={{ height }}>
      <iframe
        ref={frameRef}
        title={title}
        sandbox={SANDBOX}
        srcDoc={srcdoc}
        referrerPolicy="no-referrer"
        onLoad={onLoad}
        className={`block border-0 transition-opacity duration-150 ease-out ${ready ? 'opacity-100' : 'opacity-0'}`}
        style={{
          width: fit?.frameW ?? '100%',
          height: fit?.frameH ?? estimate,
          transform: fit && fit.scale < 1 ? `scale(${fit.scale})` : undefined,
          transformOrigin: '0 0',
        }}
      />
    </div>
  );
}

function QuoteToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const label = open ? 'Hide quoted text' : 'Show quoted text';
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={label}
      title={label}
      className="mt-1 inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded border border-line bg-panel text-muted hover:bg-hover hover:text-fg max-md:active:bg-hover md:h-6 md:w-8"
    >
      <Ellipsis size={14} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}

/**
 * One message body: sanitized HTML in a fitted, sandboxed frame, or plain text; quoted history folded away.
 * `blockRemote` loads nothing remote and says so, for mail that must not learn it was opened.
 */
export function MessageBody({ message, blockRemote = false }: { message: Pick<MessageDTO, 'html' | 'text' | 'subject'>; blockRemote?: boolean }) {
  const [showQuoted, setShowQuoted] = useState(false);
  const html = useMemo(() => (message.html ? splitQuotedHtml(message.html) : null), [message.html]);
  const text = useMemo(() => (message.html ? null : splitQuotedText(message.text ?? '')), [message.html, message.text]);
  // Decided on the whole message, so showing the quoted part never switches the canvas.
  const themed = useMemo(() => (message.html ? !hasOwnColours(message.html) : true), [message.html]);

  if (html) {
    return (
      <div>
        <HtmlFrame html={showQuoted || !html.quoted ? message.html! : html.main} title={message.subject || 'Message'} themed={themed} blockRemote={blockRemote} />
        {html.quoted && <QuoteToggle open={showQuoted} onToggle={() => setShowQuoted((v) => !v)} />}
        {blockRemote && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
            <ImageOff size={14} strokeWidth={1.75} aria-hidden="true" />
            Remote images are blocked in spam
          </p>
        )}
      </div>
    );
  }
  const quoted = text?.quoted ?? null;
  return (
    <div data-canvas="theme">
      <pre className="whitespace-pre-wrap break-words py-2 font-sans text-base leading-[1.6] md:text-sm md:leading-relaxed">{showQuoted || quoted === null ? (message.text ?? '') : text!.main}</pre>
      {quoted !== null && <QuoteToggle open={showQuoted} onToggle={() => setShowQuoted((v) => !v)} />}
    </div>
  );
}
