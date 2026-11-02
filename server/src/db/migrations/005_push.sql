-- Web Push. removed_at: the owner removed this device from Settings. The row stays so the device's next check-in is told
-- to stop, instead of quietly signing itself back up. notified_threads holds the notifications that may be on a screen;
-- clear_on_read is 0 for one back from snooze that was already read, which reading again must not take away.
CREATE TABLE push_subscriptions(id TEXT PRIMARY KEY, endpoint TEXT UNIQUE NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, user_agent TEXT, created_at INTEGER NOT NULL, last_ok_at INTEGER, removed_at INTEGER);
CREATE TABLE notified_threads(thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE, notified_at INTEGER NOT NULL, clear_on_read INTEGER NOT NULL DEFAULT 1);
-- The clears still owed. A thread can leave the index by a cascade from anywhere (Gmail delete, spam, removing an account,
-- storage limits), and that takes its notified_threads row with it, so the row's end is what records the debt.
CREATE TABLE push_clears(thread_id TEXT PRIMARY KEY);
CREATE TRIGGER notified_thread_gone AFTER DELETE ON notified_threads BEGIN
  INSERT OR IGNORE INTO push_clears(thread_id) VALUES (OLD.thread_id);
END;
