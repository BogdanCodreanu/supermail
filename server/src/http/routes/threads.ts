import { PUSH_DEVICE_HEADER, type BulkRequest, type TeachBulkRequest, type TeachRequest } from '@supermail/shared';
import { done, moveToGroup, setRead, snooze, teach, unsnooze } from '../../actions/actions.js';
import { bulkAction, teachBulk } from '../../actions/bulk.js';
import { teachPreview } from '../../actions/teachPreview.js';
import { undo } from '../../actions/undo.js';
import { HttpError } from '../../errors.js';
import { listInbox } from '../../threads/queries.js';
import type { RoutePlugin } from '../app.js';

type Params = { id: string };
const body = (req: { body: unknown }) => (req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {});

/**
 * `GET /api/threads` (inbox page) and the thread actions: `POST /api/threads/:id/{done,snooze,unsnooze,move,read}`,
 * `POST /api/teach` and `POST /api/undo/:undoId`, each returning an ActionResult, and `POST /api/threads/bulk` and
 * `POST /api/teach/bulk`, returning a BulkResult. (`GET /api/threads/:id` is Task 6.)
 */
export const threadsRoutes: RoutePlugin = async (app, deps) => {
  /** Done and Snooze tapped on a notification: that device closed it, so it needs no clear. */
  const noteDevice = (req: { params: unknown; headers: Record<string, unknown> }) => {
    const endpoint = req.headers[PUSH_DEVICE_HEADER];
    if (typeof endpoint === 'string') deps.push?.handledOn((req.params as Params).id, endpoint);
  };

  app.get('/api/threads', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = q.limit === undefined ? undefined : Number(q.limit);
    if (limit !== undefined && !Number.isFinite(limit)) throw new HttpError(400, 'limit must be a number');
    return listInbox(deps.db, { accountId: q.accountId || undefined, groupId: q.groupId || undefined, cursor: q.cursor || undefined, limit, includeDone: q.includeDone === '1', now: deps.now() });
  });

  app.post('/api/threads/bulk', async (req) => bulkAction(deps, body(req) as unknown as BulkRequest));

  app.post('/api/threads/:id/done', async (req) => {
    noteDevice(req);
    return done(deps, (req.params as Params).id);
  });

  app.post('/api/threads/:id/snooze', async (req) => {
    const { until } = body(req);
    if (typeof until !== 'number') throw new HttpError(400, 'until must be a timestamp in ms');
    noteDevice(req);
    return snooze(deps, (req.params as Params).id, until);
  });

  app.post('/api/threads/:id/unsnooze', async (req) => unsnooze(deps, (req.params as Params).id));

  app.post('/api/threads/:id/move', async (req) => {
    const { groupId } = body(req);
    if (typeof groupId !== 'string' || !groupId) throw new HttpError(400, 'groupId is required');
    return moveToGroup(deps, (req.params as Params).id, groupId);
  });

  app.post('/api/threads/:id/read', async (req) => {
    const { read } = body(req);
    if (typeof read !== 'boolean') throw new HttpError(400, 'read must be true or false');
    return setRead(deps, (req.params as Params).id, read);
  });

  app.post('/api/teach', async (req) => {
    const b = body(req);
    if (typeof b.threadId !== 'string' || typeof b.action !== 'string' || typeof b.scope !== 'string') throw new HttpError(400, 'threadId, action and scope are required');
    if (b.groupId !== undefined && typeof b.groupId !== 'string') throw new HttpError(400, 'groupId must be a string');
    return teach(deps, b as unknown as TeachRequest);
  });

  app.post('/api/teach/bulk', async (req) => teachBulk(deps, body(req) as unknown as TeachBulkRequest));

  app.get('/api/teach/preview', async (req) => {
    const { threadId } = req.query as { threadId?: string };
    if (!threadId) throw new HttpError(400, 'threadId is required');
    return teachPreview(deps.db, threadId);
  });

  app.post('/api/undo/:undoId', async (req) => undo(deps, (req.params as { undoId: string }).undoId));
};
