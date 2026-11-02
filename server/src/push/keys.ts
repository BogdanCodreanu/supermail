import webpush from 'web-push';
import { decrypt, encrypt } from '../crypto/tokens.js';
import type { DB } from '../db/index.js';

export interface VapidKeys { publicKey: string; privateKey: string }
interface Log { warn(obj: unknown, msg?: string): void }

const KEYS = 'push_vapid';
const RESET = 'push_keys_reset';

function readKeys(key: Buffer, stored: string): VapidKeys | null {
  try {
    const keys = JSON.parse(decrypt(key, Buffer.from(stored, 'base64'))) as Partial<VapidKeys>;
    return keys.publicKey && keys.privateKey ? { publicKey: keys.publicKey, privateKey: keys.privateKey } : null;
  } catch {
    return null;
  }
}

/**
 * The server's VAPID pair, made on first start and kept in kv encrypted with secret.key, so the nightly backup holds
 * nothing readable. secret.key is left out of backups, so after a restore the pair cannot be read: a push subscription
 * is tied to the public key, so every subscription goes with it, and Settings asks to turn notifications on again.
 */
export function loadOrCreateVapid(db: DB, key: Buffer, log: Log): VapidKeys {
  const stored = db.prepare('SELECT value FROM kv WHERE key = ?').pluck().get(KEYS) as string | undefined;
  const kept = stored ? readKeys(key, stored) : null;
  if (kept) return kept;
  const fresh = webpush.generateVAPIDKeys();
  db.transaction(() => {
    db.prepare('INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT DO UPDATE SET value = excluded.value').run(KEYS, encrypt(key, JSON.stringify(fresh)).toString('base64'));
    if (!stored) return;
    db.prepare('DELETE FROM push_subscriptions').run();
    db.prepare('DELETE FROM notified_threads').run();
    db.prepare('DELETE FROM push_clears').run();
    db.prepare("INSERT INTO kv(key, value) VALUES (?, '1') ON CONFLICT DO NOTHING").run(RESET);
  })();
  if (stored) log.warn({}, 'push keys could not be read, so new ones were made and every device must turn notifications on again');
  return fresh;
}

export const keysWereReset = (db: DB): boolean => !!db.prepare('SELECT 1 FROM kv WHERE key = ?').get(RESET);
export const forgetKeysReset = (db: DB): void => void db.prepare('DELETE FROM kv WHERE key = ?').run(RESET);
