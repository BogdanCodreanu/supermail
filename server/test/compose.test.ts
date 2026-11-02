import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_HEADER, type SendRequest } from '@supermail/shared';
import type { AppConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db/index.js';
import { ALLOW_ALL, type AppDeps, buildApp, NOOP_HOOK } from '../src/http/app.js';
import { mailRoutes } from '../src/http/routes/mail.js';
import { buildRaw, send } from '../src/mail/compose.js';
import { indexThread } from '../src/sync/indexer.js';
import { createFakeGmail, type FakeGmail, type FakeThread } from './fakes/fakeGmail.js';
import { HOUR } from './fixtures/threads.js';

const NOW = Date.UTC(2026, 9, 29, 10, 0, 0);
const OWN = new Set(['me@gmail.com', 'work@gmail.com']);

const config: AppConfig = {
  port: 8787,
  host: '127.0.0.1',
  dataDir: '/tmp/unused',
  publicUrl: 'http://localhost:8787',
  ownerEmail: 'me@gmail.com',
  googleClientFile: '/nonexistent/client_secret.json',
  pollSeconds: 30,
  limits: { bodyCacheMB: 1024, indexMB: 1024, logsMB: 50, totalMB: 3072, minFreeDiskGB: 20 },
  secureCookies: false,
};

/** Splits a raw MIME message into unfolded headers and body. */
function decode(raw: string): { header: (name: string) => string | undefined; headers: string; body: string } {
  const mime = Buffer.from(raw, 'base64url').toString('utf8');
  const sep = mime.search(/\r?\n\r?\n/);
  const headers = mime.slice(0, sep).replace(/\r?\n[ \t]+/g, ' ');
  return {
    headers,
    body: mime.slice(sep).trim(),
    header: (name) => new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(headers)?.[1]?.trim(),
  };
}

const base: SendRequest = { accountId: 'a', to: ['ana@friends.ro'], cc: [], bcc: [], subject: 'Hello', text: 'Hi Ana' };

describe('buildRaw', () => {
  const from = { name: null, email: 'me@gmail.com' };
  const reply = { rfc822MessageId: '<a@x>', references: '<root@x>', subject: 'Hello', quotedText: '> original line' };

  it('threads a reply: In-Reply-To, References and a single Re:', async () => {
    const m = decode(await buildRaw({ ...base, subject: 'Hello' }, from, reply));
    expect(m.header('In-Reply-To')).toBe('<a@x>');
    expect(m.header('References')).toBe('<root@x> <a@x>');
    expect(m.header('Subject')).toBe('Re: Hello');
    expect(m.header('From')).toBe('me@gmail.com');
    expect(m.body).toContain('Hi Ana');
    expect(m.body).toContain('> original line');
  });

  it('never produces Re: Re:', async () => {
    for (const [subject, original] of [['Re: Hello', 'Hello'], ['Re: Hello', 'Re: Hello'], ['', 'RE: Hello'], ['re: Hello', 'Hello']]) {
      const m = decode(await buildRaw({ ...base, subject: subject! }, from, { ...reply, subject: original! }));
      expect(m.header('Subject')).toMatch(/^re: Hello$/i);
      expect(m.headers).not.toMatch(/Re: Re:/i);
    }
  });

  it('starts References with the parent id when the parent has none', async () => {
    const m = decode(await buildRaw(base, from, { ...reply, references: null }));
    expect(m.header('References')).toBe('<a@x>');
  });

  it('forwards with Fwd: once and the quoted original', async () => {
    const m = decode(await buildRaw({ ...base, forward: true, subject: '' }, from, { ...reply, quotedText: '---------- Forwarded message ---------\nbody' }));
    expect(m.header('Subject')).toBe('Fwd: Hello');
    expect(m.body).toContain('---------- Forwarded message ---------');
    const again = decode(await buildRaw({ ...base, forward: true, subject: 'Fwd: Hello' }, from, reply));
    expect(again.header('Subject')).toBe('Fwd: Hello');
  });

  it('keeps Bcc so Gmail can deliver to it, and sets Cc', async () => {
    const m = decode(await buildRaw({ ...base, cc: ['c@x.com'], bcc: ['hidden@x.com'] }, from));
    expect(m.header('Cc')).toBe('c@x.com');
    expect(m.header('Bcc')).toBe('hidden@x.com');
    expect(m.header('In-Reply-To')).toBeUndefined();
  });
});

describe('send', () => {
  let db: DB;
  let a: FakeGmail;
  let b: FakeGmail;
  let deps: AppDeps;
  let changes: [string, string][];
  let app: FastifyInstance | undefined;

  async function addIndexed(g: FakeGmail, accountId: string, t: FakeThread): Promise<string> {
    g.addThread(t);
    return indexThread(db, accountId, await g.getThread(t.id, 'metadata'), OWN, undefined, 'sync');
  }

  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare("INSERT INTO accounts(id, email, color, status, created_at) VALUES ('a', 'me@gmail.com', '#2563eb', 'ok', 1)").run();
    db.prepare("INSERT INTO accounts(id, email, color, status, created_at) VALUES ('b', 'work@gmail.com', '#16a34a', 'ok', 2)").run();
    a = createFakeGmail('me@gmail.com', { now: () => NOW });
    b = createFakeGmail('work@gmail.com', { now: () => NOW });
    changes = [];
    deps = {
      db,
      config,
      gmailFor: (id) => (id === 'a' ? a : b),
      now: () => NOW,
      onThreadChange: (id, reason) => changes.push([id, reason]),
      storage: ALLOW_ALL,
    };
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const helloThread: FakeThread = {
    id: 't-hello',
    messages: [{ from: 'Ana <ana@friends.ro>', to: 'work@gmail.com', subject: 'Hello', date: NOW - HOUR, messageId: '<a@x>', text: 'Are you free?\nLet me know.' }],
  };

  it('replies in the Gmail thread, from the account that received it', async () => {
    const threadId = await addIndexed(b, 'b', helloThread);
    const res = await send(deps, { ...base, accountId: 'a', subject: 'Re: Hello', text: 'Yes!', replyToThreadId: threadId });

    expect(res).toEqual({ threadId: 'b:t-hello' });
    expect(a.calls.sendRaw).toHaveLength(0);
    expect(b.calls.sendRaw).toHaveLength(1);
    const m = decode(b.calls.sendRaw[0]!);
    expect(m.header('From')).toBe('work@gmail.com');
    expect(m.header('In-Reply-To')).toBe('<a@x>');
    expect(m.header('References')).toContain('<a@x>');
    expect(m.header('Subject')).toBe('Re: Hello');
    expect(m.body).toContain('Yes!');
    expect(m.body).toMatch(/wrote:/);
    expect(m.body).toContain('> Are you free?');
    expect(m.body).toContain('> Let me know.');
    // the fake files the message into the Gmail thread only when sendRaw got its id
    await expect(b.getThread('t-hello', 'metadata')).resolves.toMatchObject({ messages: [{}, {}] });
  });

  it('reindexes the thread after sending, as a change rather than new mail', async () => {
    const threadId = await addIndexed(b, 'b', helloThread);
    await send(deps, { ...base, accountId: 'b', text: 'Yes!', replyToThreadId: threadId });
    expect(db.prepare('SELECT count(*) FROM messages WHERE thread_id = ?').pluck().get(threadId)).toBe(2);
    expect(changes).toEqual([[threadId, 'changed']]);
  });

  it('replies to a specific message when replyToMessageId is given', async () => {
    const threadId = await addIndexed(b, 'b', {
      id: 't-two',
      messages: [
        { id: 'm-first', from: 'Ana <ana@friends.ro>', subject: 'Hello', date: NOW - 2 * HOUR, messageId: '<first@x>' },
        { id: 'm-second', from: 'Bob <bob@friends.ro>', subject: 'Re: Hello', date: NOW - HOUR, messageId: '<second@x>', references: '<first@x>' },
      ],
    });
    await send(deps, { ...base, accountId: 'b', replyToThreadId: threadId, replyToMessageId: 'b:m-first' });
    expect(decode(b.calls.sendRaw[0]!).header('In-Reply-To')).toBe('<first@x>');

    await send(deps, { ...base, accountId: 'b', replyToThreadId: threadId, replyToMessageId: 'm-first' });
    expect(decode(b.calls.sendRaw[1]!).header('In-Reply-To')).toBe('<first@x>');

    // default: the latest message not sent by the owner (the two replies above are the owner's)
    await send(deps, { ...base, accountId: 'b', replyToThreadId: threadId });
    const m = decode(b.calls.sendRaw[2]!);
    expect(m.header('In-Reply-To')).toBe('<second@x>');
    expect(m.header('References')).toBe('<first@x> <second@x>');
  });

  it('forwards with the original quoted', async () => {
    const threadId = await addIndexed(b, 'b', helloThread);
    await send(deps, { ...base, accountId: 'b', to: ['boss@corp.com'], subject: '', text: 'FYI', replyToThreadId: threadId, forward: true });
    const m = decode(b.calls.sendRaw[0]!);
    expect(m.header('Subject')).toBe('Fwd: Hello');
    expect(m.header('To')).toBe('boss@corp.com');
    expect(m.body).toContain('---------- Forwarded message ---------');
    expect(m.body).toContain('From: Ana <ana@friends.ro>');
    expect(m.body).toContain('Are you free?');
  });

  it('a new message starts a new thread in the chosen account', async () => {
    const res = await send(deps, { ...base, accountId: 'a' });
    expect(a.calls.sendRaw).toHaveLength(1);
    expect(res.threadId).toMatch(/^a:/);
    expect(db.prepare('SELECT is_sent_only, in_inbox FROM threads WHERE id = ?').get(res.threadId)).toEqual({ is_sent_only: 1, in_inbox: 0 });
  });

  it('rejects bad requests with 400 and unknown accounts or threads with 404', async () => {
    await expect(send(deps, { ...base, to: [] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(send(deps, { ...base, to: ['ana@friends.ro\r\nBcc: spy@evil.example'] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(send(deps, { ...base, to: ['not-an-address'] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(send(deps, { ...base, subject: 'Hi\r\nBcc: spy@evil.example' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(send(deps, { ...base, accountId: 'zzz' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(send(deps, { ...base, replyToThreadId: 'a:missing' })).rejects.toMatchObject({ statusCode: 404 });
    expect(a.calls.sendRaw).toHaveLength(0);
  });

  it('POST /api/send returns the thread id', async () => {
    app = await buildApp(deps, [mailRoutes], { webDir: '/nonexistent' });
    const res = await app.inject({ method: 'POST', url: '/api/send', headers: { [API_HEADER]: '1' }, payload: { ...base, accountId: 'a' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ threadId: expect.stringMatching(/^a:/) });

    const bad = await app.inject({ method: 'POST', url: '/api/send', headers: { [API_HEADER]: '1' }, payload: { accountId: 'a', to: 'x' } });
    expect(bad.statusCode).toBe(400);
  });
});
