import { randomBytes } from 'node:crypto';
import type { AccountDTO, AccountStatus } from '@supermail/shared';
import { decrypt, encrypt, TokenDecryptError } from '../crypto/tokens.js';
import type { DB } from '../db/index.js';
import { bus } from '../events.js';

export const ACCOUNT_COLORS = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#db2777', '#0891b2'];

const SELECT_DTO = 'SELECT id, email, color, status FROM accounts';

function getAccount(db: DB, accountId: string): AccountDTO | undefined {
  return db.prepare(`${SELECT_DTO} WHERE id = ?`).get(accountId) as AccountDTO | undefined;
}

/** The first palette color no account uses yet; once all are taken, cycle by account count. */
function nextColor(db: DB): string {
  const used = new Set(db.prepare('SELECT color FROM accounts').pluck().all() as string[]);
  return ACCOUNT_COLORS.find((c) => !used.has(c)) ?? ACCOUNT_COLORS[used.size % ACCOUNT_COLORS.length]!;
}

/**
 * Connects an account, or reconnects it: a new email gets the next color and status 'syncing'; an
 * existing one gets its token replaced, status 'syncing' and history_id NULL so the poller resyncs it.
 */
export function upsertAccount(db: DB, key: Buffer, email: string, refreshToken: string, now: number): AccountDTO {
  const normalized = email.toLowerCase();
  const tokenEnc = encrypt(key, refreshToken);
  const account = db.transaction(() => {
    const existing = db.prepare('SELECT id FROM accounts WHERE lower(email) = ?').pluck().get(normalized) as string | undefined;
    if (existing) {
      db.prepare("UPDATE accounts SET token_enc = ?, status = 'syncing', history_id = NULL WHERE id = ?").run(tokenEnc, existing);
      return getAccount(db, existing)!;
    }
    const id = randomBytes(6).toString('hex'); // never contains ':' (ThreadId is `${accountId}:${gmailThreadId}`)
    db.prepare("INSERT INTO accounts(id, email, color, token_enc, status, created_at) VALUES (?, ?, ?, ?, 'syncing', ?)").run(
      id,
      normalized,
      nextColor(db),
      tokenEnc,
      now,
    );
    return getAccount(db, id)!;
  })();
  bus.publish({ type: 'account.updated', account });
  return account;
}

export function listAccounts(db: DB): AccountDTO[] {
  return db.prepare(`${SELECT_DTO} ORDER BY created_at, rowid`).all() as AccountDTO[];
}

/**
 * Decrypts the account's refresh token. If it cannot be decrypted (key changed after a restore, or
 * corrupt data) the account flips to 'reconnect_needed' and the error is rethrown; nothing is deleted.
 */
export function getRefreshToken(db: DB, key: Buffer, accountId: string): string {
  const row = db.prepare('SELECT token_enc AS tokenEnc FROM accounts WHERE id = ?').get(accountId) as { tokenEnc: Buffer | null } | undefined;
  if (!row) throw new Error(`unknown account ${accountId}`);
  try {
    if (!row.tokenEnc) throw new TokenDecryptError('account has no stored token');
    return decrypt(key, row.tokenEnc);
  } catch (err) {
    if (err instanceof TokenDecryptError) setAccountStatus(db, accountId, 'reconnect_needed');
    throw err;
  }
}

/** Removes the account with its token, index, body cache and label map, plus its undo and label-write logs. */
export function removeAccount(db: DB, accountId: string): void {
  db.transaction(() => {
    db.prepare("DELETE FROM undo WHERE substr(thread_id, 1, length(@id) + 1) = @id || ':'").run({ id: accountId });
    db.prepare('DELETE FROM label_writes WHERE account_id = ?').run(accountId);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId); // cascades threads → messages → body_cache, group_labels
  })();
}

/** Sets the status and publishes `account.updated` when it changed. */
export function setAccountStatus(db: DB, accountId: string, status: AccountStatus): void {
  const changed = db.prepare('UPDATE accounts SET status = ? WHERE id = ? AND status <> ?').run(status, accountId, status).changes > 0;
  if (!changed) return;
  const account = getAccount(db, accountId);
  if (account) bus.publish({ type: 'account.updated', account });
}
