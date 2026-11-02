// @vitest-environment node
import type { ActionResult, BulkResult, GroupDTO, PushDeviceDTO, PushKeyDTO, PushTestResult, ServerEvent, TeachingDTO, TeachPreviewDTO, ThreadDetailDTO, ThreadPage } from '@supermail/shared';
import { describe, expect, it } from 'vitest';
import { ACC_ME, ACC_OPS } from '../mock/fixtures';
import { createMockApi, type MockApi } from '../mock/handler';

const NOW = Date.UTC(2026, 9, 29, 12, 0);
const fresh = () => createMockApi({ now: () => NOW });

function get<T>(api: MockApi, url: string): T {
  const res = api.handle({ method: 'GET', url });
  expect(res.status, `GET ${url}: ${String(res.body)}`).toBe(200);
  return JSON.parse(res.body as string) as T;
}

function post<T>(api: MockApi, url: string, body?: unknown): T {
  const res = api.handle({ method: 'POST', url, headers: { 'x-supermail': '1' }, body });
  expect(res.status, `POST ${url}: ${String(res.body)}`).toBe(200);
  return JSON.parse(res.body as string) as T;
}

const enc = encodeURIComponent;

describe('push', () => {
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'p', auth: 'a' }, userAgent: 'Chrome' };

  it('gives a key a browser accepts: an uncompressed P-256 point', () => {
    const { publicKey } = get<PushKeyDTO>(fresh(), '/api/push/key');
    const bytes = Buffer.from(publicKey, 'base64url');
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(4);
  });

  it('keeps devices, tests one by handing the notification back, and forgets it on unsubscribe', () => {
    const api = fresh();
    expect(post(api, '/api/push/subscribe', sub)).toEqual({ ok: true });
    post(api, '/api/push/subscribe', sub);
    expect(get<PushDeviceDTO[]>(api, '/api/push/devices')).toHaveLength(1);
    expect(post<PushTestResult>(api, '/api/push/test', { endpoint: sub.endpoint })).toMatchObject({ ok: true, preview: { title: 'SuperMail' } });
    expect(get<PushDeviceDTO[]>(api, '/api/push/devices')[0]!.lastOkAt).toBe(NOW);
    expect(api.handle({ method: 'DELETE', url: '/api/push/subscribe', headers: { 'x-supermail': '1' }, body: { endpoint: sub.endpoint } }).status).toBe(200);
    expect(get<PushDeviceDTO[]>(api, '/api/push/devices')).toEqual([]);
  });

  it('says a removed device is removed when it checks in, until the owner turns it on there', () => {
    const api = fresh();
    post(api, '/api/push/subscribe', sub);
    const [device] = get<PushDeviceDTO[]>(api, '/api/push/devices');
    expect(api.handle({ method: 'DELETE', url: `/api/push/devices/${device!.id}`, headers: { 'x-supermail': '1' } }).status).toBe(200);
    expect(post(api, '/api/push/subscribe', { ...sub, refresh: true })).toEqual({ ok: true, removed: true });
    expect(post(api, '/api/push/subscribe', sub)).toEqual({ ok: true });
  });

  it('needs the header and a real subscription, as the server does', () => {
    const api = fresh();
    expect(api.handle({ method: 'POST', url: '/api/push/subscribe', body: sub }).status).toBe(403);
    expect(api.handle({ method: 'POST', url: '/api/push/subscribe', headers: { 'x-supermail': '1' }, body: { endpoint: 'nope' } }).status).toBe(400);
    expect(api.handle({ method: 'POST', url: '/api/push/test', headers: { 'x-supermail': '1' }, body: { endpoint: 'https://unknown' } }).status).toBe(404);
  });
});

