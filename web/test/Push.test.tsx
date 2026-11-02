import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupDTO, PushDeviceDTO } from '@supermail/shared';
import { api } from '../src/api/client';
import { appRoutes } from '../src/App';
import { PushBanner } from '../src/components/phone/PushBanner';
import { closeThreadNotification, onOpenRequest, pushStatus, refreshPush } from '../src/lib/push';
import { Settings } from '../src/views/Settings';
import { stubPhone } from './phoneEnv';

vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  const none = () => vi.fn();
  return {
    ...actual,
    api: {
      me: none(), accounts: none(), groups: none(), storage: none(), labels: none(), teaching: none(), patchGroup: none(), threads: none(), thread: none(), read: none(),
      pushKey: none(), pushSubscribe: none(), pushUnsubscribe: none(), pushDevices: none(), removePushDevice: none(), pushTest: none(),
    },
  };
});

const mocked = vi.mocked(api);
const KEY = 'BAECAwQ'; // base64url of 04 01 02 03 04
const KEY_BYTES = new Uint8Array([4, 1, 2, 3, 4]).buffer;
const OLD_KEY_BYTES = new Uint8Array([4, 9, 9, 9, 9]).buffer;
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/this-one';
const ANDROID = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36';

const group = (id: string, name: string, notify = true): GroupDTO => ({ id, name, position: 0, color: '#64748b', notify, kind: 'builtin', inboxCount: 0, unreadCount: 0 });
const device = (id: string, endpoint = ENDPOINT, userAgent = ANDROID): PushDeviceDTO => ({ id, endpoint, userAgent, createdAt: 1, lastOkAt: null });

function subscription(keyBytes: ArrayBuffer = KEY_BYTES) {
  return { endpoint: ENDPOINT, options: { applicationServerKey: keyBytes }, toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: 'p', auth: 'a' } }), unsubscribe: vi.fn(async () => true) };
}

const original = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
afterEach(() => {
  if (original) Object.defineProperty(navigator, 'serviceWorker', original);
  else delete (navigator as { serviceWorker?: unknown }).serviceWorker;
});

/** A browser with push, in the state asked for. */
function browser(o: { permission?: NotificationPermission; answer?: NotificationPermission; existing?: ReturnType<typeof subscription> | null; noWorker?: boolean } = {}) {
  const existing = o.existing ?? null;
  const fresh = subscription();
  const pushManager = { getSubscription: vi.fn(async () => existing), subscribe: vi.fn(async () => fresh) };
  const registration = { pushManager, getNotifications: vi.fn(async () => [] as { close(): void }[]), showNotification: vi.fn(async () => {}) };
  const listeners = new Set<(e: { data: unknown }) => void>();
  const serviceWorker = {
    getRegistration: vi.fn(async () => (o.noWorker ? undefined : registration)),
    register: vi.fn(async () => registration),
    ready: Promise.resolve(registration),
    addEventListener: (_: string, l: (e: { data: unknown }) => void) => listeners.add(l),
    removeEventListener: (_: string, l: (e: { data: unknown }) => void) => listeners.delete(l),
  };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker });
  const requestPermission = vi.fn(async () => o.answer ?? 'granted');
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal('Notification', { permission: o.permission ?? 'default', requestPermission });
  return { registration, pushManager, requestPermission, fresh, serviceWorker, message: (data: unknown) => listeners.forEach((l) => l({ data })) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.pushKey.mockResolvedValue({ publicKey: KEY, keysReset: false });
  mocked.pushSubscribe.mockResolvedValue({ ok: true });
  mocked.pushUnsubscribe.mockResolvedValue(undefined);
  mocked.pushDevices.mockResolvedValue([]);
  mocked.removePushDevice.mockResolvedValue(undefined);
  mocked.pushTest.mockResolvedValue({ ok: true });
  mocked.accounts.mockResolvedValue([]);
  mocked.groups.mockResolvedValue([group('dev', 'Dev'), group('news', 'News', false)]);
  mocked.labels.mockResolvedValue([]);
  mocked.teaching.mockResolvedValue([]);
  mocked.patchGroup.mockImplementation(async (id, p) => ({ ...group(id, id), ...p }));
  mocked.storage.mockReturnValue(new Promise(() => {}));
});

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

