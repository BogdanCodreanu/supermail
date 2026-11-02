import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const KEY_FILE = 'secret.key';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The stored token cannot be decrypted: wrong key (e.g. restored backup without secret.key) or corrupt data. */
export class TokenDecryptError extends Error {
  override name = 'TokenDecryptError';
}

/**
 * Returns the 32-byte key in `${dataDir}/secret.key`, creating it (mode 0600) on first use.
 * The add-on excludes this file from Home Assistant backups, so a restore means reconnecting accounts.
 * A key file of the wrong size is an error, never silently replaced.
 */
export function loadOrCreateKey(dataDir: string): Buffer {
  const file = join(dataDir, KEY_FILE);
  let key: Buffer;
  try {
    key = readFileSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    mkdirSync(dataDir, { recursive: true });
    key = randomBytes(KEY_BYTES);
    try {
      writeFileSync(file, key, { mode: 0o600, flag: 'wx' });
    } catch (writeErr) {
      if ((writeErr as NodeJS.ErrnoException).code !== 'EEXIST') throw writeErr;
      key = readFileSync(file); // another process created it first
    }
  }
  if (key.length !== KEY_BYTES) throw new Error(`${file} must contain exactly ${KEY_BYTES} bytes`);
  chmodSync(file, 0o600);
  return key;
}

/** AES-256-GCM. Output layout: iv(12) | tag(16) | ciphertext. */
export function encrypt(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decrypt(key: Buffer, blob: Buffer): string {
  if (blob.length < IV_BYTES + TAG_BYTES) throw new TokenDecryptError('token blob is too short');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, IV_BYTES));
    decipher.setAuthTag(blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(blob.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  } catch {
    throw new TokenDecryptError('token cannot be decrypted with the current key');
  }
}
