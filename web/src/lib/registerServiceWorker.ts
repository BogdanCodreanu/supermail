/** Installs the worker in production only: in development it would keep serving yesterday's files. */
export function registerServiceWorker(production: boolean = import.meta.env.PROD): void {
  if (!production || !('serviceWorker' in navigator)) return;
  addEventListener('load', () => {
    // The app works without it, it just can't say it is offline.
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
