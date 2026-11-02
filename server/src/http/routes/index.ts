import type { RoutePlugin } from '../app.js';
import { accountsRoutes } from './accounts.js';
import { authRoutes } from './auth.js';
import { mailRoutes } from './mail.js'; // Task 6
import { privacyRoutes } from './privacy.js';
import { storageRoutes } from './storage.js'; // Task 7
import { groupsRoutes } from './groups.js'; // Task 5
import { threadsRoutes } from './threads.js'; // Task 5
import { skippedRoutes } from './skipped.js'; // Task 8
import { rulesRoutes } from './rules.js'; // Settings → Rules
import { spamRoutes } from './spam.js'; // Report spam and the Spam screen
import { pushRoutes } from './push.js'; // Web Push

// Append-only: each task adds its own route plugin here.
export const routePlugins: RoutePlugin[] = [];
routePlugins.push(authRoutes, accountsRoutes, privacyRoutes); // Task 2
routePlugins.push(mailRoutes); // Task 6
routePlugins.push(storageRoutes); // Task 7
routePlugins.push(threadsRoutes, groupsRoutes); // Task 5
routePlugins.push(skippedRoutes); // Task 8
routePlugins.push(rulesRoutes); // Settings → Rules
routePlugins.push(spamRoutes); // Report spam and the Spam screen
routePlugins.push(pushRoutes); // Web Push
