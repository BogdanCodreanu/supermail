import { beforeEach, describe, expect, it } from 'vitest';
import { type DB, openDb } from '../src/db/index.js';
import { groupCounts, listInbox, toSummary } from '../src/threads/queries.js';

function addAccount(db: DB, id: string) {
  db.prepare('INSERT INTO accounts(id, email, color, created_at) VALUES (?, ?, ?, 1)').run(id, `${id}@x.com`, '#2563eb');
}

function addThread(
  db: DB,
  t: { account: string; gid: string; at: number; group?: string | null; inbox?: boolean; unread?: boolean; doneAt?: number },
): string {
  const id = `${t.account}:${t.gid}`;
  const group = t.group === undefined ? 'dev' : t.group;
  db.prepare(
    `INSERT INTO threads(id, account_id, gmail_thread_id, subject, snippet, from_name, from_email, last_message_at,
       unread, in_inbox, has_attachments, group_id, reason_source, reason_text, reason_at)
     VALUES (?, ?, ?, ?, 'snip', 'Sender', 'sender@x.com', ?, ?, ?, 0, ?, ?, ?, NULL)`,
  ).run(
    id, t.account, t.gid, `Subject ${t.gid}`, t.at, t.unread ? 1 : 0, t.inbox === false ? 0 : 1, group,
    group ? 'heuristic' : null, group ? `In ${group}: guess (automatic guess)` : null,
  );
  if (t.doneAt !== undefined) db.prepare('UPDATE threads SET done_at = ? WHERE id = ?').run(t.doneAt, id);
  return id;
}

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 30, 12);

