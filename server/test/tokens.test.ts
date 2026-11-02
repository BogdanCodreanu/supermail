import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, loadOrCreateKey, TokenDecryptError } from '../src/crypto/tokens.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'sm-key-'));
}

describe('token crypto', () => {
  it('round-trips a refresh token', () => {
    const key = randomBytes(32);
    expect(decrypt(key, encrypt(key, 'rt-123'))).toBe('rt-123');
  });

  it('uses a fresh iv each time (iv|tag|ciphertext layout)', () => {
    const key = randomBytes(32);
    const a = encrypt(key, 'rt-123');
    const b = encrypt(key, 'rt-123');
    expect(a.length).toBe(12 + 16 + 'rt-123'.length);
    expect(a.equals(b)).toBe(false);
  });

  it('throws TokenDecryptError with a different key', () => {
    const blob = encrypt(randomBytes(32), 'rt-123');
    expect(() => decrypt(randomBytes(32), blob)).toThrow(TokenDecryptError);
  });

  it('throws TokenDecryptError on a tampered or truncated blob', () => {
    const key = randomBytes(32);
    const blob = encrypt(key, 'rt-123');
    blob[blob.length - 1]! ^= 0xff;
    expect(() => decrypt(key, blob)).toThrow(TokenDecryptError);
    expect(() => decrypt(key, Buffer.from('short'))).toThrow(TokenDecryptError);
  });

  it('loadOrCreateKey returns the same 32 bytes twice and writes the file with mode 0600', () => {
    const dir = tmp();
    const k1 = loadOrCreateKey(dir);
    const k2 = loadOrCreateKey(dir);
    expect(k1.length).toBe(32);
    expect(k2.equals(k1)).toBe(true);
    expect(statSync(join(dir, 'secret.key')).mode & 0o777).toBe(0o600);
  });

  it('loadOrCreateKey creates the data dir if needed', () => {
    const dir = join(tmp(), 'nested', 'data');
    expect(loadOrCreateKey(dir).length).toBe(32);
  });

  it('loadOrCreateKey refuses a key file of the wrong length instead of replacing it', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'secret.key'), Buffer.alloc(7), { mode: 0o600 });
    expect(() => loadOrCreateKey(dir)).toThrow(/secret\.key/);
  });
});
