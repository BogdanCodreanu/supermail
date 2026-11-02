import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db/index.js';
import { ALLOW_ALL, type AppDeps } from '../src/http/app.js';
import { snooze } from '../src/actions/actions.js';
import { createSnoozeScheduler } from '../src/scheduler/snoozeScheduler.js';
import { createPoller } from '../src/sync/poller.js';
import { makeThreadHook } from '../src/threads/classifyThread.js';
import { listInbox } from '../src/threads/queries.js';
import { createFakeGmail } from './fakes/fakeGmail.js';
import { FIXTURE_IDS, HOUR, inboxFixtures } from './fixtures/threads.js';

const NOW = Date.UTC(2026, 9, 29, 10, 0, 0);
const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

async function setup() {
  const db: DB = openDb(':memory:');
  db.prepare("INSERT INTO accounts(id, email, color, status, created_at) VALUES ('a', 'me@gmail.com', '#2563eb', 'syncing', 1)").run();
  const clock = { now: NOW };
  const a = createFakeGmail('me@gmail.com', { now: () => clock.now });
  for (const t of inboxFixtures(NOW)) a.addThread(t);
  const gmailFor = () => a;
  const hook = makeThreadHook({ db, gmailFor, now: () => clock.now, log });
  const poller = createPoller({ db, gmailFor, intervalMs: 30_000, onChange: hook, log });
  await poller.tick();
  await hook.idle();
  const deps: AppDeps = { db, config: {} as AppConfig, gmailFor, now: () => clock.now, onThreadChange: hook, storage: ALLOW_ALL };
  return { db, clock, deps, scheduler: createSnoozeScheduler(deps, 60_000) };
}

function allPages(db: DB, limit: number): string[] {
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = listInbox(db, { limit, cursor });
    seen.push(...page.threads.map((t) => t.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return seen;
}

describe('snooze resurfacing', () => {
  it('a due snooze on old mail is listed first, keeps its real date, and pages without duplicates', async () => {
    const { db, clock, deps, scheduler } = await setup();
    const personal = `a:${FIXTURE_IDS.personal}`; // the oldest inbox thread (30 h ago)
    const before = allPages(db, 50);
    expect(before.at(-1)).toBe(personal);

    await snooze(deps, personal, NOW + HOUR);
    clock.now = NOW + HOUR + 1;
    expect(await scheduler.runDue()).toBe(1);
    expect(db.prepare('SELECT surfaced_at FROM threads WHERE id = ?').pluck().get(personal)).toBe(NOW + HOUR + 1);

    const first = listInbox(db, { limit: 1 });
    expect(first.threads[0]).toMatchObject({ id: personal, lastMessageAt: NOW - 30 * HOUR });
    expect(first.nextCursor).toBe(`${NOW + HOUR + 1}:${personal}`);

    const expected = [personal, ...before.filter((id) => id !== personal)];
    for (const limit of [1, 2, 3]) expect(allPages(db, limit)).toEqual(expected);
  });

  it('newer mail that arrives after the snooze surfaced goes above it', async () => {
    const { db, clock, deps, scheduler } = await setup();
    const personal = `a:${FIXTURE_IDS.personal}`;
    await snooze(deps, personal, NOW + HOUR);
    clock.now = NOW + HOUR + 1;
    await scheduler.runDue();
    db.prepare('UPDATE threads SET last_message_at = ? WHERE id = ?').run(NOW + 2 * HOUR, `a:${FIXTURE_IDS.bolt}`);
    expect(listInbox(db, { limit: 2 }).threads.map((t) => t.id)).toEqual([`a:${FIXTURE_IDS.bolt}`, personal]);
  });
});
