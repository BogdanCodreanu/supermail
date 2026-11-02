import type { gmail_v1 } from 'googleapis';
import type { ActionResult, FilterDTO, ThreadId, ThreadPage } from '@supermail/shared';
import { actionResult, setSnooze, snapshotThread, threadRow, withGmail } from '../actions/actions.js';
import { recordUndo } from '../actions/undo.js';
import type { DB } from '../db/index.js';
import { HttpError } from '../errors.js';
import { GmailAuthRevoked } from '../google/gmailApi.js';
import type { AppDeps } from '../http/app.js';
import { applyThreadLabels, snoozedLabelId, writeLabels } from '../labels/labelWriter.js';
import { updateAccountStatus } from '../sync/initialSync.js';
import { toSummary } from '../threads/queries.js';

/** How far back the "Skipped your inbox" view looks. */
export const SKIPPED_WINDOW_MS = 30 * 24 * 3_600_000;

/**
 * Mail from the last 30 days that is not in the inbox, was not Done or snoozed in SuperMail, and is not only
 * mail the owner sent: whatever a Gmail filter or Superhuman's auto-archive took out of the inbox. Newest first,
 * all of it in one page (hiding the tail would defeat the point).
 */
export function listSkipped(db: DB, now: number, accountId?: string): ThreadPage {
  const ids = db.prepare(
    `SELECT t.id FROM threads t
     WHERE t.in_inbox = 0 AND t.is_sent_only = 0 AND t.done_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM snoozes s WHERE s.thread_id = t.id)
       AND t.last_message_at >= ? ${accountId ? 'AND t.account_id = ?' : ''}
     ORDER BY t.last_message_at DESC, t.id DESC`,
  ).pluck().all(now - SKIPPED_WINDOW_MS, ...(accountId ? [accountId] : [])) as string[];
  return { threads: ids.map((id) => toSummary(db, id)), nextCursor: null };
}

/**
 * Moves a skipped thread back to the inbox: adds INBOX (and clears any snooze), surfaces it at the top, and puts
 * its group label on it now that it is in the inbox. Undo removes INBOX again.
 */
export async function restore(d: AppDeps, threadId: ThreadId): Promise<ActionResult> {
  const { db } = d;
  const t = threadRow(db, threadId);
  const before = snapshotThread(db, threadId);
  if (before.inInbox) throw new HttpError(400, 'This thread is already in the inbox');
  const now = d.now();
  const snoozed = snoozedLabelId(db, t.account_id);
  await withGmail(d, t, async (gmail) => {
    await writeLabels(db, gmail, threadId, ['INBOX'], snoozed ? [snoozed] : [], now);
    db.transaction(() => {
      setSnooze(db, threadId, null);
      db.prepare('UPDATE threads SET done_at = NULL, surfaced_at = ? WHERE id = ?').run(now, threadId);
    })();
    await applyThreadLabels(db, gmail, threadId, { now });
  });
  return actionResult(db, threadId, recordUndo(db, threadId, 'restore', before, now));
}

type Hides = FilterDTO['hides'][number];

function hidesOf(action: gmail_v1.Schema$FilterAction | undefined): Hides[] {
  const add = action?.addLabelIds ?? [];
  const remove = action?.removeLabelIds ?? [];
  const hides: Hides[] = [];
  if (remove.includes('INBOX')) hides.push('skip_inbox');
  if (add.includes('TRASH')) hides.push('trash');
  if (remove.includes('UNREAD')) hides.push('mark_read');
  return hides;
}

/** Gmail search syntax for a filter's criteria, e.g. `from:x@y subject:(Weekly deals) has:attachment`. */
function renderCriteria(c: gmail_v1.Schema$FilterCriteria | undefined): string {
  if (!c) return '';
  const term = (op: string, v: string) => `${op}:${/\s/.test(v) ? `(${v})` : v}`;
  const parts: string[] = [];
  if (c.from) parts.push(term('from', c.from));
  if (c.to) parts.push(term('to', c.to));
  if (c.subject) parts.push(term('subject', c.subject));
  if (c.query) parts.push(c.query);
  if (c.negatedQuery) parts.push(`-{${c.negatedQuery}}`);
  if (c.hasAttachment) parts.push('has:attachment');
  if (c.size) parts.push(`${c.sizeComparison === 'smaller' ? 'smaller' : 'larger'}:${c.size}`);
  return parts.join(' ');
}

/**
 * Every Gmail filter, in every connected account, that skips the inbox, trashes or marks mail read. Listed only:
 * deleting one needs the gmail.settings.basic scope, which we don't request, so the UI links to Gmail's settings.
 * An account whose token is revoked is flipped to reconnect_needed and left out.
 */
export async function listHidingFilters(d: AppDeps): Promise<FilterDTO[]> {
  const accounts = d.db.prepare("SELECT id, email FROM accounts WHERE status != 'reconnect_needed' ORDER BY created_at, id").all() as { id: string; email: string }[];
  const perAccount = await Promise.all(accounts.map(async (a): Promise<FilterDTO[]> => {
    let filters: gmail_v1.Schema$Filter[];
    try {
      filters = await d.gmailFor(a.id).listFilters();
    } catch (err) {
      if (err instanceof GmailAuthRevoked || (err instanceof Error && (err.name === 'GmailAuthRevoked' || err.name === 'TokenDecryptError'))) {
        updateAccountStatus(d.db, a.id, 'reconnect_needed');
        return [];
      }
      throw err;
    }
    const gmailSettingsUrl = `https://mail.google.com/mail/u/?authuser=${a.email}#settings/filters`;
    return filters.flatMap((f) => {
      const hides = hidesOf(f.action);
      return hides.length ? [{ accountId: a.id, filterId: f.id ?? '', criteria: renderCriteria(f.criteria), hides, gmailSettingsUrl }] : [];
    });
  }));
  return perAccount.flat();
}