describe('thread queries', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
    addAccount(db, 'a');
    addAccount(db, 'b');
  });

  it('paginates the inbox newest first with a cursor and no duplicates', () => {
    addThread(db, { account: 'a', gid: 't1', at: 1000 });
    addThread(db, { account: 'a', gid: 't2', at: 3000 });
    addThread(db, { account: 'b', gid: 't3', at: 2000 });
    addThread(db, { account: 'a', gid: 'archived', at: 5000, inbox: false });

    const first = listInbox(db, { limit: 2 });
    expect(first.threads.map((t) => t.id)).toEqual(['a:t2', 'b:t3']);
    expect(first.nextCursor).not.toBeNull();

    const second = listInbox(db, { limit: 2, cursor: first.nextCursor! });
    expect(second.threads.map((t) => t.id)).toEqual(['a:t1']);
    expect(second.nextCursor).toBeNull();
  });

  it('breaks ties on equal timestamps without skipping or repeating', () => {
    for (const gid of ['x1', 'x2', 'x3']) addThread(db, { account: 'a', gid, at: 1000 });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = listInbox(db, { limit: 1, cursor });
      seen.push(...page.threads.map((t) => t.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen.sort()).toEqual(['a:x1', 'a:x2', 'a:x3']);
  });

  it('filters by account and group', () => {
    addThread(db, { account: 'a', gid: 't1', at: 1000, group: 'dev' });
    addThread(db, { account: 'a', gid: 't2', at: 2000, group: 'news' });
    addThread(db, { account: 'b', gid: 't3', at: 3000, group: 'dev' });
    expect(listInbox(db, { groupId: 'dev' }).threads.map((t) => t.id)).toEqual(['b:t3', 'a:t1']);
    expect(listInbox(db, { accountId: 'a' }).threads.map((t) => t.id)).toEqual(['a:t2', 'a:t1']);
    expect(listInbox(db, { accountId: 'a', groupId: 'dev' }).threads.map((t) => t.id)).toEqual(['a:t1']);
  });

  it('treats a NULL group as Unsorted, including the group filter', () => {
    const id = addThread(db, { account: 'a', gid: 't1', at: 1000, group: null });
    const s = toSummary(db, id);
    expect(s.groupId).toBe('unsorted');
    expect(s.groupName).toBe('Unsorted');
    expect(s.reason).toEqual({ source: 'default', text: 'Unsorted: no confident match (automatic guess)', at: null });
    expect(listInbox(db, { groupId: 'unsorted' }).threads.map((t) => t.id)).toEqual([id]);
  });

  it('summarizes snooze, override suggestion and flags', () => {
    const id = addThread(db, { account: 'a', gid: 't1', at: 1000, unread: true });
    db.prepare('INSERT INTO snoozes(thread_id, until, created_at) VALUES (?, 9999, 1)').run(id);
    db.prepare("INSERT INTO overrides(thread_id, group_id, source, created_at, suggest_rule) VALUES (?, 'dev', 'gmail', 1, 1)").run(id);
    const s = toSummary(db, id);
    expect(s).toMatchObject({
      id,
      accountId: 'a',
      subject: 'Subject t1',
      fromName: 'Sender',
      fromEmail: 'sender@x.com',
      lastMessageAt: 1000,
      unread: true,
      inInbox: true,
      groupId: 'dev',
      groupName: 'Dev',
      snoozedUntil: 9999,
      hasAttachments: false,
      suggestRule: true,
    });
    expect(s.reason.source).toBe('heuristic');
  });

  it('toSummary throws a 404 for an unknown thread', () => {
    expect(() => toSummary(db, 'a:nope')).toThrow(expect.objectContaining({ statusCode: 404 }));
  });

  it('groupCounts returns all groups in seed order with inbox counts', () => {
    addThread(db, { account: 'a', gid: 't1', at: 1000, group: 'dev', unread: true });
    addThread(db, { account: 'b', gid: 't2', at: 1000, group: 'dev' });
    addThread(db, { account: 'a', gid: 't3', at: 1000, group: null });
    addThread(db, { account: 'a', gid: 't4', at: 1000, group: 'news', inbox: false });

    const all = groupCounts(db);
    expect(all.map((g) => g.name)).toEqual([
      'Important', 'Money & Security', 'Dev', 'Purchases', 'News', 'Low priority', 'Unsorted',
    ]);
    const byId = Object.fromEntries(all.map((g) => [g.id, g]));
    expect(byId.dev).toMatchObject({ inboxCount: 2, unreadCount: 1, kind: 'builtin', notify: true, position: 2 });
    expect(byId.unsorted!.inboxCount).toBe(1);
    expect(byId.news!.inboxCount).toBe(0);

    const onlyA = Object.fromEntries(groupCounts(db, 'a').map((g) => [g.id, g]));
    expect(onlyA.dev!.inboxCount).toBe(1);
  });

  describe('includeDone', () => {
    const page = (q: Parameters<typeof listInbox>[1] = {}) => listInbox(db, { includeDone: true, now: NOW, ...q });
    const ids = (p: { threads: { id: string }[] }) => p.threads.map((t) => t.id);

    it('adds threads done in the last 30 days to the inbox, in the same order', () => {
      addThread(db, { account: 'a', gid: 'new', at: 4000 });
      addThread(db, { account: 'a', gid: 'done', at: 3000, inbox: false, doneAt: NOW - DAY });
      addThread(db, { account: 'a', gid: 'old', at: 2000 });
      addThread(db, { account: 'a', gid: 'done-old', at: 1000, inbox: false, doneAt: NOW - 2 * DAY });
      expect(ids(page())).toEqual(['a:new', 'a:done', 'a:old', 'a:done-old']);
    });

    it('leaves out threads done more than 30 days ago, and archived mail that was never done', () => {
      addThread(db, { account: 'a', gid: 'edge', at: 3000, inbox: false, doneAt: NOW - 30 * DAY });
      addThread(db, { account: 'a', gid: 'expired', at: 2000, inbox: false, doneAt: NOW - 30 * DAY - 1 });
      addThread(db, { account: 'a', gid: 'archived', at: 1000, inbox: false });
      expect(ids(page())).toEqual(['a:edge']);
    });

    it('pages across inbox and done threads with no gaps or repeats', () => {
      for (let i = 0; i < 7; i++) addThread(db, { account: 'a', gid: `t${i}`, at: 1000, inbox: i % 2 === 0, doneAt: i % 2 === 0 ? undefined : NOW - DAY });
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const p = page({ limit: 2, cursor });
        expect(p.threads.length).toBeLessThanOrEqual(2);
        seen.push(...ids(p));
        cursor = p.nextCursor ?? undefined;
      } while (cursor);
      expect(seen).toEqual(['a:t6', 'a:t5', 'a:t4', 'a:t3', 'a:t2', 'a:t1', 'a:t0']);
    });

    it('follows the account and group filters', () => {
      addThread(db, { account: 'a', gid: 'dev', at: 3000, group: 'dev', inbox: false, doneAt: NOW - DAY });
      addThread(db, { account: 'a', gid: 'news', at: 2000, group: 'news', inbox: false, doneAt: NOW - DAY });
      addThread(db, { account: 'b', gid: 'other', at: 1000, group: 'dev', inbox: false, doneAt: NOW - DAY });
      expect(ids(page({ groupId: 'dev' }))).toEqual(['a:dev', 'b:other']);
      expect(ids(page({ accountId: 'a' }))).toEqual(['a:dev', 'a:news']);
    });

    it('sets doneAt on done threads and null on the others', () => {
      addThread(db, { account: 'a', gid: 'done', at: 2000, inbox: false, doneAt: NOW - DAY });
      addThread(db, { account: 'a', gid: 'open', at: 1000 });
      expect(page().threads.map((t) => t.doneAt)).toEqual([NOW - DAY, null]);
    });

    it('is off by default: done threads stay out of the list', () => {
      addThread(db, { account: 'a', gid: 'done', at: 2000, inbox: false, doneAt: NOW - DAY });
      addThread(db, { account: 'a', gid: 'open', at: 1000 });
      expect(ids(listInbox(db, { now: NOW }))).toEqual(['a:open']);
    });

    it('does not change the group counts', () => {
      addThread(db, { account: 'a', gid: 'open', at: 2000, group: 'dev', unread: true });
      const before = groupCounts(db);
      addThread(db, { account: 'a', gid: 'done', at: 1000, group: 'dev', inbox: false, unread: true, doneAt: NOW - DAY });
      expect(groupCounts(db)).toEqual(before);
    });
  });

  it('rejects a malformed cursor', () => {
    expect(() => listInbox(db, { cursor: 'garbage' })).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});
