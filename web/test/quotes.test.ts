import { describe, expect, it } from 'vitest';
import { previewOf, splitQuotedHtml, splitQuotedText } from '../src/lib/quotes';

describe('splitQuotedHtml', () => {
  it('removes a Gmail quote and its "On … wrote:" line', () => {
    const html =
      '<div dir="ltr">Sounds good, see you then.</div><br>' +
      '<div class="gmail_quote"><div class="gmail_attr">On Tue, 27 Oct 2026 at 10:00, Ana &lt;irina@example.com&gt; wrote:<br></div>' +
      '<blockquote class="gmail_quote">Lunch on Friday?</blockquote></div>';
    const out = splitQuotedHtml(html);
    expect(out.quoted).toBe(true);
    expect(out.main).toContain('Sounds good');
    expect(out.main).not.toContain('Lunch on Friday');
    expect(out.main).not.toContain('wrote:');
  });

  it('removes the new Gmail quote container', () => {
    const html =
      '<div>Yes.</div><div class="gmail_quote gmail_quote_container"><div class="gmail_attr">On Mon, Bob wrote:</div>' +
      '<blockquote class="gmail_quote">Can you?</blockquote></div>';
    const out = splitQuotedHtml(html);
    expect(out.quoted).toBe(true);
    expect(out.main).not.toContain('Can you?');
    expect(out.main).not.toContain('Bob wrote');
  });

  it('removes an Apple Mail cite blockquote and the attribution line before it', () => {
    const html = '<div>Done, thanks.</div><div>On 27 Oct 2026, at 10:00, Ana wrote:</div><blockquote type="cite"><div>Please sign</div></blockquote>';
    const out = splitQuotedHtml(html);
    expect(out.quoted).toBe(true);
    expect(out.main).toContain('Done, thanks.');
    expect(out.main).not.toContain('Please sign');
    expect(out.main).not.toContain('Ana wrote');
  });

  it('leaves forwarded messages alone', () => {
    const html = '<div>FYI</div><div class="gmail_quote"><div>---------- Forwarded message ---------</div><div>The original</div></div>';
    expect(splitQuotedHtml(html)).toEqual({ main: html, quoted: false });
  });

  it('does not collapse a message that is only a quote', () => {
    const html = '<blockquote type="cite">all of it</blockquote>';
    expect(splitQuotedHtml(html).quoted).toBe(false);
  });

  it('reports no quote for plain HTML', () => {
    expect(splitQuotedHtml('<p>hello</p>')).toEqual({ main: '<p>hello</p>', quoted: false });
  });
});

describe('splitQuotedText', () => {
  it('cuts at a one-line "On … wrote:"', () => {
    const out = splitQuotedText('Thanks!\n\nOn Tue, 27 Oct 2026, Ana <irina@example.com> wrote:\n> Lunch?\n> Friday');
    expect(out.main).toBe('Thanks!');
    expect(out.quoted).toContain('> Lunch?');
  });

  it('cuts at an "On …" line wrapped before "wrote:"', () => {
    const out = splitQuotedText('Ok\nOn Tue, 27 Oct 2026 at 10:00, Irina Vasile <irina@example.com>\nwrote:\n> hi');
    expect(out.main).toBe('Ok');
  });

  it('cuts a trailing block of > lines', () => {
    const out = splitQuotedText('Agreed.\n\n> earlier\n>\n> more');
    expect(out.main).toBe('Agreed.');
    expect(out.quoted).toBe('> earlier\n>\n> more');
  });

  it('keeps inline > replies that are followed by new text', () => {
    const text = '> question one\nanswer one\n> question two\nanswer two';
    expect(splitQuotedText(text)).toEqual({ main: text, quoted: null });
  });

  it('does not cut when nothing would remain', () => {
    expect(splitQuotedText('> only quoted')).toEqual({ main: '> only quoted', quoted: null });
  });
});

describe('previewOf', () => {
  it('uses the text without its quote', () => {
    expect(previewOf({ text: 'Hi  there\n\nOn Mon, X wrote:\n> old', html: null })).toBe('Hi there');
  });

  it('derives a preview from HTML when there is no text', () => {
    const html = '<style>p{color:red}</style><p>Your   order</p><p>has shipped</p><blockquote type="cite">old</blockquote>';
    expect(previewOf({ text: null, html })).toBe('Your order has shipped');
  });

  it('is empty when there is nothing', () => {
    expect(previewOf({ text: null, html: null })).toBe('');
  });
});
