import type { gmail_v1 } from 'googleapis';
import { describe, expect, it } from 'vitest';
import { parseAddress, parseAddressList, parseMessage } from '../src/google/parse.js';

function msg(headers: Record<string, string>, extra: Partial<gmail_v1.Schema$Message> = {}): gmail_v1.Schema$Message {
  return {
    id: 'm1',
    threadId: 't1',
    labelIds: ['INBOX', 'UNREAD'],
    snippet: 'Hello &amp; welcome',
    internalDate: '1761735600000',
    sizeEstimate: 1234,
    ...extra,
    payload: { mimeType: 'text/plain', headers: Object.entries(headers).map(([name, value]) => ({ name, value })), ...extra.payload },
  };
}

describe('parseAddress', () => {
  it.each([
    ['"Bolt" <receipts@bolt.eu>', { name: 'Bolt', email: 'receipts@bolt.eu' }],
    ['Bolt <receipts@bolt.eu>', { name: 'Bolt', email: 'receipts@bolt.eu' }],
    ['receipts@bolt.eu', { name: null, email: 'receipts@bolt.eu' }],
    ['<Receipts@Bolt.EU>', { name: null, email: 'receipts@bolt.eu' }],
    ['"Doe, Jane" <jane@x.com>', { name: 'Doe, Jane', email: 'jane@x.com' }],
    ['=?UTF-8?B?TGlicsSDcmlhIENldMSDyJtpaQ==?= <noreply@librariacetatii.example>', { name: 'Librăria Cetății', email: 'noreply@librariacetatii.example' }],
  ])('parses %s', (input, expected) => {
    expect(parseAddress(input)).toEqual(expected);
  });

  it('splits address lists on commas outside quotes', () => {
    expect(parseAddressList('"Doe, Jane" <jane@x.com>, bob@y.com')).toEqual([
      { name: 'Doe, Jane', email: 'jane@x.com' },
      { name: null, email: 'bob@y.com' },
    ]);
    expect(parseAddressList(undefined)).toEqual([]);
  });
});

describe('parseMessage', () => {
  it('extracts the From name and email', () => {
    const p = parseMessage(msg({ From: '"Bolt" <receipts@bolt.eu>', Subject: 'Your Bolt Scooter ride' }));
    expect(p.from).toEqual({ name: 'Bolt', email: 'receipts@bolt.eu' });
    expect(p.subject).toBe('Your Bolt Scooter ride');
    expect(p.gmailMessageId).toBe('m1');
    expect(p.gmailThreadId).toBe('t1');
    expect(p.labelIds).toEqual(['INBOX', 'UNREAD']);
    expect(p.sizeEstimate).toBe(1234);
    expect(p.snippet).toBe('Hello & welcome');
  });

  it('lowercases List-Id and strips angle brackets', () => {
    expect(parseMessage(msg({ From: 'a@b.c', 'List-Id': 'Ground News <daily.ground.news>' })).listId).toBe('daily.ground.news');
    expect(parseMessage(msg({ From: 'a@b.c', 'List-Id': '<Super-Mail.Owner.GitHub.com>' })).listId).toBe('super-mail.owner.github.com');
    expect(parseMessage(msg({ From: 'a@b.c' })).listId).toBeNull();
  });

  it('parses the Date header to epoch ms', () => {
    const p = parseMessage(msg({ From: 'a@b.c', Date: 'Tue, 28 Oct 2026 10:15:00 +0200 (EET)' }));
    expect(p.date).toBe(Date.UTC(2026, 9, 28, 8, 15, 0));
  });

  it('falls back to internalDate when the Date header is missing or invalid', () => {
    expect(parseMessage(msg({ From: 'a@b.c', Date: 'not a date' })).date).toBe(1761735600000);
    expect(parseMessage(msg({ From: 'a@b.c' })).date).toBe(1761735600000);
  });

  it('reads To, Cc, List-Unsubscribe, Message-ID and References', () => {
    const p = parseMessage(msg({
      From: 'a@b.c',
      To: 'Me <me@gmail.com>, other@x.com',
      Cc: 'cc@x.com',
      'List-Unsubscribe': '<mailto:u@x.com>',
      'Message-ID': '<abc@x.com>',
      References: '<r1@x.com> <r2@x.com>',
    }));
    expect(p.to).toEqual([{ name: 'Me', email: 'me@gmail.com' }, { name: null, email: 'other@x.com' }]);
    expect(p.cc).toEqual([{ name: null, email: 'cc@x.com' }]);
    expect(p.hasListUnsubscribe).toBe(true);
    expect(p.rfc822MessageId).toBe('<abc@x.com>');
    expect(p.references).toBe('<r1@x.com> <r2@x.com>');
  });

  it('uses In-Reply-To as references when References is missing', () => {
    expect(parseMessage(msg({ From: 'a@b.c', 'In-Reply-To': '<p@x.com>' })).references).toBe('<p@x.com>');
  });

  it('sets hasAttachments when any part has a filename', () => {
    const withFile = msg({ From: 'a@b.c' }, {
      payload: {
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'multipart/alternative', filename: '', parts: [{ mimeType: 'text/plain', filename: '' }] },
          { mimeType: 'application/pdf', filename: 'receipt.pdf', body: { attachmentId: 'a1', size: 10 } },
        ],
      },
    });
    expect(parseMessage(withFile).hasAttachments).toBe(true);
    const noFile = msg({ From: 'a@b.c' }, { payload: { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', filename: '' }] } });
    expect(parseMessage(noFile).hasAttachments).toBe(false);
  });

  it('treats a metadata-format multipart/mixed message as having attachments', () => {
    expect(parseMessage(msg({ From: 'a@b.c' }, { payload: { mimeType: 'multipart/mixed' } })).hasAttachments).toBe(true);
  });
});
