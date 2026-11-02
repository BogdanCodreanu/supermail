import type { DB } from './index.js';

export const BUILTIN_GROUPS = [
  { key: 'important', name: 'Important', position: 0, color: '#dc2626' },
  { key: 'money_security', name: 'Money & Security', position: 1, color: '#d97706' },
  { key: 'dev', name: 'Dev', position: 2, color: '#4f46e5' },
  { key: 'purchases', name: 'Purchases', position: 3, color: '#0891b2' },
  { key: 'news', name: 'News', position: 4, color: '#16a34a' },
  { key: 'low_priority', name: 'Low priority', position: 5, color: '#64748b' },
  { key: 'unsorted', name: 'Unsorted', position: 6, color: '#9333ea' },
] as const;

export type BuiltinKey = (typeof BUILTIN_GROUPS)[number]['key'];

/** Builtin groups use their builtin_key as their id, so `dev`, `unsorted` etc. are stable ids. */
export function seedGroups(db: DB): void {
  const insert = db.prepare(
    `INSERT INTO groups(id, name, position, color, notify, kind, builtin_key)
     VALUES (@key, @name, @position, @color, 1, 'builtin', @key)
     ON CONFLICT DO NOTHING`,
  );
  db.transaction(() => {
    for (const g of BUILTIN_GROUPS) insert.run(g);
  })();
}