function renderSettings() {
  render(
    <QueryClientProvider client={client()}>
      <MemoryRouter>
        <Settings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return screen.getByRole('region', { name: 'Notifications' });
}

describe('Settings: notifications', () => {
  it('comes first', () => {
    browser();
    renderSettings();
    expect(screen.getAllByRole('region')[0]).toHaveAccessibleName('Notifications');
  });

  it('says so where the browser has no push, and offers nothing', async () => {
    renderSettings();
    const s = screen.getByRole('region', { name: 'Notifications' });
    expect(await within(s).findByText(/can't show notifications/)).toBeInTheDocument();
    expect(within(s).queryByRole('button')).not.toBeInTheDocument();
    expect(mocked.pushKey).not.toHaveBeenCalled();
  });

  it('off: Turn on asks for permission, subscribes under the server key and tells the server', async () => {
    const b = browser();
    const s = renderSettings();
    expect(await within(s).findByText('Off on this device.')).toBeInTheDocument();
    Object.assign(Notification, { permission: 'granted' });
    b.pushManager.getSubscription.mockResolvedValue(null);
    fireEvent.click(within(s).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(mocked.pushSubscribe).toHaveBeenCalled());
    expect(b.requestPermission).toHaveBeenCalled();
    expect(b.pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: new Uint8Array([4, 1, 2, 3, 4]) });
    expect(mocked.pushSubscribe.mock.calls[0]![0]).toMatchObject({ endpoint: ENDPOINT, keys: { p256dh: 'p', auth: 'a' }, userAgent: expect.any(String) });
    expect(mocked.pushSubscribe.mock.calls[0]![0].refresh).toBeUndefined();
  });

  it('asks for permission before anything else, so the tap still counts', async () => {
    const b = browser();
    const s = renderSettings();
    const turnOn = await within(s).findByRole('button', { name: 'Turn on' });
    mocked.pushKey.mockClear();
    b.requestPermission.mockImplementation(async () => {
      expect(mocked.pushKey).not.toHaveBeenCalled();
      return 'default';
    });
    fireEvent.click(turnOn);
    await waitFor(() => expect(b.requestPermission).toHaveBeenCalled());
    expect(b.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it('shows it is working: a first subscribe can take many seconds', async () => {
    const b = browser();
    b.pushManager.subscribe.mockReturnValue(new Promise(() => {}));
    const s = renderSettings();
    fireEvent.click(await within(s).findByRole('button', { name: 'Turn on' }));
    expect(await within(s).findByRole('button', { name: 'Turning on…' })).toBeDisabled();
  });

  it('a refused permission lands on blocked, and subscribes to nothing', async () => {
    const b = browser({ answer: 'denied' });
    const s = renderSettings();
    fireEvent.click(await within(s).findByRole('button', { name: 'Turn on' }));
    Object.assign(Notification, { permission: 'denied' });
    expect(await within(s).findByText(/blocked on this device/)).toBeInTheDocument();
    expect(b.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it('shows why turning on failed', async () => {
    const b = browser();
    b.pushManager.subscribe.mockRejectedValue(new Error('Registration failed - push service not available'));
    const s = renderSettings();
    fireEvent.click(await within(s).findByRole('button', { name: 'Turn on' }));
    expect(await within(s).findByRole('alert')).toHaveTextContent('push service not available');
  });

  it('blocked: explains the way back, in Chrome and in the installed app', async () => {
    browser({ permission: 'denied' });
    const s = renderSettings();
    expect(await within(s).findByText(/blocked on this device/)).toBeInTheDocument();
    expect(within(s).getByText(/Site settings, Notifications/)).toBeInTheDocument();
    expect(within(s).getByText(/App info/)).toBeInTheDocument();
    expect(within(s).queryByRole('button', { name: 'Turn on' })).not.toBeInTheDocument();
  });

  it('on: says so, and offers a test and Turn off', async () => {
    browser({ permission: 'granted', existing: subscription() });
    const s = renderSettings();
    expect(await within(s).findByText('On for this device.')).toBeInTheDocument();
    fireEvent.click(within(s).getByRole('button', { name: 'Send a test notification' }));
    await waitFor(() => expect(mocked.pushTest).toHaveBeenCalledWith(ENDPOINT));
    expect(await within(s).findByRole('status')).toHaveTextContent('Test sent');
  });

  it('says when the test could not be delivered', async () => {
    browser({ permission: 'granted', existing: subscription() });
    mocked.pushTest.mockResolvedValue({ ok: false });
    const s = renderSettings();
    fireEvent.click(await within(s).findByRole('button', { name: 'Send a test notification' }));
    expect(await within(s).findByRole('status')).toHaveTextContent("couldn't be delivered");
  });

  it('shows the mock\'s test itself, there being no push service', async () => {
    const b = browser({ permission: 'granted', existing: subscription() });
    mocked.pushTest.mockResolvedValue({ ok: true, preview: { title: 'SuperMail', body: 'Hello' } });
    const s = renderSettings();
    fireEvent.click(await within(s).findByRole('button', { name: 'Send a test notification' }));
    await waitFor(() => expect(b.registration.showNotification).toHaveBeenCalledWith('SuperMail', expect.objectContaining({ body: 'Hello' })));
  });

  it('Turn off unsubscribes the browser and tells the server', async () => {
    const existing = subscription();
    browser({ permission: 'granted', existing });
    const s = renderSettings();
    fireEvent.click(await within(s).findByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(mocked.pushUnsubscribe).toHaveBeenCalledWith(ENDPOINT));
    expect(existing.unsubscribe).toHaveBeenCalled();
  });

  it('after the server changed keys: offers to turn on again, and replaces the dead subscription', async () => {
    const old = subscription(OLD_KEY_BYTES);
    const b = browser({ permission: 'granted', existing: old });
    const s = renderSettings();
    fireEvent.click(await within(s).findByRole('button', { name: 'Turn notifications on again' }));
    await waitFor(() => expect(mocked.pushSubscribe).toHaveBeenCalled());
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(b.pushManager.subscribe).toHaveBeenCalled();
  });

  it('says the same on a device with no subscription left, when the server says keys were replaced', async () => {
    browser({ permission: 'granted' });
    mocked.pushKey.mockResolvedValue({ publicKey: KEY, keysReset: true });
    const s = renderSettings();
    expect(await within(s).findByRole('button', { name: 'Turn notifications on again' })).toBeInTheDocument();
  });

  it('lists devices by name, marks this one, and removes another through the server', async () => {
    browser({ permission: 'granted', existing: subscription() });
    mocked.pushDevices.mockResolvedValue([device('d1'), device('d2', 'https://push.example/other', 'Mozilla/5.0 (Windows NT 10.0) Chrome/140')]);
    const s = renderSettings();
    expect(await within(s).findByText('Chrome on Android')).toBeInTheDocument();
    expect(within(s).getByText('This device').closest('li')).toHaveTextContent('Chrome on Android');
    fireEvent.click(within(s).getByRole('button', { name: 'Remove Chrome on Windows' }));
    await waitFor(() => expect(mocked.removePushDevice).toHaveBeenCalledWith('d2'));
  });

  it('removing this device turns it off properly', async () => {
    const existing = subscription();
    browser({ permission: 'granted', existing });
    mocked.pushDevices.mockResolvedValue([device('d1')]);
    const s = renderSettings();
    fireEvent.click(await within(s).findByRole('button', { name: 'Remove Chrome on Android' }));
    await waitFor(() => expect(existing.unsubscribe).toHaveBeenCalled());
    expect(mocked.removePushDevice).not.toHaveBeenCalled();
  });

  it('shows the bells, says what they do, and a tap mutes the group', async () => {
    browser();
    const s = renderSettings();
    expect(await within(s).findByText("Muted groups stay in your inbox, they just don't buzz.")).toBeInTheDocument();
    expect(await within(s).findByRole('button', { name: 'Notify for News' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(within(s).getByRole('button', { name: 'Notify for Dev' }));
    await waitFor(() => expect(mocked.patchGroup).toHaveBeenCalledWith('dev', { notify: false }));
  });

  it('has touch targets of 44px on the phone', async () => {
    stubPhone();
    browser();
    const s = renderSettings();
    for (const name of ['Turn on', 'Notify for Dev']) expect((await within(s).findByRole('button', { name })).className).toMatch(/\bh-11\b/);
  });
});

function renderBanner() {
  return render(
    <QueryClientProvider client={client()}>
      <PushBanner />
    </QueryClientProvider>,
  );
}

describe('the phone banner', () => {
  it('invites while notifications are off, and Turn on does it', async () => {
    const b = browser();
    renderBanner();
    expect(await screen.findByText('Get notified about new mail')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(mocked.pushSubscribe).toHaveBeenCalled());
    expect(b.requestPermission).toHaveBeenCalled();
  });

  it.each([
    ['already on', () => browser({ permission: 'granted', existing: subscription() })],
    ['blocked', () => browser({ permission: 'denied' })],
    ['not possible here', () => undefined],
  ])('stays away when %s', async (_, setUp) => {
    setUp();
    const { container } = renderBanner();
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });

  it('stays dismissed', async () => {
    browser();
    const first = renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Get notified about new mail')).not.toBeInTheDocument();
    first.unmount();
    const { container } = renderBanner();
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });

  it('can be dismissed where storage refuses', async () => {
    browser();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Get notified about new mail')).not.toBeInTheDocument();
  });

  it('says what went wrong', async () => {
    const b = browser();
    b.pushManager.subscribe.mockRejectedValue(new Error('no push service'));
    renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no push service');
  });
});

describe('keeping the subscription healthy', () => {
  it('sends the subscription again on start, marked as a check-in', async () => {
    browser({ permission: 'granted', existing: subscription() });
    await refreshPush();
    expect(mocked.pushSubscribe).toHaveBeenCalledWith(expect.objectContaining({ endpoint: ENDPOINT, refresh: true }));
  });

  it.each([
    ['permission is not granted', { permission: 'default' as const, existing: subscription() }],
    ['the browser has no subscription', { permission: 'granted' as const }],
    ['no worker is installed', { permission: 'granted' as const, noWorker: true }],
    ['the subscription is under an old key', { permission: 'granted' as const, existing: subscription(OLD_KEY_BYTES) }],
  ])('does nothing when %s', async (_, o) => {
    browser(o);
    await refreshPush();
    expect(mocked.pushSubscribe).not.toHaveBeenCalled();
  });

  it('does nothing where the browser has no push', async () => {
    await refreshPush();
    expect(mocked.pushSubscribe).not.toHaveBeenCalled();
  });

  it('stops for good on a device the owner removed elsewhere', async () => {
    const existing = subscription();
    browser({ permission: 'granted', existing });
    mocked.pushSubscribe.mockResolvedValue({ ok: true, removed: true });
    await refreshPush();
    expect(existing.unsubscribe).toHaveBeenCalled();
    expect(mocked.pushUnsubscribe).toHaveBeenCalledWith(ENDPOINT);
  });

  it('never throws: offline or signed out, the next start tries again', async () => {
    browser({ permission: 'granted', existing: subscription() });
    mocked.pushKey.mockRejectedValue(new Error('offline'));
    await expect(refreshPush()).resolves.toBeUndefined();
  });

  it('reads "on" only from the browser and its key', async () => {
    browser({ permission: 'granted', existing: subscription() });
    expect(await pushStatus()).toEqual({ state: 'on', endpoint: ENDPOINT });
  });
});

describe('notifications and the open app', () => {
  it('closes the notification of a thread being opened, and no other', async () => {
    const b = browser();
    const close = vi.fn();
    b.registration.getNotifications.mockResolvedValue([{ close }]);
    await closeThreadNotification('a:1');
    expect(b.registration.getNotifications).toHaveBeenCalledWith({ tag: 'a:1' });
    expect(close).toHaveBeenCalled();
  });

  it('is harmless where the browser has no worker', async () => {
    await expect(closeThreadNotification('a:1')).resolves.toBeUndefined();
  });

  it('goes where the worker asks, and only for that message', () => {
    const b = browser();
    const go = vi.fn();
    const stop = onOpenRequest(go);
    b.message({ type: 'other', url: '/x' });
    b.message({ type: 'open', url: '/t/a%3A1' });
    stop();
    b.message({ type: 'open', url: '/t/later' });
    expect(go.mock.calls).toEqual([['/t/a%3A1']]);
  });

  it('in the app: opening a thread closes its notification, a tap navigates, and start checks in', async () => {
    vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
    const b = browser({ permission: 'granted', existing: subscription() });
    const close = vi.fn();
    b.registration.getNotifications.mockResolvedValue([{ close }]);
    mocked.me.mockResolvedValue({ email: 'me@gmail.com' });
    mocked.thread.mockReturnValue(new Promise(() => {}));
    const router = createMemoryRouter(appRoutes(), { initialEntries: ['/settings'] });
    render(
      <QueryClientProvider client={client()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(mocked.pushSubscribe).toHaveBeenCalledWith(expect.objectContaining({ refresh: true })));
    b.message({ type: 'open', url: '/t/a%3A1' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/t/a%3A1'));
    await waitFor(() => expect(b.registration.getNotifications).toHaveBeenCalledWith({ tag: 'a:1' }));
    expect(close).toHaveBeenCalled();
  });
});
