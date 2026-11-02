import { accountLabels, type PushPayload, type ThreadId } from '@supermail/shared';
import webpush from 'web-push';
import type { DB } from '../db/index.js';
import { bus } from '../events.js';
import { ownEmailsOf } from '../sync/indexer.js';
import type { VapidKeys } from './keys.js';

// Web Push for new mail. Everything here runs behind the poller, never in it: the poller hands over thread ids and goes
// on, the sends wait in a bounded queue, and a push service that fails or hangs costs a log line. Payloads are encrypted
// for the device by the protocol, so the push service sees none of them, and the VAPID subject is the app's public URL.
//
// A notification clears itself. notified_threads holds what may be on a screen, and any change to any thread leads to a
// sweep that compares those rows with the threads, so no action needs to know about push: Done, read, snooze, spam,
// Gmail-side changes and thread deletion all end the same way. See the head of migration 005 for how a deletion is kept.

export const MAX_INDIVIDUAL = 5;
const CONCURRENCY = 4;
const SEND_TIMEOUT_MS = 10_000;
const MAIL_TTL_S = 86_400;
const NOTIFIED_KEEP_MS = 3 * 86_400_000;
/** Close enough to the action to feel immediate, long enough to catch all of a bulk action in one push. */
const SWEEP_DELAY_MS = 500;
const ORIGIN_KEEP_MS = 60_000;
/** Each id is about 32 bytes in the JSON, against a limit of about 4 KB. */
const CLEAR_CHUNK = 100;
const MAX_QUEUE = 1000;
const TITLE_CHARS = 80;
const BODY_CHARS = 300;
const LABEL_CHARS = 40;
const GONE = new Set([404, 410]);

export interface PushTarget { endpoint: string; keys: { p256dh: string; auth: string } }
export interface SendOptions { ttl: number; urgency: 'high' | 'normal'; timeoutMs: number }
/** Rejects on failure, with `statusCode` when the push service answered. */
export type PushSender = (target: PushTarget, payload: string, options: SendOptions) => Promise<unknown>;
interface Log { warn(obj: unknown, msg?: string): void; error(obj: unknown, msg?: string): void }

export interface PushService {
  publicKey: string;
  /** The threads one poll of one account found new mail in, already classified. */
  newMail(accountId: string, threadIds: ThreadId[]): void;
  /** The threads the snooze scheduler just brought back. */
  snoozeReturned(threadIds: ThreadId[]): void;
  /** Asks for a look at what was notified, soon. */
  sweep(): void;
  /** Names the device an action came from: it closed its own notification, and a clear would show as a silent push. */
  handledOn(threadId: ThreadId, endpoint: string): void;
  /** Sends a test to one device. Null when it is not a subscribed device, else whether the push service took it. */
  test(endpoint: string): Promise<boolean | null>;
  /** Runs any sweep due now and waits for every send, for tests. */
  idle(): Promise<void>;
  stop(): void;
}

export interface PushDeps { db: DB; publicKey: string; sender: PushSender; now: () => number; log: Log; timeoutMs?: number }

/** Sends through the `web-push` package. Nothing but the URL identifies the app to the push service. */
export function webPushSender(keys: VapidKeys, publicUrl: string): PushSender {
  return (target, payload, { ttl, urgency, timeoutMs }) => webpush.sendNotification(target, payload, { TTL: ttl, urgency, timeout: timeoutMs, vapidDetails: { subject: publicUrl, ...keys } });
}

interface SubRow { id: string; endpoint: string; p256dh: string; auth: string }
interface Job { sub: SubRow; payload: string; ttl: number; urgency: 'high' | 'normal' }
interface ThreadRow { id: string; account_id: string; subject: string; snippet: string; from_name: string | null; from_email: string | null; last_message_at: number; unread: number; group_name: string | null; notify: number | null }

const clip = (s: string, chars: number): string => [...s].slice(0, chars).join('');
const senderOf = (t: ThreadRow) => t.from_name || t.from_email || 'Unknown sender';

