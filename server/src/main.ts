import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { ALLOW_ALL, type AppDeps, buildApp, NOOP_HOOK } from './http/app.js';
import { routePlugins } from './http/routes/index.js';
import { requireSession } from './auth/sessions.js'; // Task 2
import { logSerializers, oauthClient } from './google/oauth.js'; // Task 2
import type { RoutePlugin } from './http/app.js'; // Task 2
import { createPoller } from './sync/poller.js'; // Task 3
import { gmailForFactory } from './google/gmailClient.js'; // Task 3
import { loadOrCreateKey } from './crypto/tokens.js'; // Task 2/3 wiring
import { getRefreshToken } from './accounts/accounts.js'; // Task 2/3 wiring
import { canCacheBodies, canIndexMore, enforceLimits } from './storage/limits.js'; // Task 7
import { createLogSink } from './storage/logs.js'; // Task 7
import { labelWritesIdle, makeThreadHook } from './threads/classifyThread.js'; // Task 5
import { reconcileIndex, replayPendingWrites } from './actions/bulk.js';
import { createSnoozeScheduler } from './scheduler/snoozeScheduler.js'; // Task 5
import { loadOrCreateVapid } from './push/keys.js';
import { createPushService, webPushSender } from './push/service.js';

/** How long a stopping server waits for Gmail label writes still running behind a response. The journal keeps the rest. */
const SHUTDOWN_LABEL_WRITES_MS = 5_000;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  if (!existsSync(config.googleClientFile)) {
    throw new Error(`SuperMail is not configured yet: the Google OAuth client JSON is missing at ${config.googleClientFile}.\n  Create it with docs/google-cloud-setup.md, then put it there or point SUPERMAIL_CLIENT_FILE at it.`);
  }
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(join(config.dataDir, 'supermail.db'));
  const reconciled = reconcileIndex(db); // threads with a pending write are left to the replay below
  const secretKey = loadOrCreateKey(config.dataDir);

  const deps: AppDeps = {
    db,
    config,
    gmailFor: gmailForFactory(db, config, secretKey, { getRefreshToken, oauthClient }),
    now: () => Date.now(),
    onThreadChange: NOOP_HOOK,
    storage: ALLOW_ALL,
  };
  deps.storage = { canIndexMore, canCacheBodies }; // Task 7

  // Task 2: the session guard comes first so its preHandler covers every route.
  const sessionGuard: RoutePlugin = async (a, d) => {
    a.addHook('preHandler', requireSession(d.db, d.config, d.now));
  };
  const app = await buildApp(deps, [sessionGuard, ...routePlugins], { logger: { level: 'info', serializers: logSerializers, stream: createLogSink(config) } });
  // Task 5: classify + Gmail labels + two-way overrides for every new/changed thread; the snooze scheduler.
  app.log.info({ reconciled }, 'index reconciled with the labels at startup');
  deps.onThreadChange = makeThreadHook({ db, gmailFor: (id) => deps.gmailFor(id), now: () => deps.now(), log: app.log });
  const vapid = loadOrCreateVapid(db, secretKey, app.log);
  const push = createPushService({ db, publicKey: vapid.publicKey, sender: webPushSender(vapid, config.publicUrl), now: () => deps.now(), log: app.log });
  deps.push = push;
  const snoozeScheduler = createSnoozeScheduler(deps);
  // Task 3: history poller. Reads deps at call time, so later tasks' replacements of gmailFor/onThreadChange/storage apply.
  const poller = createPoller({ db, gmailFor: (id) => deps.gmailFor(id), intervalMs: config.pollSeconds * 1000, onChange: (id, reason) => deps.onThreadChange(id, reason), onNewMail: (id, threads) => push.newMail(id, threads), canIndexMore: () => deps.storage.canIndexMore(), onAfterTick: () => afterTick(), log: app.log });

  // Task 7: hard storage limits at startup, every 15 min and after each poller tick.
  let wasDegraded = false;
  function runLimits(): void {
    try {
      const r = enforceLimits(db, config, Date.now());
      if (r.evictedBodies || r.prunedThreads) app.log.info(r, 'storage limits enforced');
      if (r.degraded !== wasDegraded) app.log.warn({ degraded: r.degraded }, r.degraded ? 'storage degraded: indexing and body caching stopped' : 'storage back under limits');
      wasDegraded = r.degraded;
    } catch (err) {
      app.log.error({ err }, 'storage limit check failed');
    }
  }
  function afterTick(): void {
    runLimits();
    push.sweep(); // whatever slipped past the events, such as a removed account, is cleared within a poll
  }
  runLimits();
  const limitsTimer = setInterval(runLimits, 15 * 60_000);
  limitsTimer.unref();

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} received, shutting down`);
    poller.stop();
    clearInterval(limitsTimer); // Task 7
    snoozeScheduler.stop(); // Task 5
    push.stop();
    await app.close();
    await Promise.race([labelWritesIdle(db), delay(SHUTDOWN_LABEL_WRITES_MS)]); // teaching writes Gmail labels in the background
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(`listening on ${config.host}:${config.port}`);
  replayPendingWrites(deps, app.log); // in the background: whatever the last stop left unfinished stayed in the journal
  poller.start();
  snoozeScheduler.start(); // Task 5: also restores snoozes that fell due while we were down
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
