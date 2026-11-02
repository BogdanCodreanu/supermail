import type { GroupDTO, GroupKind, ReasonSource, ThreadId, ThreadPage, ThreadSummaryDTO } from '@supermail/shared';
import type { DB } from '../db/index.js';
import { HttpError } from '../errors.js';

const UNSORTED_ID = 'unsorted';
const UNSORTED_REASON = 'Unsorted: no confident match (automatic guess)';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** How far back `includeDone` looks. */
export const DONE_WINDOW_MS = 30 * 24 * 3_600_000;

interface SummaryRow {
  id: string;
  account_id: string;
  subject: string;
  snippet: string;
  from_name: string | null;
  from_email: string | null;
  last_message_at: number;
  surfaced_at: number | null;
  unread: number;
  in_inbox: number;
  has_attachments: number;
  group_id: string | null;
  group_name: string | null;
  reason_source: string | null;
  reason_text: string | null;
  reason_at: number | null;
  snoozed_until: number | null;
  suggest_rule: number | null;
  done_at: number | null;
  list_id: string | null;
}

/** The inbox order: the newest message, or later if the thread was surfaced (a due snooze, a restore). */
const SORT_KEY = 'MAX(t.last_message_at, IFNULL(t.surfaced_at, 0))';

// A thread whose group_id is NULL (never classified, or its group was deleted) is shown as Unsorted.
const SUMMARY_SELECT = `
  SELECT t.id, t.account_id, t.subject, t.snippet, t.from_name, t.from_email, t.last_message_at, t.surfaced_at,
         t.unread, t.in_inbox, t.has_attachments, g.id AS group_id, g.name AS group_name,
         t.reason_source, t.reason_text, t.reason_at, s.until AS snoozed_until, o.suggest_rule, t.done_at,
         (SELECT m.list_id FROM messages m WHERE m.thread_id = t.id AND m.list_id IS NOT NULL ORDER BY m.date DESC LIMIT 1) AS list_id
  FROM threads t
  LEFT JOIN groups g ON g.id = t.group_id
  LEFT JOIN snoozes s ON s.thread_id = t.id
  LEFT JOIN overrides o ON o.thread_id = t.id`;

function unsortedName(db: DB): string {
  return (db.prepare('SELECT name FROM groups WHERE id = ?').pluck().get(UNSORTED_ID) as string | undefined) ?? 'Unsorted';
}

function toDTO(r: SummaryRow, unsorted: () => string): ThreadSummaryDTO {
  const grouped = r.group_id !== null;
  return {
    id: r.id,
    accountId: r.account_id,
    subject: r.subject,
    snippet: r.snippet,
    fromName: r.from_name,
    fromEmail: r.from_email,
    lastMessageAt: r.last_message_at,
    unread: r.unread === 1,
    inInbox: r.in_inbox === 1,
    groupId: r.group_id ?? UNSORTED_ID,
    groupName: r.group_name ?? unsorted(),
    reason: grouped
      ? {
          source: (r.reason_source as ReasonSource | null) ?? 'default',
          text: r.reason_text ?? `In ${r.group_name}`,
          at: r.reason_at,
        }
      : { source: 'default', text: UNSORTED_REASON, at: null },
    snoozedUntil: r.snoozed_until,
    hasAttachments: r.has_attachments === 1,
    suggestRule: r.suggest_rule === 1,
    doneAt: r.done_at,
    listId: r.list_id,
  };
}

function lazyUnsortedName(db: DB): () => string {
  let name: string | undefined;
  return () => (name ??= unsortedName(db));
}

export function toSummary(db: DB, threadId: ThreadId): ThreadSummaryDTO {
  const row = db.prepare(`${SUMMARY_SELECT} WHERE t.id = ?`).get(threadId) as SummaryRow | undefined;
  if (!row) throw new HttpError(404, `thread ${threadId} not found`);
  return toDTO(row, lazyUnsortedName(db));
}

/** Threads teaching still acts on in Gmail: in the inbox or snoozed. Archived threads are left as they are. */
export function activeThreads(db: DB): Set<ThreadId> {
  return new Set(db.prepare('SELECT id FROM threads WHERE in_inbox = 1 UNION SELECT thread_id FROM snoozes').pluck().all() as ThreadId[]);
}

function parseCursor(cursor: string): { at: number; id: string } {
  const sep = cursor.indexOf(':');
  const at = Number(cursor.slice(0, sep));
  const id = cursor.slice(sep + 1);
  if (sep <= 0 || !Number.isSafeInteger(at) || !id) throw new HttpError(400, 'invalid cursor');
  return { at, id };
}

/**
 * Inbox threads newest first by SORT_KEY; the cursor is `${sortKey}:${id}`. `includeDone` mixes in the threads
 * done since `now` minus 30 days, in the same order.
 */
export function listInbox(db: DB, q: { accountId?: string; groupId?: string; cursor?: string; limit?: number; includeDone?: boolean; now?: number }): ThreadPage {
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const where = [q.includeDone ? '(t.in_inbox = 1 OR t.done_at >= ?)' : 't.in_inbox = 1'];
  const params: (string | number)[] = q.includeDone ? [(q.now ?? Date.now()) - DONE_WINDOW_MS] : [];
  if (q.accountId) {
    where.push('t.account_id = ?');
    params.push(q.accountId);
  }
  if (q.groupId) {
    where.push(`COALESCE(g.id, '${UNSORTED_ID}') = ?`);
    params.push(q.groupId);
  }
  if (q.cursor) {
    const c = parseCursor(q.cursor);
    where.push(`(${SORT_KEY} < ? OR (${SORT_KEY} = ? AND t.id < ?))`);
    params.push(c.at, c.at, c.id);
  }
  const rows = db
    .prepare(`${SUMMARY_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${SORT_KEY} DESC, t.id DESC LIMIT ?`)
    .all(...params, limit + 1) as SummaryRow[];
  const page = rows.slice(0, limit);
  const unsorted = lazyUnsortedName(db);
  const last = page.at(-1);
  return {
    threads: page.map((r) => toDTO(r, unsorted)),
    nextCursor: rows.length > limit && last ? `${Math.max(last.last_message_at, last.surfaced_at ?? 0)}:${last.id}` : null,
  };
}

interface GroupRow {
  id: string;
  name: string;
  position: number;
  color: string;
  notify: number;
  kind: GroupKind;
  inbox_count: number;
  unread_count: number;
}

export function groupCounts(db: DB, accountId?: string): GroupDTO[] {
  const accountFilter = accountId ? 'AND t.account_id = ?' : '';
  const rows = db
    .prepare(
      `WITH counts AS (
         SELECT COALESCE(g.id, '${UNSORTED_ID}') AS gid, count(*) AS inbox_count, sum(t.unread) AS unread_count
         FROM threads t LEFT JOIN groups g ON g.id = t.group_id
         WHERE t.in_inbox = 1 ${accountFilter}
         GROUP BY gid
       )
       SELECT g.id, g.name, g.position, g.color, g.notify, g.kind,
              COALESCE(c.inbox_count, 0) AS inbox_count, COALESCE(c.unread_count, 0) AS unread_count
       FROM groups g LEFT JOIN counts c ON c.gid = g.id
       ORDER BY g.position, g.name`,
    )
    .all(...(accountId ? [accountId] : [])) as GroupRow[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    position: r.position,
    color: r.color,
    notify: r.notify === 1,
    kind: r.kind,
    inboxCount: r.inbox_count,
    unreadCount: r.unread_count,
  }));
}
