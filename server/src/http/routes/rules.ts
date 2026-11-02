import type { MatchType, TeachingDTO } from '@supermail/shared';
import { threadsMatching } from '../../actions/actions.js';
import { HttpError } from '../../errors.js';
import { reclassifyThreads } from '../../threads/classifyThread.js';
import { activeThreads } from '../../threads/queries.js';
import type { RoutePlugin } from '../app.js';

interface TeachingRow { id: string; kind: TeachingDTO['kind']; match_type: MatchType; match_value: string; group_id: string | null; group_name: string | null; mark: TeachingDTO['mark']; created_at: number }

const tableOf = (kind: string) => (kind === 'rule' ? 'rules' : kind === 'mark' ? 'sender_marks' : null);

/**
 * `GET /api/teaching` lists what the owner has taught, and `DELETE /api/teaching/:kind/:id` removes one entry. The
 * inbox and snoozed threads that matched fall back to the next rule or the automatic guess, and are relabelled.
 */
export const rulesRoutes: RoutePlugin = async (app, deps) => {
  const { db } = deps;

  app.get('/api/teaching', async (): Promise<TeachingDTO[]> => {
    const rows = db.prepare(
      `SELECT r.id, 'rule' AS kind, r.match_type, r.match_value, r.group_id, g.name AS group_name, NULL AS mark, r.created_at
         FROM rules r JOIN groups g ON g.id = r.group_id
       UNION ALL
       SELECT id, 'mark', match_type, match_value, NULL, NULL, mark, created_at FROM sender_marks
       ORDER BY created_at DESC, id`,
    ).all() as TeachingRow[];
    const active = activeThreads(db);
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      matchType: r.match_type,
      matchValue: r.match_value,
      groupId: r.group_id,
      groupName: r.group_name,
      mark: r.mark,
      createdAt: r.created_at,
      threadCount: threadsMatching(db, r.match_type, r.match_value).filter((id) => active.has(id)).length,
    }));
  });

  app.delete('/api/teaching/:kind/:id', async (req) => {
    const { kind, id } = req.params as { kind: string; id: string };
    const table = tableOf(kind);
    const entry = table && (db.prepare(`SELECT match_type, match_value FROM ${table} WHERE id = ?`).get(id) as Pick<TeachingRow, 'match_type' | 'match_value'> | undefined);
    if (!table || !entry) throw new HttpError(404, 'Nothing to remove');
    const active = activeThreads(db);
    const threads = threadsMatching(db, entry.match_type, entry.match_value).filter((t) => active.has(t));
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    await reclassifyThreads(db, deps.gmailFor, threads, deps.now(), { log: req.log, labels: 'background' });
    return { ok: true };
  });
};
