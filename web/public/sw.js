// SuperMail's service worker. It keeps the app installable, says so when there is no network, and shows notifications.
// It never stores mail.
// Only the files below and hashed /assets are cached. Pages are never stored: a /t/ page has mail in it, so a navigation
// goes to the network and falls back to the offline page. /api and /auth are not touched at all, which keeps OAuth
// redirects, attachment downloads and the event stream the browser's own business.
// The build replaces __BUILD__ (web/src/lib/swBuild.ts), so each release gets a new cache and drops the last.

const CACHE = 'supermail-__BUILD__';
const OFFLINE = '/offline.html';
const ICON = '/icon-192.png';
const BADGE = '/badge-72.png';
const ACTIONS = [{ action: 'done', title: 'Done' }, { action: 'snooze', title: 'Snooze' }];
const FAILED = { done: "Couldn't mark as Done", snooze: "Couldn't snooze" };
/** What Chrome shows by itself when too many pushes left nothing on screen. */
const CHROME_NOTICE = 'user_visible_auto_notification';
/** Well past the end of the push event, see below. */
const CLEAR_DELAY_MS = 1000;
/** A window can only be opened for a few seconds after a tap, so a failed action must not take longer to fail. */
const ACTION_TIMEOUT_MS = 4000;
const SHELL = [OFFLINE, '/favicon.svg', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith('supermail-') && n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

/** Hashed names never change their content, so a stored copy is always right, whatever a `Vary` header says. */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (/^\/(api|auth)(\/|$)/.test(url.pathname)) return;
  if (url.pathname.startsWith('/assets/') || SHELL.includes(url.pathname)) event.respondWith(cacheFirst(request));
  else if (request.mode === 'navigate') event.respondWith(fetch(request).catch(() => caches.match(OFFLINE)));
});

const api = (path, init) => fetch(path, { credentials: 'same-origin', signal: AbortSignal.timeout(ACTION_TIMEOUT_MS), ...init });

function write(method, path, body, headers = {}) {
  return api(path, { method, headers: { 'x-supermail': '1', ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
}

const threadUrl = (threadId) => `/t/${encodeURIComponent(threadId)}`;

function mailOptions(threadId, sentAt, body, original) {
  return { body, tag: threadId, renotify: true, icon: ICON, badge: BADGE, timestamp: sentAt, data: { threadId, sentAt, ...original }, actions: ACTIONS };
}

function notify(message) {
  const { type, title = 'SuperMail', body = 'You have new mail', tag = type ?? 'supermail', threadId, sentAt } = message;
  // Who it is for, first, since several accounts share one inbox.
  if (type === 'mail') return self.registration.showNotification(title, mailOptions(threadId, sentAt, message.accountLabel ? `To ${message.accountLabel} · ${body}` : body));
  return self.registration.showNotification(title, { body, tag, renotify: true, icon: ICON, badge: BADGE, data: {} });
}

async function closeTagged(tags) {
  for (const tag of tags) {
    for (const notification of await self.registration.getNotifications({ tag })) notification.close();
  }
}

self.addEventListener('push', (event) => {
  let message = {};
  try {
    message = event.data.json();
  } catch {
    // Unreadable, but a push that shows nothing still counts against the site, so it goes on as a plain notice.
  }
  if (message.type !== 'clear') {
    event.waitUntil(notify(message));
    return;
  }
  // Chrome checks what is on screen the moment the event ends: with nothing there and no visible tab, the push counts as
  // silent, and too many of those bring up its own "updated in the background" notification. So the close waits for the
  // event to be over, and the notification it closes is what keeps this push from counting. Nothing to close is the one
  // case left, when the owner already swiped it away: that spends some of Chrome's allowance, and if a notice ever
  // appears, the next clear takes it away.
  const tags = [...(message.threadIds ?? [message.threadId]), CHROME_NOTICE];
  setTimeout(() => void closeTagged(tags), CLEAR_DELAY_MS);
});

/** The window the owner is most likely looking at: focused, then visible, then any. An installed app and a Chrome tab can both be open. */
function frontmost(windows) {
  return windows.find((w) => w.focused) ?? windows.find((w) => w.visibilityState === 'visible') ?? windows[0];
}

async function openApp(url) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const open = frontmost(windows);
  if (open) {
    try {
      await open.focus();
      // Every window follows, so the email shows in whichever one ends up in front.
      for (const w of windows) w.postMessage({ type: 'open', url });
      return;
    } catch {
      // It would not take focus: a new window it is.
    }
  }
  await self.clients.openWindow(url);
}

/** Tomorrow at 08:00 where the phone is, whatever the clocks do tonight. */
function tomorrowMorning() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 8).getTime();
}

async function act(action, notification) {
  const { threadId, sentAt, original } = notification.data;
  const path = `/api/threads/${encodeURIComponent(threadId)}/${action}`;
  try {
    const subscription = await self.registration.pushManager.getSubscription();
    const device = subscription ? { 'x-supermail-push': subscription.endpoint } : {};
    const res = await write('POST', path, action === 'snooze' ? { until: tomorrowMorning() } : undefined, device);
    if (res.ok) return;
  } catch {
    // Offline: handled below, like an expired session.
  }
  // It has not happened, so say that and keep the buttons, and open the thread to do it by hand.
  const { title, body } = original ?? notification;
  await self.registration.showNotification(FAILED[action], mailOptions(threadId, sentAt, `${title}\n${body}`, { original: { title, body } }));
  await openApp(threadUrl(threadId)).catch(() => {});
}

self.addEventListener('notificationclick', (event) => {
  const { notification, action } = event;
  const { threadId } = notification.data ?? {};
  notification.close();
  event.waitUntil(action ? act(action, notification) : openApp(threadId ? threadUrl(threadId) : '/'));
});

async function renew({ oldSubscription, newSubscription }) {
  const applicationServerKey = () => oldSubscription?.options?.applicationServerKey ?? api('/api/push/key').then((r) => r.json()).then((k) => k.publicKey);
  const subscription = newSubscription ?? (await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: await applicationServerKey() }));
  const { endpoint, keys } = subscription.toJSON();
  await write('POST', '/api/push/subscribe', { endpoint, keys, userAgent: self.navigator.userAgent });
  if (oldSubscription && oldSubscription.endpoint !== endpoint) await write('DELETE', '/api/push/subscribe', { endpoint: oldSubscription.endpoint });
}

// If this fails, say on an expired session, the app sends the subscription again the next time it starts.
self.addEventListener('pushsubscriptionchange', (event) => event.waitUntil(renew(event)));
