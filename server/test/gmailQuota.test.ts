import { google } from 'googleapis';
import { describe, expect, it } from 'vitest';
import { createGmailApi, createTokenBucket, GMAIL_QUOTA_COST, GMAIL_QUOTA_UNITS_PER_SEC, type OAuth2Client } from '../src/google/gmailClient.js';

/** A clock whose sleeps advance virtual time instantly. */
function virtualClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function stubAuth(handler: (opts: { url: string }) => Promise<unknown>): OAuth2Client {
  const auth = new google.auth.OAuth2();
  (auth as unknown as { request: typeof handler }).request = handler;
  return auth;
}

describe('Gmail quota token bucket', () => {
  it('lets a burst up to its capacity through, then paces callers at the refill rate', async () => {
    const clock = virtualClock();
    const bucket = createTokenBucket(200, 200, clock);
    for (let i = 0; i < 20; i++) await bucket.take(10);
    expect(clock.now()).toBe(0);
    await bucket.take(100);
    expect(clock.now()).toBeCloseTo(500, 0);
  });

  it('serves waiters in order', async () => {
    const clock = virtualClock();
    const bucket = createTokenBucket(10, 10, clock);
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => bucket.take(10).then(() => order.push(n))));
    expect(order).toEqual([1, 2, 3]);
    expect(clock.now()).toBeCloseTo(2000, 0);
  });

  it(`caps a Gmail client at about ${GMAIL_QUOTA_UNITS_PER_SEC} quota units per second`, async () => {
    const clock = virtualClock();
    const api = createGmailApi(stubAuth(async () => ({ data: { id: 't', messages: [] } })), { quota: createTokenBucket(GMAIL_QUOTA_UNITS_PER_SEC, GMAIL_QUOTA_UNITS_PER_SEC, clock) });
    // 60 threads.get at 10 units each = 600 units: 200 of burst, then 400 units at 200/s = 2 s.
    await Promise.all(Array.from({ length: 60 }, (_, i) => api.getThread(`t${i}`, 'metadata')));
    expect(clock.now()).toBeGreaterThanOrEqual(1999);
    expect(clock.now()).toBeLessThan(2100);
  });

  it('charges each method its Gmail quota cost', async () => {
    expect(GMAIL_QUOTA_COST).toMatchObject({ getThread: 10, listHistory: 2, listThreads: 10, modifyThread: 10, listLabels: 1, createLabel: 1, sendRaw: 100 });
    const clock = virtualClock();
    const api = createGmailApi(stubAuth(async () => ({ data: { history: [], id: 'm', threadId: 't' } })), { quota: createTokenBucket(100, 100, clock) });
    for (let i = 0; i < 50; i++) await api.listHistory('1'); // 100 units: the whole burst
    expect(clock.now()).toBe(0);
    await api.sendRaw('raw'); // 100 more units: one second of refill
    expect(clock.now()).toBeCloseTo(1000, 0);
  });
});
