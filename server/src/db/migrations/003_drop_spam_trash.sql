-- Spam and trash are no longer indexed. Threads made only of them, indexed before that, go now.
DELETE FROM threads WHERE id IN (
  SELECT thread_id FROM messages
  GROUP BY thread_id
  HAVING SUM(label_ids_json LIKE '%"SPAM"%' OR label_ids_json LIKE '%"TRASH"%') = COUNT(*)
);
