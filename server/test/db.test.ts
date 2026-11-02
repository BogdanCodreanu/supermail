import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { BUILTIN_GROUPS, seedGroups } from '../src/db/seed.js';

const TABLES = [
  'kv', 'accounts', 'sessions', 'groups', 'group_labels', 'threads', 'messages', 'body_cache',
  'rules', 'sender_marks', 'overrides', 'snoozes', 'label_writes', 'undo', 'pending_writes', 'push_subscriptions', 'notified_threads', 'push_clears',
];

describe('openDb', () => {
  it('creates exactly the schema tables', () => {
    const db = openDb(':memory:');
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .pluck()
      .all();
    expect(names).toEqual([...TABLES].sort());
  });

  it('records the schema version and enables foreign keys', () => {
    const db = openDb(':memory:');
    expect(db.prepare("SELECT value FROM kv WHERE key='schema_version'").pluck().get()).toBe('5');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('seeds the 7 builtin groups in order', () => {
    const db = openDb(':memory:');
    const rows = db.prepare('SELECT builtin_key, name, position, color, kind FROM groups ORDER BY position').all();
    expect(rows).toEqual([
      { builtin_key: 'important', name: 'Important', position: 0, color: '#dc2626', kind: 'builtin' },
      { builtin_key: 'money_security', name: 'Money & Security', position: 1, color: '#d97706', kind: 'builtin' },
      { builtin_key: 'dev', name: 'Dev', position: 2, color: '#4f46e5', kind: 'builtin' },
      { builtin_key: 'purchases', name: 'Purchases', position: 3, color: '#0891b2', kind: 'builtin' },
      { builtin_key: 'news', name: 'News', position: 4, color: '#16a34a', kind: 'builtin' },
      { builtin_key: 'low_priority', name: 'Low priority', position: 5, color: '#64748b', kind: 'builtin' },
      { builtin_key: 'unsorted', name: 'Unsorted', position: 6, color: '#9333ea', kind: 'builtin' },
    ]);
    expect(BUILTIN_GROUPS).toHaveLength(7);
  });

  it('seedGroups is idempotent', () => {
    const db = openDb(':memory:');
    seedGroups(db);
    seedGroups(db);
    expect(db.prepare('SELECT count(*) FROM groups').pluck().get()).toBe(7);
  });

  it('seedGroups keeps a renamed builtin group', () => {
    const db = openDb(':memory:');
    db.prepare("UPDATE groups SET name='Newsletters' WHERE builtin_key='news'").run();
    seedGroups(db);
    expect(db.prepare("SELECT name FROM groups WHERE builtin_key='news'").pluck().get()).toBe('Newsletters');
    expect(db.prepare('SELECT count(*) FROM groups').pluck().get()).toBe(7);
  });

  it('deleting an account cascades to its threads and messages', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO accounts(id, email, color, created_at) VALUES ('a', 'a@x.com', '#2563eb', 1)").run();
    db.prepare("INSERT INTO accounts(id, email, color, created_at) VALUES ('b', 'b@x.com', '#16a34a', 1)").run();
    for (const acc of ['a', 'b']) {
      db.prepare("INSERT INTO threads(id, account_id, gmail_thread_id, last_message_at) VALUES (?, ?, 't1', 1)").run(`${acc}:t1`, acc);
      db.prepare("INSERT INTO messages(id, thread_id, account_id, gmail_message_id, date) VALUES (?, ?, ?, 'm1', 1)").run(`${acc}:m1`, `${acc}:t1`, acc);
    }
    db.prepare("DELETE FROM accounts WHERE id='a'").run();
    expect(db.prepare('SELECT id FROM threads').pluck().all()).toEqual(['b:t1']);
    expect(db.prepare('SELECT id FROM messages').pluck().all()).toEqual(['b:m1']);
  });

  it('migration 003 drops threads made only of spam or trash, and keeps mixed ones', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO accounts(id, email, color, created_at) VALUES ('a', 'a@x.com', '#2563eb', 1)").run();
    const add = (thread: string, ...labels: string[][]) => {
      db.prepare("INSERT INTO threads(id, account_id, gmail_thread_id, last_message_at) VALUES (?, 'a', ?, 1)").run(thread, thread);
      labels.forEach((l, i) => db.prepare("INSERT INTO messages(id, thread_id, account_id, gmail_message_id, date, label_ids_json) VALUES (?, ?, 'a', ?, 1, ?)").run(`${thread}-${i}`, thread, `${thread}-${i}`, JSON.stringify(l)));
    };
    add('spam', ['SPAM', 'UNREAD']);
    add('trash', ['TRASH'], ['TRASH', 'SENT']);
    add('mixed', ['TRASH'], ['INBOX']);
    add('normal', ['INBOX']);
    db.exec(readFileSync(new URL('../src/db/migrations/003_drop_spam_trash.sql', import.meta.url), 'utf8'));
    expect(db.prepare('SELECT id FROM threads ORDER BY id').pluck().all()).toEqual(['mixed', 'normal']);
  });
});
