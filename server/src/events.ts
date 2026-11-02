import type { ServerEvent } from '@supermail/shared';

type Listener = (e: ServerEvent) => void;

const listeners = new Set<Listener>();

/** In-process event bus feeding `GET /api/events` (SSE). */
export const bus: { publish(e: ServerEvent): void; subscribe(fn: Listener): () => void } = {
  publish(e) {
    for (const fn of [...listeners]) {
      try {
        fn(e);
      } catch (err) {
        console.error('event listener failed', err);
      }
    }
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};
