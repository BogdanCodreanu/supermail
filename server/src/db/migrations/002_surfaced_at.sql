-- When a thread was brought back to the top of the inbox (a snooze falling due, a skipped thread restored).
-- The inbox sorts by MAX(last_message_at, surfaced_at), so it rises without changing its real message date.
ALTER TABLE threads ADD COLUMN surfaced_at INTEGER;
