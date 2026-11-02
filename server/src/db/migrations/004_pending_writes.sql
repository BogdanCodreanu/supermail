-- The Gmail writes a bulk action still owes: one row per thread per action, written with the index change and removed
-- when Gmail confirms. A restart replays what is left. There is no key on threads: undoing a report needs a row for a
-- thread the index has dropped.
CREATE TABLE pending_writes(seq INTEGER PRIMARY KEY AUTOINCREMENT, undo_id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, gmail_thread_id TEXT NOT NULL, op TEXT NOT NULL, intent_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX pending_writes_thread ON pending_writes(thread_id, op);
