import { getSpamThread, listSpam, notSpam, reportSpam } from '../../spam/spam.js';
import type { RoutePlugin } from '../app.js';

type Params = { id: string };

/** `POST /api/threads/:id/spam` · `GET /api/spam` · `GET /api/spam/:id` · `POST /api/spam/:id/not-spam`. */
export const spamRoutes: RoutePlugin = async (app, deps) => {
  app.post('/api/threads/:id/spam', async (req) => reportSpam(deps, (req.params as Params).id));

  app.get('/api/spam', async () => listSpam(deps));

  app.get('/api/spam/:id', async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    return getSpamThread(deps, (req.params as Params).id);
  });

  app.post('/api/spam/:id/not-spam', async (req) => notSpam(deps, (req.params as Params).id));
};
