CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE accounts(id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, color TEXT NOT NULL, token_enc BLOB, status TEXT NOT NULL DEFAULT 'syncing', history_id TEXT, backfill_page_token TEXT, backfill_done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);

CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX sessions_expires ON sessions(expires_at);

CREATE TABLE groups(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, position INTEGER NOT NULL, color TEXT NOT NULL, notify INTEGER NOT NULL DEFAULT 1, kind TEXT NOT NULL CHECK(kind IN ('builtin','custom','existing_label')), builtin_key TEXT UNIQUE, existing_label_name TEXT);

CREATE TABLE group_labels(group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, gmail_label_id TEXT NOT NULL, PRIMARY KEY(group_id, account_id));
CREATE INDEX group_labels_account ON group_labels(account_id, gmail_label_id);

CREATE TABLE threads(id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, gmail_thread_id TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', snippet TEXT NOT NULL DEFAULT '', from_name TEXT, from_email TEXT, last_message_at INTEGER NOT NULL, unread INTEGER NOT NULL DEFAULT 0, in_inbox INTEGER NOT NULL DEFAULT 0, is_sent_only INTEGER NOT NULL DEFAULT 0, has_attachments INTEGER NOT NULL DEFAULT 0, group_id TEXT REFERENCES groups(id) ON DELETE SET NULL, reason_source TEXT, reason_text TEXT, reason_at INTEGER, done_at INTEGER, last_accessed_at INTEGER, UNIQUE(account_id, gmail_thread_id));
CREATE INDEX threads_inbox ON threads(in_inbox, last_message_at DESC, id DESC);
CREATE INDEX threads_group ON threads(group_id, in_inbox);
CREATE INDEX threads_from ON threads(from_email);
CREATE INDEX threads_last_message ON threads(last_message_at);

CREATE TABLE messages(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, account_id TEXT NOT NULL, gmail_message_id TEXT NOT NULL, from_name TEXT, from_email TEXT, to_json TEXT NOT NULL DEFAULT '[]', cc_json TEXT NOT NULL DEFAULT '[]', subject TEXT NOT NULL DEFAULT '', snippet TEXT NOT NULL DEFAULT '', date INTEGER NOT NULL, label_ids_json TEXT NOT NULL DEFAULT '[]', list_id TEXT, has_list_unsubscribe INTEGER NOT NULL DEFAULT 0, rfc822_message_id TEXT, references_hdr TEXT, size_estimate INTEGER NOT NULL DEFAULT 0, UNIQUE(account_id, gmail_message_id));
CREATE INDEX messages_thread ON messages(thread_id, date);
CREATE INDEX messages_from ON messages(from_email);
CREATE INDEX messages_list ON messages(list_id);

CREATE TABLE body_cache(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, html TEXT, text TEXT, attachments_json TEXT NOT NULL DEFAULT '[]', bytes INTEGER NOT NULL, last_accessed_at INTEGER NOT NULL);
CREATE INDEX body_cache_accessed ON body_cache(last_accessed_at);

CREATE TABLE rules(id TEXT PRIMARY KEY, match_type TEXT NOT NULL CHECK(match_type IN ('sender','domain','list')), match_value TEXT NOT NULL, group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, UNIQUE(match_type, match_value));

CREATE TABLE sender_marks(id TEXT PRIMARY KEY, match_type TEXT NOT NULL CHECK(match_type IN ('sender','domain','list')), match_value TEXT NOT NULL, mark TEXT NOT NULL CHECK(mark IN ('important','not_important')), created_at INTEGER NOT NULL, UNIQUE(match_type, match_value));

CREATE TABLE overrides(thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE, group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE, source TEXT NOT NULL CHECK(source IN ('app','gmail')), created_at INTEGER NOT NULL, suggest_rule INTEGER NOT NULL DEFAULT 0);

CREATE TABLE snoozes(thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE, until INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX snoozes_until ON snoozes(until);

CREATE TABLE label_writes(id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, gmail_thread_id TEXT NOT NULL, added_json TEXT NOT NULL, removed_json TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX label_writes_thread ON label_writes(account_id, gmail_thread_id, at);

CREATE TABLE undo(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX undo_created ON undo(created_at);
