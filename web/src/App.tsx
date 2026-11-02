import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation, useNavigate, type RouteObject } from 'react-router-dom';
import { api, ApiError, qk } from './api/client';
import { useServerEvents } from './api/events';
import { closeThreadNotification, onOpenRequest, refreshPush } from './lib/push';
import { noteOpenedThread } from './state/listMemory';
import { AppToasts } from './state/toasts';
import { Compose } from './views/Compose';
import { Search } from './views/Search';
import { Thread } from './views/Thread';
import { Login } from './views/Login';
import { Settings } from './views/Settings';
import { Skipped } from './views/Skipped';
import { Spam } from './views/Spam';
import { SpamThread } from './views/SpamThread';
import { Inbox } from './views/Inbox';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // client errors (401 redirect, 404, …) won't fix themselves on retry
        retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      },
    },
  });
}

function ServerEvents() {
  useServerEvents();
  return null;
}

/** Notes each thread the thread view shows, so the inbox comes back on the one last read (state/listMemory). */
function TrackOpenedThread() {
  const { pathname } = useLocation();
  useEffect(() => {
    const m = /^\/t\/([^/]+)$/.exec(pathname);
    if (!m) return;
    const id = decodeURIComponent(m[1]!);
    noteOpenedThread(id);
    void closeThreadNotification(id);
  }, [pathname]);
  return null;
}

/** Keeps this device's push subscription healthy, and goes where a tapped notification points. */
function PushBridge() {
  const navigate = useNavigate();
  useEffect(() => void refreshPush(), []);
  const qc = useQueryClient();
  const { pathname } = useLocation();
  const here = useRef(pathname);
  here.current = pathname;
  useEffect(
    () =>
      onOpenRequest((url) => {
        // Already on that email (a reply to it notified): load it again so the new message shows.
        if (url === here.current) void qc.invalidateQueries({ queryKey: ['thread'] });
        else navigate(url);
      }),
    [navigate, qc],
  );
  return null;
}

/** The inbox layout without data, shown while `/api/me` loads (instead of a blank screen). */
function AppSkeleton() {
  const bar = 'rounded bg-hover';
  return (
    <div role="status" aria-busy="true" className="flex h-full flex-col">
      <span className="sr-only">Loading SuperMail…</span>
      <div aria-hidden className="flex h-12 shrink-0 items-center gap-4 border-b border-line px-4">
        <span className="font-semibold">SuperMail</span>
        <span className={`${bar} h-4 w-24`} />
        <span className="flex-1" />
        <span className={`${bar} hidden h-8 w-56 md:block`} />
        <span className={`${bar} h-8 w-24`} />
      </div>
      <div aria-hidden className="flex h-9 shrink-0 items-center gap-4 border-b border-line px-4">
        <span className={`${bar} h-3 w-64`} />
      </div>
      <div aria-hidden className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-hidden">
          {Array.from({ length: 14 }, (_, i) => (
            <div key={i} className="flex h-9 items-center gap-3 border-b border-line px-4">
              <span className={`${bar} h-2 w-2 shrink-0 rounded-full`} />
              <span className={`${bar} h-3 w-32 shrink-0`} />
              <span className={`${bar} h-3 flex-1`} style={{ maxWidth: `${40 + ((i * 17) % 45)}%` }} />
              <span className="flex-1" />
              <span className={`${bar} h-3 w-10 shrink-0`} />
            </div>
          ))}
        </div>
        <div className="hidden w-60 shrink-0 border-l border-line bg-panel md:block" />
      </div>
    </div>
  );
}

/** Signed-in area: needs `/api/me` (a 401 sends the browser to /login) and keeps the SSE stream open. */
function RequireAuth() {
  const me = useQuery({ queryKey: qk.me(), queryFn: api.me, retry: false, staleTime: Infinity });
  if (me.isPending) return <AppSkeleton />;
  if (me.isError) {
    return (
      <div role="alert" className="p-6 text-muted">
        Can't reach SuperMail.{' '}
        <button type="button" className="cursor-pointer text-accent underline" onClick={() => void me.refetch()}>
          Try again
        </button>
      </div>
    );
  }
  return (
    <>
      <ServerEvents />
      <TrackOpenedThread />
      <PushBridge />
      <Outlet />
      {/* Once, above every screen: send toasts and action toasts outlive the screen that showed them. */}
      <AppToasts />
    </>
  );
}

/**
 * The app's routes, for a data router (`createBrowserRouter` in the app, `createMemoryRouter` in
 * tests). A data router is what `useBlocker` (the composer's unsaved-draft guard) needs.
 */
export function appRoutes(): RouteObject[] {
  return [
    { path: '/login', element: <Login /> },
    {
      element: <RequireAuth />,
      children: [
        { path: '/', element: <Inbox /> },
        { path: '/t/:id', element: <Thread /> },
        { path: '/compose', element: <Compose /> },
        { path: '/search', element: <Search /> },
        { path: '/skipped', element: <Skipped /> },
        { path: '/spam', element: <Spam /> },
        { path: '/spam/:id', element: <SpamThread /> },
        { path: '/settings', element: <Settings /> },
        { path: '*', element: <Navigate to="/" replace /> },
      ],
    },
  ];
}

/** Opt in to the v7 behaviour now (and keep React Router's console quiet). */
export const ROUTER_FUTURE = {
  v7_fetcherPersist: true,
  v7_normalizeFormMethod: true,
  v7_partialHydration: true,
  v7_relativeSplatPath: true,
  v7_skipActionErrorRevalidation: true,
} as const;

export function App() {
  const [queryClient] = useState(createQueryClient);
  const [router] = useState(() => createBrowserRouter(appRoutes(), { future: ROUTER_FUTURE }));
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} future={{ v7_startTransition: true }} />
    </QueryClientProvider>
  );
}