describe('spam', () => {
  const INBOX_ID = (api: MockApi) => api.world.threads.find((t) => t.inInbox)!.id;

  it('lists about 6 fixtures from both accounts, newest first, labelled as spam', () => {
    const page = get<ThreadPage>(fresh(), '/api/spam');
    expect(page.threads.length).toBeGreaterThanOrEqual(5);
    expect(new Set(page.threads.map((t) => t.accountId))).toEqual(new Set([ACC_ME, ACC_OPS]));
    const dates = page.threads.map((t) => t.lastMessageAt);
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
    expect(page.threads.every((t) => t.groupName === 'Spam' && t.reason.text === 'In Gmail spam' && !t.inInbox)).toBe(true);
  });

  it('spam is not in the inbox, Show done, search or skipped', () => {
    const api = fresh();
    const subject = get<ThreadPage>(api, '/api/spam').threads[0]!.subject;
    expect(get<ThreadPage>(api, `/api/search?q=${enc(subject)}`).threads).toEqual([]);
    expect(get<ThreadPage>(api, '/api/threads?limit=200&includeDone=1').threads.some((t) => t.subject === subject)).toBe(false);
  });

  it('reads one, with a remote image and an attachment to prove the reader is safe', () => {
    const api = fresh();
    const { threads } = get<ThreadPage>(api, '/api/spam');
    const details = threads.map((t) => get<ThreadDetailDTO>(api, `/api/spam/${enc(t.id)}`));
    expect(details.some((d) => d.messages.some((m) => /<img[^>]+src="https?:/.test(m.html ?? '')))).toBe(true);
    expect(details.some((d) => d.messages.some((m) => m.attachments.length > 0))).toBe(true);
  });

  it('is 404 for a thread out of spam', () => {
    const api = fresh();
    expect(api.handle({ method: 'GET', url: `/api/spam/${enc(INBOX_ID(api))}` }).status).toBe(404);
  });

  it('report moves a thread to spam, sends thread.removed, and undo puts it back as it was', () => {
    const api = fresh();
    const id = INBOX_ID(api);
    const events: ServerEvent[] = [];
    api.subscribe((e) => events.push(e));
    const before = get<ThreadDetailDTO>(api, `/api/threads/${enc(id)}`).thread;

    const res = post<ActionResult>(api, `/api/threads/${enc(id)}/spam`);
    expect(res.thread).toBeNull();
    expect(events).toContainEqual({ type: 'thread.removed', id });
    expect(api.handle({ method: 'GET', url: `/api/threads/${enc(id)}` }).status).toBe(404);
    expect(get<ThreadPage>(api, '/api/spam').threads.map((t) => t.id)).toContain(id);

    const back = post<ActionResult>(api, `/api/undo/${res.undoId}`);
    expect(back.thread).toEqual(before);
    expect(get<ThreadPage>(api, '/api/spam').threads.map((t) => t.id)).not.toContain(id);

    const again = post<ActionResult>(api, `/api/undo/${back.undoId}`);
    expect(again.thread).toBeNull();
    expect(get<ThreadPage>(api, '/api/spam').threads.map((t) => t.id)).toContain(id);
  });

  it('Not spam moves it to the top of the inbox, and undo moves it back', () => {
    const api = fresh();
    const { id } = get<ThreadPage>(api, '/api/spam').threads.at(-1)!;
    const res = post<ActionResult>(api, `/api/spam/${enc(id)}/not-spam`);
    expect(res.thread).toMatchObject({ id, inInbox: true, groupId: 'unsorted' });
    expect(res.thread!.groupName).toBe('Unsorted');
    expect(get<ThreadPage>(api, '/api/threads?limit=1').threads[0]!.id).toBe(id);
    expect(get<ThreadPage>(api, '/api/spam').threads.map((t) => t.id)).not.toContain(id);

    expect(post<ActionResult>(api, `/api/undo/${res.undoId}`).thread).toBeNull();
    expect(get<ThreadPage>(api, '/api/spam').threads.map((t) => t.id)).toContain(id);
    expect(api.handle({ method: 'GET', url: `/api/threads/${enc(id)}` }).status).toBe(404);
  });

  it('writes need the header', () => {
    const api = fresh();
    expect(api.handle({ method: 'POST', url: `/api/threads/${enc(INBOX_ID(api))}/spam` }).status).toBe(403);
  });
});

describe('mock API fixtures', () => {
  it('has two accounts, the 7 groups and about 60 threads, with snoozed and skipped mail', () => {
    const api = fresh();
    const accounts = get<{ email: string; color: string }[]>(api, '/api/accounts');
    expect(accounts.map((a) => a.email)).toEqual(['you@example.com', 'work@example.com']);
    const groups = get<GroupDTO[]>(api, '/api/groups');
    expect(groups.map((g) => g.name)).toEqual(['Important', 'Money & Security', 'Dev', 'Purchases', 'News', 'Low priority', 'Unsorted']);
    expect(groups.every((g) => g.inboxCount > 0)).toBe(true);
    expect(api.world.threads.length).toBeGreaterThanOrEqual(55);
    expect(api.world.threads.filter((t) => t.snoozedUntil !== null)).toHaveLength(3);
    const skipped = get<ThreadPage>(api, '/api/skipped');
    expect(skipped.threads).toHaveLength(5);
    expect(skipped.threads.map((t) => t.subject)).toContain('Informare incident de securitate');
  });

  it('computes group counts from the inbox, per account when asked', () => {
    const api = fresh();
    const inbox = api.world.threads.filter((t) => t.inInbox);
    const all = get<GroupDTO[]>(api, '/api/groups');
    expect(all.reduce((n, g) => n + g.inboxCount, 0)).toBe(inbox.length);
    expect(all.reduce((n, g) => n + g.unreadCount, 0)).toBe(inbox.filter((t) => t.unread).length);
    const ops = get<GroupDTO[]>(api, `/api/groups?accountId=${ACC_OPS}`);
    expect(ops.reduce((n, g) => n + g.inboxCount, 0)).toBe(inbox.filter((t) => t.accountId === ACC_OPS).length);
  });
});

describe('GET /api/threads', () => {
  it('pages newest first with a cursor, without gaps or repeats', () => {
    const api = fresh();
    const total = api.world.threads.filter((t) => t.inInbox).length;
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: ThreadPage = get<ThreadPage>(api, `/api/threads?limit=20${cursor ? `&cursor=${enc(cursor)}` : ''}`);
      seen.push(...page.threads.map((t) => t.id));
      expect(page.threads.length).toBeLessThanOrEqual(20);
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(Math.ceil(total / 20));
    expect(new Set(seen).size).toBe(total);
    const dates = seen.map((id) => api.world.threads.find((t) => t.id === id)!.lastMessageAt);
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
  });

  it('defaults to 50 per page and rejects a bad cursor', () => {
    const api = fresh();
    expect(get<ThreadPage>(api, '/api/threads').threads).toHaveLength(50);
    expect(api.handle({ method: 'GET', url: '/api/threads?cursor=nope' }).status).toBe(400);
  });

  it('filters by account and group', () => {
    const api = fresh();
    const dev = get<ThreadPage>(api, '/api/threads?groupId=dev&limit=200').threads;
    expect(dev.length).toBeGreaterThan(0);
    expect(dev.every((t) => t.groupId === 'dev' && t.groupName === 'Dev' && t.inInbox)).toBe(true);
    const mine = get<ThreadPage>(api, `/api/threads?accountId=${ACC_ME}&limit=200`).threads;
    expect(mine.every((t) => t.accountId === ACC_ME)).toBe(true);
    const both = get<ThreadPage>(api, `/api/threads?accountId=${ACC_OPS}&groupId=money_security&limit=200`).threads;
    expect(both.length).toBeGreaterThan(0);
    expect(both.every((t) => t.accountId === ACC_OPS && t.groupId === 'money_security')).toBe(true);
    expect(both.map((t) => t.fromName)).toContain('Contabil Exemplu');
  });
});

describe('actions', () => {
  it('done removes the thread from the inbox and undo brings it back, with live events', () => {
    const api = fresh();
    const events: ServerEvent[] = [];
    api.subscribe((e) => events.push(e));
    const first = get<ThreadPage>(api, '/api/threads?groupId=important').threads[0]!;
    const before = get<GroupDTO[]>(api, '/api/groups').find((g) => g.id === 'important')!.inboxCount;

    const done = post<ActionResult>(api, `/api/threads/${enc(first.id)}/done`);
    expect(done.thread?.inInbox).toBe(false);
    expect(get<ThreadPage>(api, '/api/threads?groupId=important').threads.map((t) => t.id)).not.toContain(first.id);
    expect(get<GroupDTO[]>(api, '/api/groups').find((g) => g.id === 'important')!.inboxCount).toBe(before - 1);
    expect(events.map((e) => e.type)).toEqual(['thread.updated', 'groups.updated']);

    const undone = post<ActionResult>(api, `/api/undo/${done.undoId}`);
    expect(undone.thread?.inInbox).toBe(true);
    expect(undone.undoId).not.toBe(done.undoId);
    expect(get<ThreadPage>(api, '/api/threads?groupId=important').threads[0]!.id).toBe(first.id);
    expect(get<GroupDTO[]>(api, '/api/groups').find((g) => g.id === 'important')!.inboxCount).toBe(before);
    expect(api.handle({ method: 'POST', url: `/api/undo/${done.undoId}`, headers: { 'x-supermail': '1' } }).status).toBe(404);
  });

  describe('includeDone', () => {
    const DAY = 86_400_000;
    const list = (a: MockApi, q = '') => get<ThreadPage>(a, `/api/threads?limit=200${q}`).threads;

    it('adds threads done in the last 30 days, in inbox order; the default leaves them out', () => {
      const api = fresh();
      const inbox = list(api);
      expect(inbox.every((t) => t.inInbox)).toBe(true);
      const mixed = list(api, '&includeDone=1');
      const done = mixed.filter((t) => !t.inInbox);
      expect(done.length).toBeGreaterThan(0);
      expect(done.every((t) => t.doneAt! >= NOW - 30 * DAY)).toBe(true);
      expect(mixed.filter((t) => t.inInbox).map((t) => t.id)).toEqual(inbox.map((t) => t.id));
      const expired = api.world.threads.filter((t) => t.doneAt !== null && t.doneAt < NOW - 30 * DAY);
      expect(expired.length).toBeGreaterThan(0);
      expect(mixed.map((t) => t.id)).not.toContain(expired[0]!.id);
    });

    it('pages across the mix with no gaps or repeats, and leaves group counts alone', () => {
      const api = fresh();
      const all = list(api, '&includeDone=1').map((t) => t.id);
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: ThreadPage = get(api, `/api/threads?includeDone=1&limit=7${cursor ? `&cursor=${enc(cursor)}` : ''}`);
        seen.push(...page.threads.map((t) => t.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual(all);
      const inboxTotal = api.world.threads.filter((t) => t.inInbox).length;
      expect(get<GroupDTO[]>(api, '/api/groups').reduce((n, g) => n + g.inboxCount, 0)).toBe(inboxTotal);
    });

    it('restore moves a done thread back to the inbox and clears doneAt; undo marks it done again', () => {
      const api = fresh();
      const t = list(api, '&includeDone=1').find((x) => !x.inInbox)!;
      const moved = post<ActionResult>(api, `/api/skipped/${enc(t.id)}/restore`);
      expect(moved.thread).toMatchObject({ inInbox: true, doneAt: null });
      const undone = post<ActionResult>(api, `/api/undo/${moved.undoId}`);
      expect(undone.thread).toMatchObject({ inInbox: false, doneAt: t.doneAt });
    });
  });

  it('requires the x-supermail header on writes', () => {
    const api = fresh();
    const id = api.world.threads[0]!.id;
    expect(api.handle({ method: 'POST', url: `/api/threads/${enc(id)}/done` }).status).toBe(403);
  });

  it('snoozes only into the future and unsnoozes to the top', () => {
    const api = fresh();
    const t = get<ThreadPage>(api, '/api/threads').threads[10]!;
    expect(api.handle({ method: 'POST', url: `/api/threads/${enc(t.id)}/snooze`, headers: { 'x-supermail': '1' }, body: { until: NOW } }).status).toBe(400);
    const s = post<ActionResult>(api, `/api/threads/${enc(t.id)}/snooze`, { until: NOW + 3_600_000 });
    expect(s.thread).toMatchObject({ inInbox: false, snoozedUntil: NOW + 3_600_000 });
    post<ActionResult>(api, `/api/threads/${enc(t.id)}/unsnooze`);
    expect(get<ThreadPage>(api, '/api/threads').threads[0]!.id).toBe(t.id);
  });

  it('moves, marks read and teaches with a reason, and teaching undoes for every thread it touched', () => {
    const api = fresh();
    const bolt = api.world.threads.filter((t) => t.fromEmail === 'receipts@bolt.eu');
    const moved = post<ActionResult>(api, `/api/threads/${enc(bolt[0]!.id)}/move`, { groupId: 'money_security' });
    expect(moved.thread).toMatchObject({ groupId: 'money_security', reason: { source: 'override', text: 'In Money & Security because you said so on 29 Oct' } });
    expect(post<ActionResult>(api, `/api/threads/${enc(bolt[0]!.id)}/read`, { read: true }).thread?.unread).toBe(false);

    const taught = post<ActionResult>(api, '/api/teach', { threadId: bolt[1]!.id, action: 'not_important', scope: 'sender' });
    expect(taught.thread?.groupId).toBe('low_priority');
    expect(api.world.threads.filter((t) => t.fromEmail === 'receipts@bolt.eu').every((t) => t.groupId === 'low_priority')).toBe(true);
    post<ActionResult>(api, `/api/undo/${taught.undoId}`);
    expect(api.world.threads.find((t) => t.id === bolt[0]!.id)!.groupId).toBe('money_security');
    expect(api.world.threads.find((t) => t.id === bolt[1]!.id)!.groupId).toBe('purchases');
  });

  it('reports how many threads changed group', () => {
    const api = fresh();
    const bolt = api.world.threads.filter((t) => t.fromEmail === 'receipts@bolt.eu');
    const taught = post<ActionResult>(api, '/api/teach', { threadId: bolt[0]!.id, action: 'always_group', scope: 'sender', groupId: 'dev' });
    expect(taught.affected).toBe(bolt.length);
    expect(post<ActionResult>(api, '/api/teach', { threadId: bolt[0]!.id, action: 'always_group', scope: 'sender', groupId: 'dev' }).affected).toBe(0);
    expect(post<ActionResult>(api, `/api/threads/${enc(bolt[0]!.id)}/move`, { groupId: 'news' }).affected).toBe(1);
  });

  it('the latest teaching replaces the opposite kind on the same match, and undo puts it back', () => {
    const api = fresh();
    const bolt = api.world.threads.find((t) => t.fromEmail === 'receipts@bolt.eu')!;
    const kinds = () => get<TeachingDTO[]>(api, '/api/teaching').filter((e) => e.matchValue === 'receipts@bolt.eu').map((e) => e.kind);
    post<ActionResult>(api, '/api/teach', { threadId: bolt.id, action: 'always_group', scope: 'sender', groupId: 'dev' });
    expect(kinds()).toEqual(['rule']);
    const marked = post<ActionResult>(api, '/api/teach', { threadId: bolt.id, action: 'important', scope: 'sender' });
    expect(kinds()).toEqual(['mark']);
    post<ActionResult>(api, `/api/undo/${marked.undoId}`);
    expect(kinds()).toEqual(['rule']);
    expect(api.world.threads.find((t) => t.id === bolt.id)!.groupId).toBe('dev');
  });

  it('previews what a teaching would reach, with inbox and snoozed counts', () => {
    const api = fresh();
    const bolt = api.world.threads.find((t) => t.fromEmail === 'receipts@bolt.eu' && t.inInbox)!;
    const active = api.world.threads.filter((t) => t.fromEmail === 'receipts@bolt.eu' && (t.inInbox || t.snoozedUntil !== null));
    const p = get<TeachPreviewDTO>(api, `/api/teach/preview?threadId=${enc(bolt.id)}`);
    expect(p).toMatchObject({ subject: bolt.subject, senderName: bolt.fromName, sender: { value: 'receipts@bolt.eu', count: active.length }, domain: { value: 'bolt.eu' }, list: null });
  });

  it('offers no domain for free mail, and the list when there is one', () => {
    const api = fresh();
    const free = api.world.threads.find((t) => t.fromEmail?.endsWith('@gmail.com') && !t.listId)!;
    expect(get<TeachPreviewDTO>(api, `/api/teach/preview?threadId=${enc(free.id)}`).domain).toBeNull();
    const listed = api.world.threads.find((t) => t.listId)!;
    expect(get<TeachPreviewDTO>(api, `/api/teach/preview?threadId=${enc(listed.id)}`).list?.value).toBe(listed.listId);
    expect(get<ThreadDetailDTO>(api, `/api/threads/${enc(listed.id)}`).thread.listId).toBe(listed.listId);
  });

  it('restores a skipped thread to the inbox', () => {
    const api = fresh();
    const s = get<ThreadPage>(api, '/api/skipped').threads[0]!;
    post<ActionResult>(api, `/api/skipped/${enc(s.id)}/restore`);
    expect(get<ThreadPage>(api, '/api/skipped').threads.map((t) => t.id)).not.toContain(s.id);
    expect(get<ThreadPage>(api, '/api/threads').threads[0]!.id).toBe(s.id);
  });

  it('send adds the reply to the thread', () => {
    const api = fresh();
    const t = api.world.threads.find((x) => x.subject === 'Weekend la Brașov?')!;
    const count = t.messages.length;
    const r = post<{ threadId: string }>(api, '/api/send', { accountId: ACC_ME, to: ['sam_carter@gmail.com'], cc: [], bcc: [], subject: 'Re: Weekend la Brașov?', text: 'Super, ne vedem vineri!', replyToThreadId: t.id });
    expect(r.threadId).toBe(t.id);
    const detail = get<ThreadDetailDTO>(api, `/api/threads/${enc(t.id)}`);
    expect(detail.messages).toHaveLength(count + 1);
    expect(detail.messages.at(-1)).toMatchObject({ text: 'Super, ne vedem vineri!', from: { email: 'you@example.com' } });
    expect(detail.thread.snippet).toBe('Super, ne vedem vineri!');
  });
});

describe('reading', () => {
  it('has a multi-message thread with Gmail quoted replies and a wide newsletter', () => {
    const api = fresh();
    const t = api.world.threads.find((x) => x.subject === 'Weekend la Brașov?')!;
    const detail = get<ThreadDetailDTO>(api, `/api/threads/${enc(t.id)}`);
    expect(detail.messages.length).toBeGreaterThanOrEqual(3);
    expect(detail.messages.at(-1)!.html).toContain('class="gmail_quote"');
    expect(detail.thread.snippet).not.toContain('wrote:');
    const news = api.world.threads.find((x) => x.fromName === 'Școala de Weekend' && x.messages[0]!.html?.includes('width="700"'));
    expect(news?.messages[0]!.html).toMatch(/src="data:image\/svg\+xml;base64,/);
    expect(news?.messages[0]!.html).not.toMatch(/src="https?:/);
  });

  it('searches subjects, senders and bodies', () => {
    const api = fresh();
    expect(get<ThreadPage>(api, '/api/search?q=bolt').threads.length).toBeGreaterThanOrEqual(4);
    expect(get<ThreadPage>(api, '/api/search?q=lightmap').threads.length).toBeGreaterThan(0);
    expect(api.handle({ method: 'GET', url: '/api/search?q=' }).status).toBe(400);
  });

  it('serves real PDF and PNG bytes for attachments', () => {
    const api = fresh();
    const t = api.world.threads.find((x) => x.fromName === 'Contabil Exemplu' && x.messages[0]!.attachments.length === 2)!;
    const m = t.messages[0]!;
    const [pdf, png] = m.attachments;
    const url = (a: typeof pdf) => `/api/attachments/${t.accountId}/${m.gmailMessageId}/${a!.attachmentId}`;
    const r1 = api.handle({ method: 'GET', url: url(pdf) });
    expect(r1.headers['content-type']).toBe('application/pdf');
    expect(r1.headers['content-disposition']).toMatch(/^inline;/);
    expect(new TextDecoder().decode((r1.body as Uint8Array).subarray(0, 5))).toBe('%PDF-');
    expect((r1.body as Uint8Array).length).toBe(pdf!.size);
    const r2 = api.handle({ method: 'GET', url: `${url(png)}?download=1` });
    expect(r2.headers['content-type']).toBe('image/png');
    expect(r2.headers['content-disposition']).toMatch(/^attachment;/);
    expect([...(r2.body as Uint8Array).subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });
});

describe('live mail', () => {
  it('tick delivers a new unread thread at the top and announces it', () => {
    const api = fresh();
    const events: ServerEvent[] = [];
    api.subscribe((e) => events.push(e));
    const t = api.tick();
    expect(t).toMatchObject({ unread: true, inInbox: true });
    expect(events[0]).toEqual({ type: 'thread.updated', thread: t });
    expect(get<ThreadPage>(api, '/api/threads').threads[0]!.id).toBe(t.id);
  });
});

describe('mock teaching routes', () => {
  const remove = (api: MockApi, kind: string, id: string) => api.handle({ method: 'DELETE', url: `/api/teaching/${kind}/${id}`, headers: { 'x-supermail': '1' } });
  const list = (api: MockApi) => get<TeachingDTO[]>(api, '/api/teaching');

  it('starts with rules and marks, newest first, each counting inbox and snoozed threads only', () => {
    const api = fresh();
    const rows = list(api);
    expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(['rule', 'mark']));
    expect([...rows].sort((a, b) => b.createdAt - a.createdAt)).toEqual(rows);
    const alibaba = rows.find((r) => r.matchValue === 'service.alibaba.com')!;
    const matching = api.world.threads.filter((t) => t.fromEmail?.endsWith('@service.alibaba.com'));
    expect(alibaba).toMatchObject({ kind: 'mark', matchType: 'domain', mark: 'not_important', groupId: null, groupName: null });
    expect(alibaba.threadCount).toBe(matching.filter((t) => t.inInbox || t.snoozedUntil !== null).length);
    expect(rows.find((r) => r.kind === 'rule')).toMatchObject({ groupName: expect.any(String), mark: null });
  });

  it('seeds only teachings that the fixtures really follow', () => {
    const api = fresh();
    for (const r of list(api)) {
      const group = r.groupId ?? (r.mark === 'important' ? 'important' : 'low_priority');
      const key = (t: (typeof api.world.threads)[number]) => (r.matchType === 'list' ? t.listId : r.matchType === 'sender' ? t.fromEmail : t.fromEmail?.split('@')[1]);
      const hits = api.world.threads.filter((t) => (t.inInbox || t.snoozedUntil !== null) && key(t) === r.matchValue);
      expect(hits.length, r.matchValue).toBeGreaterThan(0);
      expect(hits.some((t) => t.groupId === group), r.matchValue).toBe(true);
    }
  });

  it('teaching adds a row, undo takes it away again, and redo brings it back', () => {
    const api = fresh();
    const bolt = api.world.threads.find((t) => t.fromEmail === 'receipts@bolt.eu')!;
    const before = list(api).length;
    const taught = post<ActionResult>(api, '/api/teach', { threadId: bolt.id, action: 'always_group', scope: 'sender', groupId: 'news' });
    expect(list(api)[0]).toMatchObject({ kind: 'rule', matchType: 'sender', matchValue: 'receipts@bolt.eu', groupId: 'news', groupName: 'News' });
    const undone = post<ActionResult>(api, `/api/undo/${taught.undoId}`);
    expect(list(api)).toHaveLength(before);
    post<ActionResult>(api, `/api/undo/${undone.undoId}`);
    expect(list(api)).toHaveLength(before + 1);
  });

  it('deleting puts matching inbox threads back, leaves archived ones, and takes the row away', () => {
    const api = fresh();
    const bolt = api.world.threads.filter((t) => t.fromEmail === 'receipts@bolt.eu');
    const [one, archived] = bolt;
    const guess = { groupId: one!.groupId, reason: one!.reason };
    archived!.inInbox = false;
    post<ActionResult>(api, '/api/teach', { threadId: one!.id, action: 'always_group', scope: 'sender', groupId: 'news' });
    const rule = list(api)[0]!;
    const seen: ServerEvent[] = [];
    api.subscribe((e) => seen.push(e));

    expect(remove(api, 'rule', rule.id).status).toBe(200);

    expect(list(api).some((r) => r.id === rule.id)).toBe(false);
    expect(one).toMatchObject(guess);
    expect(archived!.groupId).toBe('news');
    expect(seen.map((e) => e.type)).toContain('groups.updated');
  });

  it('falls back to the next teaching before the guess', () => {
    const api = fresh();
    const t = api.world.threads.find((x) => x.fromEmail === 'receipts@bolt.eu')!;
    post<ActionResult>(api, '/api/teach', { threadId: t.id, action: 'important', scope: 'domain' });
    post<ActionResult>(api, '/api/teach', { threadId: t.id, action: 'always_group', scope: 'sender', groupId: 'news' });
    remove(api, 'rule', list(api).find((r) => r.matchValue === 'receipts@bolt.eu')!.id);
    expect(t).toMatchObject({ groupId: 'important', reason: { source: 'mark' } });
  });

  it('is 404 for an unknown id or kind, and writes need the header', () => {
    const api = fresh();
    expect(remove(api, 'rule', 'nope').status).toBe(404);
    expect(remove(api, 'nonsense', list(api)[0]!.id).status).toBe(404);
    expect(api.handle({ method: 'DELETE', url: '/api/teaching/rule/x' }).status).toBe(403);
  });
});

describe('bulk actions', () => {
  const inbox = (api: MockApi) => get<ThreadPage>(api, '/api/threads?limit=200').threads.map((t) => t.id);
  const first = (api: MockApi, n: number) => inbox(api).slice(0, n);
  const bulk = (api: MockApi, body: unknown) => post<BulkResult>(api, '/api/threads/bulk', body);

  it('done, then one undo restores them all, and the undo of that redoes it', () => {
    const api = fresh();
    const ids = first(api, 5);
    const before = inbox(api);
    const res = bulk(api, { ids, action: 'done' });
    expect(res).toMatchObject({ affected: 5, failed: [] });
    expect(inbox(api)).not.toContain(ids[0]);
    const undone = post<ActionResult>(api, `/api/undo/${res.undoId}`);
    expect(undone).toMatchObject({ thread: null, affected: 5 });
    expect(inbox(api)).toEqual(before);
    post<ActionResult>(api, `/api/undo/${undone.undoId}`);
    expect(inbox(api)).not.toContain(ids[4]);
  });

  it('snooze, read, unread and move change every thread', () => {
    const api = fresh();
    const ids = first(api, 3);
    const find = (id: string) => get<ThreadDetailDTO>(api, `/api/threads/${enc(id)}`).thread;
    bulk(api, { ids, action: 'read' });
    expect(find(ids[0]!).unread).toBe(false);
    bulk(api, { ids, action: 'unread' });
    expect(find(ids[1]!).unread).toBe(true);
    bulk(api, { ids, action: 'move', groupId: 'dev' });
    expect(find(ids[2]!)).toMatchObject({ groupId: 'dev', reason: { source: 'override' } });
    bulk(api, { ids, action: 'snooze', until: NOW + 3_600_000 });
    expect(find(ids[0]!)).toMatchObject({ inInbox: false, snoozedUntil: NOW + 3_600_000 });
  });

  it('spam moves them all to spam, and one undo brings them all back', () => {
    const api = fresh();
    const ids = first(api, 3);
    const spam = get<ThreadPage>(api, '/api/spam').threads.length;
    const res = bulk(api, { ids, action: 'spam' });
    expect(get<ThreadPage>(api, '/api/spam').threads).toHaveLength(spam + 3);
    post<ActionResult>(api, `/api/undo/${res.undoId}`);
    expect(get<ThreadPage>(api, '/api/spam').threads).toHaveLength(spam);
    expect(inbox(api)).toEqual(expect.arrayContaining(ids));
  });

  it('reports ids it does not have, and refuses what the server refuses', () => {
    const api = fresh();
    const ids = first(api, 1);
    expect(bulk(api, { ids: [...ids, 'nope'], action: 'done' })).toMatchObject({ affected: 1, failed: ['nope'] });
    const status = (body: unknown) => api.handle({ method: 'POST', url: '/api/threads/bulk', headers: { 'x-supermail': '1' }, body }).status;
    expect(status({ ids: Array.from({ length: 1001 }, (_, i) => `x${i}`), action: 'done' })).toBe(400);
    expect(status({ ids: [], action: 'done' })).toBe(400);
    expect(status({ ids, action: 'explode' })).toBe(400);
    expect(status({ ids, action: 'snooze', until: NOW })).toBe(400);
    expect(status({ ids, action: 'move', groupId: 'nope' })).toBe(400);
    expect(api.handle({ method: 'POST', url: '/api/threads/bulk', body: { ids, action: 'done' } }).status).toBe(403);
  });

  it('publishes every thread, then says it settled', () => {
    const api = fresh();
    const seen: ServerEvent[] = [];
    api.subscribe((e) => seen.push(e));
    const res = bulk(api, { ids: first(api, 2), action: 'done' });
    expect(seen.filter((e) => e.type === 'thread.updated')).toHaveLength(2);
    expect(seen.at(-1)).toEqual({ type: 'bulk.settled', undoId: res.undoId, affected: 2, failed: [], skipped: [] });
  });

  it('can refuse writes as Gmail would: those threads come back and are left out of the undo', () => {
    const api = fresh();
    const seen: ServerEvent[] = [];
    api.subscribe((e) => seen.push(e));
    const ids = first(api, 5);
    post(api, '/api/mock/refuse-writes', { count: 2 });
    const res = bulk(api, { ids, action: 'done' });
    expect(seen.at(-1)).toEqual({ type: 'bulk.settled', undoId: res.undoId, affected: 3, failed: ids.slice(0, 2), skipped: [] });
    expect(inbox(api)).toEqual(expect.arrayContaining(ids.slice(0, 2)));
    expect(inbox(api)).not.toContain(ids[2]);
    expect(post<ActionResult>(api, `/api/undo/${res.undoId}`).affected).toBe(3);
    expect(inbox(api)).toEqual(expect.arrayContaining(ids));
  });

  it('can deliver a big mailbox at once, for trying a big selection', () => {
    const api = fresh();
    const before = api.world.threads.length;
    post(api, '/api/mock/deliver', { count: 300 });
    expect(api.world.threads).toHaveLength(before + 300);
  });

  it('teaches each unique sender once, under one undo', () => {
    const api = fresh();
    const bolt = api.world.threads.filter((t) => t.fromEmail?.includes('bolt'));
    const other = api.world.threads.find((t) => t.fromEmail && !t.fromEmail.includes('bolt'))!;
    const before = get<TeachingDTO[]>(api, '/api/teaching').length;
    const res = post<BulkResult>(api, '/api/teach/bulk', { ids: [bolt[0]!.id, bolt[1]!.id, other.id], action: 'always_group', groupId: 'dev' });
    expect(res.failed).toEqual([]);
    expect(get<TeachingDTO[]>(api, '/api/teaching').length).toBeLessThanOrEqual(before + 2);
    expect(get<ThreadDetailDTO>(api, `/api/threads/${enc(bolt[2]!.id)}`).thread.groupId).toBe('dev');
    post<ActionResult>(api, `/api/undo/${res.undoId}`);
    expect(get<ThreadDetailDTO>(api, `/api/threads/${enc(bolt[2]!.id)}`).thread.groupId).not.toBe('dev');
  });

  it('refuses more than 50 senders', () => {
    const api = fresh();
    const res = api.handle({ method: 'POST', url: '/api/teach/bulk', headers: { 'x-supermail': '1' }, body: { ids: Array.from({ length: 51 }, (_, i) => `x${i}`), action: 'important' } });
    expect(res.status).toBe(200); // unknown ids are not senders
    api.world.threads = Array.from({ length: 51 }, (_, i) => ({ ...api.world.threads[0]!, id: `a:${i}`, fromEmail: `p${i}@x.com` }));
    const many = api.handle({ method: 'POST', url: '/api/teach/bulk', headers: { 'x-supermail': '1' }, body: { ids: api.world.threads.map((t) => t.id), action: 'important' } });
    expect(many.status).toBe(400);
  });
});
