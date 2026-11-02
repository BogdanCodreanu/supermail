import { listHidingFilters, listSkipped, restore } from '../../skipped/skipped.js';
import type { RoutePlugin } from '../app.js';

/** `GET /api/skipped` (mail that skipped the inbox), `POST /api/skipped/:id/restore` and `GET /api/filters`. */
export const skippedRoutes: RoutePlugin = async (app, deps) => {
  app.get('/api/skipped', async (req) => {
    const { accountId } = req.query as { accountId?: string };
    return listSkipped(deps.db, deps.now(), accountId || undefined);
  });

  app.post('/api/skipped/:id/restore', async (req) => restore(deps, (req.params as { id: string }).id));

  app.get('/api/filters', async () => listHidingFilters(deps));
};
