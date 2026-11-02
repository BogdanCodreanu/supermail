import type { StorageUsageDTO } from '@supermail/shared';
import type { RoutePlugin } from '../app.js';
import { measure } from '../../storage/limits.js';

export const storageRoutes: RoutePlugin = async (app, deps) => {
  app.get('/api/storage', async (): Promise<StorageUsageDTO> => measure(deps.db, deps.config));
};
