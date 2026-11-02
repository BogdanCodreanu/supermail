import { listAccounts, removeAccount } from '../../accounts/accounts.js';
import { HttpError } from '../../errors.js';
import type { RoutePlugin } from '../app.js';

/** `GET /api/accounts` → AccountDTO[] (never tokens) · `DELETE /api/accounts/:id` → `{ok:true}` | 404. */
export const accountsRoutes: RoutePlugin = async (app, { db }) => {
  app.get('/api/accounts', async () => listAccounts(db));

  app.delete('/api/accounts/:id', async (req) => {
    const { id } = req.params as { id: string };
    if (!listAccounts(db).some((a) => a.id === id)) throw new HttpError(404, 'No such account');
    removeAccount(db, id);
    return { ok: true };
  });
};
