import type { MatchType, TeachPreviewDTO, TeachScopeDTO, ThreadId } from '@supermail/shared';
import { matchKeys } from '../classify/heuristics.js';
import type { DB } from '../db/index.js';
import { HttpError } from '../errors.js';
import { classifyInput } from '../threads/classifyThread.js';
import { activeThreads } from '../threads/queries.js';
import { threadsMatching } from './actions.js';

/** Everyone there is a stranger to everyone else, so nobody groups all of Gmail by accident. */
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'proton.me', 'protonmail.com']);

/** What a teaching on this thread would reach: its sender, domain and list, each with its inbox and snoozed threads. */
export function teachPreview(db: DB, threadId: ThreadId): TeachPreviewDTO {
  const t = db.prepare('SELECT subject, from_name FROM threads WHERE id = ?').get(threadId) as { subject: string; from_name: string | null } | undefined;
  if (!t) throw new HttpError(404, `thread ${threadId} not found`);
  const input = classifyInput(db, threadId);
  const keys = input ? matchKeys(input) : { sender: null, domain: null, list: null };
  const active = activeThreads(db);
  const scope = (type: MatchType, value: string | null): TeachScopeDTO | null =>
    value === null ? null : { value, count: threadsMatching(db, type, value).filter((id) => active.has(id)).length };
  return {
    subject: t.subject,
    senderName: t.from_name,
    sender: scope('sender', keys.sender),
    domain: keys.domain && FREE_MAIL.has(keys.domain) ? null : scope('domain', keys.domain),
    list: scope('list', keys.list),
  };
}
