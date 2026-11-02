import type { PushSubscribeRequest, ThreadId } from '@supermail/shared';
import { api } from '../api/client';

// Web Push on this device. The browser holds the subscription, the server only a copy of it, so what this device is doing
// is always read from the browser. A subscription is tied to the server's key: one made under an older key can never
// receive anything, which is what 'again' means.

export type PushState = 'unsupported' | 'blocked' | 'off' | 'on' | 'again';
export interface PushStatus { state: PushState; endpoint: string | null }

const status = (state: PushState, endpoint: string | null = null): PushStatus => ({ state, endpoint });

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function keyBytes(publicKey: string): Uint8Array<ArrayBuffer> {
  const raw = atob(publicKey.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function sameKey(subscription: PushSubscription, publicKey: string): boolean {
  const current = subscription.options.applicationServerKey;
  if (!current) return false;
  const a = new Uint8Array(current);
  const b = keyBytes(publicKey);
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function requestOf(subscription: PushSubscription, refresh: boolean): PushSubscribeRequest {
  const { endpoint, keys } = subscription.toJSON();
  return { endpoint: endpoint ?? subscription.endpoint, keys: { p256dh: keys?.p256dh ?? '', auth: keys?.auth ?? '' }, userAgent: navigator.userAgent, ...(refresh ? { refresh } : {}) };
}

export async function pushStatus(): Promise<PushStatus> {
  if (!pushSupported()) return status('unsupported');
  if (Notification.permission === 'denied') return status('blocked');
  const [key, registration] = await Promise.all([api.pushKey(), navigator.serviceWorker.getRegistration()]);
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription && Notification.permission === 'granted' && sameKey(subscription, key.publicKey)) return status('on', subscription.endpoint);
  return status(subscription || key.keysReset ? 'again' : 'off');
}

/** The worker is only installed in production, so in the mock this is what installs it. */
async function activeRegistration(): Promise<ServiceWorkerRegistration> {
  if (!(await navigator.serviceWorker.getRegistration())) await navigator.serviceWorker.register('/sw.js');
  return navigator.serviceWorker.ready;
}

/** Call it straight from the tap: asking for permission has to happen inside one. */
export async function turnOnPush(): Promise<PushState> {
  const permission = await Notification.requestPermission();
  if (permission === 'denied') return 'blocked';
  if (permission !== 'granted') return 'off';
  const [{ publicKey }, registration] = await Promise.all([api.pushKey(), activeRegistration()]);
  const existing = await registration.pushManager.getSubscription();
  if (existing && !sameKey(existing, publicKey)) await existing.unsubscribe();
  const subscription = existing && sameKey(existing, publicKey) ? existing : await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await api.pushSubscribe(requestOf(subscription, false));
  return 'on';
}

export async function turnOffPush(): Promise<void> {
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  const { endpoint } = subscription;
  await subscription.unsubscribe();
  // Browser first: if the server cannot be told, its next push to this endpoint gets a 410 and forgets it.
  await api.pushUnsubscribe(endpoint).catch(() => {});
}

/** Sends a test through the server. The mock has no push service, so it hands back what to show here instead. */
export async function sendTestPush(endpoint: string): Promise<boolean> {
  const { ok, preview } = await api.pushTest(endpoint);
  if (preview) {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration?.showNotification(preview.title, { body: preview.body, tag: 'test', icon: '/icon-192.png', badge: '/badge-72.png' });
  }
  return ok;
}

/**
 * On app start: tells the server this device's subscription again, in case the server lost it. One under an older key
 * stays out of it, for Settings to deal with, and a device the owner removed elsewhere stops here too.
 */
export async function refreshPush(): Promise<void> {
  try {
    if (!pushSupported() || Notification.permission !== 'granted') return;
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    const { publicKey } = await api.pushKey();
    if (!sameKey(subscription, publicKey)) return;
    const { removed } = await api.pushSubscribe(requestOf(subscription, true));
    if (removed) await turnOffPush();
  } catch {
    // Offline, or signed out: the next start tries again.
  }
}

/** The owner opened this thread, so its notification has done its job on this device. */
export async function closeThreadNotification(threadId: ThreadId): Promise<void> {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    for (const notification of (await registration?.getNotifications({ tag: threadId })) ?? []) notification.close();
  } catch {
    // Nothing to close, then.
  }
}

/** A tap on a notification with the app already open: the worker asks the window to go there. Returns the way to stop. */
export function onOpenRequest(go: (url: string) => void): () => void {
  const { serviceWorker } = navigator;
  if (!serviceWorker) return () => {};
  const listen = (e: MessageEvent<{ type?: string; url?: string }>) => {
    if (e.data?.type === 'open' && e.data.url) go(e.data.url);
  };
  serviceWorker.addEventListener('message', listen);
  return () => serviceWorker.removeEventListener('message', listen);
}
