import type { DB } from '../db/index.js';
import type { AppDeps } from '../http/app.js';
import { withGmail } from '../actions/actions.js';
import { snoozedLabelId, writeLabels } from '../labels/labelWriter.js';
import { publishGroups, publishThread } from '../threads/classifyThread.js';
import { HttpError } from '../errors.js';

export const SNOOZE_INTERVAL_MS = 30_000;
/** Our label-change log is kept in full this long (it lets two-way sync tell our writes from the owner's). */
const LABEL_WRITES_KEEP_MS = 30 * 24 * 3_600_000;
const PRUNE_EVERY_MS = 3_600_000;

interface DueRow { thread_id: string; account_id: string; gmail_thread_id: string }
interface WriteRow { id: number; added_json: string; removed_json: string }

/**
 * Compacts each thread's label writes older than the keep window into one row holding our newest write of
 * every label, so a label we wrote long ago is still ours (PLAUSIBLE e). The row keeps the id of the newest
 * old write, so newer writes still take precedence in `lastWriteOf`.
 */
export function pruneLabelWrites(db: DB, now: number): void {
  const cutoff = now - LABEL_WRITES_KEEP_MS;
  const threads = db.prepare(
    'SELECT account_id, gmail_thread_id FROM label_writes WHERE at < ? GROUP BY account_id, gmail_thread_id HAVING count(*) > 1',
  ).all(cutoff) as { account_id: string; gmail_thread_id: string }[];
  const rowsOf = db.prepare('SELECT id, added_json, removed_json FROM label_writes WHERE account_id = ? AND gmail_thread_id = ? AND at < ? ORDER BY id');
  const update = db.prepare('UPDATE label_writes SET added_json = ?, removed_json = ? WHERE id = ?');
  const drop = db.prepare('DELETE FROM label_writes WHERE account_id = ? AND gmail_thread_id = ? AND at < ? AND id != ?');
  db.transaction(() => {
    for (const t of threads) {
      const rows = rowsOf.all(t.account_id, t.gmail_thread_id, cutoff) as WriteRow[];
      const last = new Map<string, 'added' | 'removed'>();
      for (const r of rows) {
        for (const l of JSON.parse(r.removed_json) as string[]) last.set(l, 'removed');
        for (const l of JSON.parse(r.added_json) as string[]) last.set(l, 'added');
      }
      const keep = rows.at(-1)!.id;
      const of = (kind: 'added' | 'removed') => JSON.stringify([...last].filter(([, k]) => k === kind).map(([l]) => l));
      update.run(of('added'), of('removed'), keep);
      drop.run(t.account_id, t.gmail_thread_id, cutoff, keep);
    }
  })();
}

/**
 * Brings snoozed threads back when they are due: adds INBOX, removes SuperMail/Snoozed, deletes the row and
 * surfaces the thread at the top of the inbox (surfaced_at). `start()` runs it at once, so snoozes that fell due while the server was down
 * come back on startup. A snooze the owner already undid in Gmail has no row any more (the thread hook removes
 * it), so it is never re-archived or resurrected.
 */
export function createSnoozeScheduler(d: AppDeps, intervalMs = SNOOZE_INTERVAL_MS): { start(): void; stop(): void; runDue(): Promise<number> } {
  const { db } = d;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<number> | undefined;
  let prunedAt = -Infinity;

  async function run(): Promise<number> {
    const now = d.now();
    if (now - prunedAt >= PRUNE_EVERY_MS) {
      pruneLabelWrites(db, now);
      prunedAt = now;
    }
    const due = db.prepare(
      `SELECT s.thread_id, t.account_id, t.gmail_thread_id FROM snoozes s JOIN threads t ON t.id = s.thread_id
       JOIN accounts a ON a.id = t.account_id
       WHERE s.until <= ? AND a.status != 'reconnect_needed' ORDER BY s.until`,
    ).all(now) as DueRow[];
    const restored: string[] = [];
    for (const row of due) {
      const t = { id: row.thread_id, account_id: row.account_id, gmail_thread_id: row.gmail_thread_id };
      try {
        const snoozed = snoozedLabelId(db, row.account_id);
        await withGmail(d, t, (gmail) => writeLabels(db, gmail, row.thread_id, ['INBOX'], snoozed ? [snoozed] : [], now));
        db.transaction(() => {
          db.prepare('DELETE FROM snoozes WHERE thread_id = ?').run(row.thread_id);
          db.prepare('UPDATE threads SET in_inbox = 1, done_at = NULL, surfaced_at = ? WHERE id = ?').run(now, row.thread_id);
        })();
        restored.push(row.thread_id);
        publishThread(db, row.thread_id);
      } catch (err) {
        // A deleted thread was dropped from the index by withGmail; anything else is retried next run.
        if (!(err instanceof HttpError && err.statusCode === 404)) console.error('restoring a snoozed thread failed', row.thread_id, err);
      }
    }
    if (restored.length > 0) {
      publishGroups(db);
      d.push?.snoozeReturned(restored);
    }
    return restored.length;
  }

  const runDue = (): Promise<number> => {
    inFlight ??= run().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  return {
    runDue,
    start() {
      if (timer) return;
      void runDue().catch((err: unknown) => console.error('snooze scheduler failed', err));
      timer = setInterval(() => void runDue().catch((err: unknown) => console.error('snooze scheduler failed', err)), intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