export function createPushService(deps: PushDeps): PushService {
  const { db, sender, now, log, publicKey } = deps;
  const timeoutMs = deps.timeoutMs ?? SEND_TIMEOUT_MS;
  const queue: Job[] = [];
  const active = new Set<Promise<void>>();
  /** Subscriptions whose failure is already in the log, until one of their sends works. */
  const failing = new Set<string>();
  const origins = new Map<ThreadId, { endpoint: string; at: number }>();
  let sweepTimer: NodeJS.Timeout | undefined;
  let queueFull = false;

  const subscriptions = () => db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE removed_at IS NULL').all() as SubRow[];

  function withTimeout(sub: SubRow, job: Job): Promise<unknown> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('push timed out')), timeoutMs);
    });
    const target = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
    return Promise.race([Promise.resolve().then(() => sender(target, job.payload, { ttl: job.ttl, urgency: job.urgency, timeoutMs })), timeout]).finally(() => clearTimeout(timer));
  }

  /** One send. Whatever happens stays in here: true when the push service took it. */
  async function deliver(job: Job): Promise<boolean> {
    const { sub } = job;
    try {
      await withTimeout(sub, job);
      db.prepare('UPDATE push_subscriptions SET last_ok_at = ? WHERE id = ?').run(now(), sub.id);
      failing.delete(sub.id);
      return true;
    } catch (err) {
      const { statusCode } = err as { statusCode?: number };
      if (statusCode !== undefined && GONE.has(statusCode)) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
        failing.delete(sub.id);
      } else if (!failing.has(sub.id)) {
        failing.add(sub.id);
        log.warn({ subscription: sub.id, statusCode, err: (err as Error).message }, 'a push failed');
      }
      return false;
    }
  }

  function pump(): void {
    while (active.size < CONCURRENCY && queue.length > 0) {
      const running: Promise<void> = deliver(queue.shift()!)
        .catch((err: unknown) => log.error({ err }, 'a push failed'))
        .then(() => {
          active.delete(running);
          pump();
        });
      active.add(running);
    }
  }

  function enqueue(message: PushPayload, to: SubRow[], ttl: number, urgency: Job['urgency']): void {
    const payload = JSON.stringify(message);
    for (const sub of to) {
      // Only a push service down for long gets here, and the oldest news is the least worth keeping.
      if (queue.length >= MAX_QUEUE) {
        queue.shift();
        if (!queueFull) log.warn({}, 'the push queue is full, dropping the oldest');
        queueFull = true;
      }
      queue.push({ sub, payload, ttl, urgency });
    }
    pump();
  }

  function threadRow(id: ThreadId): ThreadRow | undefined {
    return db.prepare(
      `SELECT t.id, t.account_id, t.subject, t.snippet, t.from_name, t.from_email, t.last_message_at, t.unread, g.name AS group_name, g.notify
       FROM threads t LEFT JOIN groups g ON g.id = t.group_id
       WHERE t.id = ? AND t.in_inbox = 1 AND NOT EXISTS(SELECT 1 FROM snoozes s WHERE s.thread_id = t.id)`,
    ).get(id) as ThreadRow | undefined;
  }

  function newestIsOwn(id: ThreadId, own: Set<string>): boolean {
    const m = db.prepare('SELECT from_email, label_ids_json FROM messages WHERE thread_id = ? ORDER BY date DESC, rowid DESC LIMIT 1').get(id) as { from_email: string | null; label_ids_json: string } | undefined;
    return !!m && (own.has((m.from_email ?? '').toLowerCase()) || (JSON.parse(m.label_ids_json) as string[]).includes('SENT'));
  }

  const labelsOf = () => accountLabels(db.prepare('SELECT id, email FROM accounts').all() as { id: string; email: string }[]);

  /** The newest few one by one, the rest in one summary with the count, and a record of what may be on a screen. */
  function announce(accountId: string, threads: ThreadRow[], to: SubRow[], text: (t: ThreadRow) => { title: string; body: string }, summary: (n: number) => string): void {
    const label = clip(labelsOf().get(accountId) ?? '', LABEL_CHARS);
    const shown = [...threads].sort((a, b) => b.last_message_at - a.last_message_at).slice(0, MAX_INDIVIDUAL);
    const at = now();
    db.transaction(() => {
      for (const t of shown) {
        db.prepare('INSERT INTO notified_threads(thread_id, notified_at, clear_on_read) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET notified_at = excluded.notified_at, clear_on_read = excluded.clear_on_read').run(t.id, at, t.unread);
        db.prepare('DELETE FROM push_clears WHERE thread_id = ?').run(t.id);
      }
    })();
    for (const t of shown) {
      const { title, body } = text(t);
      enqueue({ type: 'mail', threadId: t.id, title: clip(title, TITLE_CHARS), body: clip(body, BODY_CHARS), accountLabel: label, group: clip(t.group_name ?? '', LABEL_CHARS), sentAt: t.last_message_at }, to, MAIL_TTL_S, 'high');
    }
    if (threads.length > MAX_INDIVIDUAL) enqueue({ type: 'summary', tag: `summary:${accountId}`, title: summary(threads.length), body: label }, to, MAIL_TTL_S, 'high');
  }

  /** Never lets a database error reach the poller or the scheduler. */
  function guarded(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      log.error({ err }, `${what} failed`);
    }
  }

  function sweepNow(): void {
    const at = now();
    const ids = db.transaction(() => {
      // A pruned row owes nothing, so what the trigger just recorded for it goes too.
      const pruned = db.prepare('DELETE FROM notified_threads WHERE notified_at < ? RETURNING thread_id').pluck().all(at - NOTIFIED_KEEP_MS) as string[];
      for (const id of pruned) db.prepare('DELETE FROM push_clears WHERE thread_id = ?').run(id);
      db.prepare(
        `DELETE FROM notified_threads WHERE thread_id IN (
           SELECT n.thread_id FROM notified_threads n JOIN threads t ON t.id = n.thread_id
           WHERE t.in_inbox = 0 OR (n.clear_on_read = 1 AND t.unread = 0) OR EXISTS(SELECT 1 FROM snoozes s WHERE s.thread_id = t.id))`,
      ).run();
      return db.prepare('DELETE FROM push_clears RETURNING thread_id').pluck().all() as string[];
    })();
    if (ids.length > 0) {
      const subs = subscriptions();
      for (const sub of subs) {
        const owed = ids.filter((id) => origins.get(id)?.endpoint !== sub.endpoint);
        for (let i = 0; i < owed.length; i += CLEAR_CHUNK) {
          const part = owed.slice(i, i + CLEAR_CHUNK);
          // Not high: it must not wake a sleeping phone by itself, and Android demotes high priority that shows nothing.
          enqueue(part.length === 1 ? { type: 'clear', threadId: part[0]! } : { type: 'clear', threadIds: part }, [sub], MAIL_TTL_S, 'normal');
        }
      }
      for (const id of ids) origins.delete(id);
    }
    for (const [id, o] of origins) if (at - o.at > ORIGIN_KEEP_MS) origins.delete(id);
  }

  const runSweep = () => guarded('the push sweep', sweepNow);

  function sweep(): void {
    if (sweepTimer) return;
    sweepTimer = setTimeout(() => {
      sweepTimer = undefined;
      runSweep();
    }, SWEEP_DELAY_MS);
    sweepTimer.unref();
  }

  const off = bus.subscribe(sweep);

  return {
    publicKey,
    newMail(accountId, threadIds) {
      guarded('notifying about new mail', () => {
        const to = subscriptions();
        if (to.length === 0) return;
        const own = ownEmailsOf(db);
        const threads = threadIds
          .map(threadRow)
          .filter((t): t is ThreadRow => !!t && t.unread === 1 && t.notify !== 0 && !newestIsOwn(t.id, own));
        announce(accountId, threads, to, (t) => ({ title: senderOf(t), body: [t.subject, t.snippet].filter(Boolean).join('\n') }), (n) => `${n} new emails`);
      });
    },
    snoozeReturned(threadIds) {
      guarded('notifying about a snooze', () => {
        const to = subscriptions();
        if (to.length === 0) return;
        const threads = threadIds.map(threadRow).filter((t): t is ThreadRow => !!t && t.notify !== 0);
        for (const accountId of new Set(threads.map((t) => t.account_id))) {
          const own = threads.filter((t) => t.account_id === accountId);
          announce(accountId, own, to, (t) => ({ title: 'Back from snooze', body: [senderOf(t), t.subject].filter(Boolean).join('\n') }), (n) => `${n} emails back from snooze`);
        }
      });
    },
    sweep,
    handledOn(threadId, endpoint) {
      origins.set(threadId, { endpoint, at: now() });
    },
    async test(endpoint) {
      const sub = subscriptions().find((s) => s.endpoint === endpoint);
      if (!sub) return null;
      const payload = JSON.stringify({ type: 'test', title: 'SuperMail', body: 'Notifications work on this device.' } satisfies PushPayload);
      return deliver({ sub, payload, ttl: MAIL_TTL_S, urgency: 'high' });
    },
    async idle() {
      if (sweepTimer) {
        clearTimeout(sweepTimer);
        sweepTimer = undefined;
      }
      runSweep();
      while (active.size > 0) await Promise.all(active);
    },
    stop() {
      off();
      if (sweepTimer) clearTimeout(sweepTimer);
      sweepTimer = undefined;
      queue.length = 0;
    },
  };
}
