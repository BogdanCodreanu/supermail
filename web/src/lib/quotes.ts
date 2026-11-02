import type { MessageDTO } from '@supermail/shared';

// Quoted history (the earlier messages a reply carries along) is folded away behind a toggle, like Gmail.
// Parsing happens in an inert DOMParser document: nothing in it runs or loads.

/** Containers mail clients wrap a quote in (Gmail, Apple Mail and most others, Yahoo). */
const QUOTE_SELECTORS = ['.gmail_quote_container', '.gmail_quote', 'blockquote[type="cite"]', '.yahoo_quoted'];
const FORWARD = /(-{3,}\s*Forwarded message|Begin forwarded message)/i;
const ATTRIBUTION = /\bwrote:\s*$/i;

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function hasContent(el: Element): boolean {
  return (el.textContent ?? '').trim() !== '' || el.querySelector('img') !== null;
}

/** The HTML without its trailing quoted history. A forward, or a message that is all quote, is left whole. */
export function splitQuotedHtml(html: string): { main: string; quoted: boolean } {
  const doc = parse(html);
  const quotes = doc.body.querySelectorAll(QUOTE_SELECTORS.join(','));
  let removed = false;
  for (const q of quotes) {
    if (!q.isConnected || FORWARD.test(q.textContent ?? '')) continue;
    // "On Tue, 27 Oct 2026, Ana wrote:" just before the quote goes with it.
    const prev = q.previousElementSibling;
    if (prev && ATTRIBUTION.test(prev.textContent ?? '') && (prev.textContent ?? '').length < 300) prev.remove();
    q.remove();
    removed = true;
  }
  // Outlook marks the start of the quoted reply with this header; everything after it is history.
  const outlook = doc.getElementById('divRplyFwdMsg');
  if (outlook && !FORWARD.test(outlook.textContent ?? '')) {
    let n: ChildNode | null = outlook;
    while (n) {
      const next: ChildNode | null = n.nextSibling;
      n.remove();
      n = next;
    }
    removed = true;
  }
  if (!removed || !hasContent(doc.body)) return { main: html, quoted: false };
  return { main: doc.body.innerHTML, quoted: true };
}

/** Plain text split at "On … wrote:" or at a trailing block of `>` lines. */
export function splitQuotedText(text: string): { main: string; quoted: string | null } {
  const lines = text.split(/\r?\n/);
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const next = (lines[i + 1] ?? '').trim();
    if (/^On\b/i.test(line) && (ATTRIBUTION.test(line) || /^wrote:$/i.test(next) || (next !== '' && ATTRIBUTION.test(next) && line.length < 200))) {
      cut = i;
      break;
    }
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(line)) {
      cut = i;
      break;
    }
    if (line.startsWith('>') && lines.slice(i).every((l) => l.trim() === '' || l.trim().startsWith('>'))) {
      cut = i;
      break;
    }
  }
  if (cut === -1) return { main: text, quoted: null };
  const main = lines.slice(0, cut).join('\n').trimEnd();
  if (main.trim() === '') return { main: text, quoted: null };
  return { main, quoted: lines.slice(cut).join('\n') };
}

const BLOCKS = 'p,div,br,li,tr,td,th,h1,h2,h3,h4,h5,h6,table,blockquote,section,article,header,footer';

/** Visible text of an HTML body: no style or script text, and blocks separated by spaces. */
export function htmlToText(html: string): string {
  const doc = parse(html);
  doc.querySelectorAll('style,script,head,title').forEach((el) => el.remove());
  doc.body.querySelectorAll(BLOCKS).forEach((el) => el.after(doc.createTextNode(' ')));
  return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** One line for a collapsed message: its new text, without the quote, from the text part or else the HTML. */
export function previewOf(m: Pick<MessageDTO, 'html' | 'text'>, max = 200): string {
  let s = '';
  if (m.text?.trim()) s = splitQuotedText(m.text).main.replace(/\s+/g, ' ').trim();
  else if (m.html) s = htmlToText(splitQuotedHtml(m.html).main);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
