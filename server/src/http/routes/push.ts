import { randomUUID } from 'node:crypto';
import type { PushDeviceDTO, PushKeyDTO, PushSubscribeRequest, PushSubscribeResult, PushTestResult } from '@supermail/shared';
import { HttpError } from '../../errors.js';
import { forgetKeysReset, keysWereReset } from '../../push/keys.js';
import type { PushService } from '../../push/service.js';
import type { RoutePlugin } from '../app.js';

const MAX_ENDPOINT = 2048;
const MAX_KEY = 256;
const MAX_USER_AGENT = 512;

const body = (req: { body: unknown }) => (req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {});
const isKey = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_KEY;

function endpointOf(b: Record<string, unknown>): string {
  const { endpoint } = b;
  if (typeof endpoint !== 'string' || !endpoint || endpoint.length > MAX_ENDPOINT) throw new HttpError(400, 'endpoint is required');
  return endpoint;
}

function subscriptionOf(b: Record<string, unknown>): PushSubscribeRequest {
  const endpoint = endpointOf(b);
  let protocol: string;
  try {
    ({ protocol } = new URL(endpoint));
  } catch {
    throw new HttpError(400, 'endpoint must be a URL');
  }
  if (protocol !== 'https:') throw new HttpError(400, 'endpoint must be https');
  const keys = (b.keys ?? {}) as Record<string, unknown>;
  if (!isKey(keys.p256dh) || !isKey(keys.auth)) throw new HttpError(400, 'keys are required');
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, userAgent: typeof b.userAgent === 'string' ? b.userAgent.slice(0, MAX_USER_AGENT) : undefined, refresh: b.refresh === true };
}

/** The push routes: see shared/src/api.ts. The session guard and the x-supermail check cover them as they cover all of /api. */
export const pushRoutes: RoutePlugin = async (app, deps) => {
  const { db } = deps;
  const service = (): PushService => {
    if (!deps.push) throw new HttpError(503, 'Notifications are not available');
    return deps.push;
  };

  app.get('/api/push/key', async (): Promise<PushKeyDTO> => ({ publicKey: service().publicKey, keysReset: keysWereReset(db) }));

  app.post('/api/push/subscribe', async (req): Promise<PushSubscribeResult> => {
    const s = subscriptionOf(body(req));
    const removed = db.prepare('SELECT removed_at FROM push_subscriptions WHERE endpoint = ?').pluck().get(s.endpoint);
    if (s.refresh && removed) return { ok: true, removed: true };
    db.prepare(
      `INSERT INTO push_subscriptions(id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, removed_at = NULL`,
    ).run(randomUUID(), s.endpoint, s.keys.p256dh, s.keys.auth, s.userAgent ?? null, deps.now());
    if (!s.refresh) forgetKeysReset(db);
    return { ok: true };
  });

  app.delete('/api/push/subscribe', async (req) => {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpointOf(body(req)));
    return { ok: true };
  });

  app.get('/api/push/devices', async (): Promise<PushDeviceDTO[]> => {
    const rows = db.prepare('SELECT id, endpoint, user_agent, created_at, last_ok_at FROM push_subscriptions WHERE removed_at IS NULL ORDER BY created_at, id').all() as
      { id: string; endpoint: string; user_agent: string | null; created_at: number; last_ok_at: number | null }[];
    return rows.map((r) => ({ id: r.id, endpoint: r.endpoint, userAgent: r.user_agent, createdAt: r.created_at, lastOkAt: r.last_ok_at }));
  });

  // The row stays until that device hears: see the head of migration 005.
  app.delete('/api/push/devices/:id', async (req) => {
    const { id } = req.params as { id: string };
    const { changes } = db.prepare('UPDATE push_subscriptions SET removed_at = ? WHERE id = ? AND removed_at IS NULL').run(deps.now(), id);
    if (changes === 0) throw new HttpError(404, 'No such device');
    return { ok: true };
  });

  app.post('/api/push/test', async (req): Promise<PushTestResult> => {
    const delivered = await service().test(endpointOf(body(req)));
    if (delivered === null) throw new HttpError(404, 'This device is not subscribed');
    return { ok: delivered };
  });
};
