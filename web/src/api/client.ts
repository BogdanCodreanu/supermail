import {
  API_HEADER,
  type AccountDTO,
  type ActionResult,
  type BulkRequest,
  type BulkResult,
  type CreateGroupRequest,
  type FilterDTO,
  type GmailLabelDTO,
  type GroupDTO,
  type PushDeviceDTO,
  type PushKeyDTO,
  type PushSubscribeRequest,
  type PushSubscribeResult,
  type PushTestResult,
  type SendRequest,
  type StorageUsageDTO,
  type TeachBulkRequest,
  type TeachingDTO,
  type TeachPreviewDTO,
  type TeachRequest,
  type ThreadDetailDTO,
  type ThreadId,
  type ThreadPage,
} from '@supermail/shared';

/** Typed fetch for every route in the Task 1 contract. */

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ThreadQuery { accountId?: string | null; groupId?: string | null; cursor?: string | null; limit?: number; includeDone?: boolean }
export type GroupPatch = Partial<Pick<GroupDTO, 'name' | 'position' | 'color' | 'notify'>>;

const enc = encodeURIComponent;

function withQuery(path: string, params: Record<string, string | number | null | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') headers[API_HEADER] = '1';
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    if (res.status === 401 && location.pathname !== '/login') location.assign('/login');
    const message = (data as { error?: unknown } | undefined)?.error;
    throw new ApiError(res.status, typeof message === 'string' ? message : `${method} ${path} failed (${res.status})`);
  }
  return data as T;
}

const get = <T>(path: string) => request<T>('GET', path);
const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body);
const threadAction = (id: ThreadId, action: string, body?: unknown) => post<ActionResult>(`/api/threads/${enc(id)}/${action}`, body);

export const api = {
  me: () => get<{ email: string }>('/api/me'),
  accounts: () => get<AccountDTO[]>('/api/accounts'),
  /** Groups with inbox counts; with an account id, the counts follow that account. */
  groups: (accountId?: string | null) => get<GroupDTO[]>(withQuery('/api/groups', { accountId })),
  threads: (q: ThreadQuery = {}) =>
    get<ThreadPage>(withQuery('/api/threads', { accountId: q.accountId, groupId: q.groupId, cursor: q.cursor, limit: q.limit, includeDone: q.includeDone ? 1 : null })),
  thread: (id: ThreadId) => get<ThreadDetailDTO>(`/api/threads/${enc(id)}`),
  done: (id: ThreadId) => threadAction(id, 'done'),
  snooze: (id: ThreadId, until: number) => threadAction(id, 'snooze', { until }),
  unsnooze: (id: ThreadId) => threadAction(id, 'unsnooze'),
  move: (id: ThreadId, groupId: string) => threadAction(id, 'move', { groupId }),
  read: (id: ThreadId, read: boolean) => threadAction(id, 'read', { read }),
  /** Many threads at once: the screen and the index change now, Gmail follows. */
  bulk: (r: BulkRequest) => post<BulkResult>('/api/threads/bulk', r),
  teach: (r: TeachRequest) => post<ActionResult>('/api/teach', r),
  /** Teaches every unique sender among `ids`, under one undo. */
  teachBulk: (r: TeachBulkRequest) => post<BulkResult>('/api/teach/bulk', r),
  /** What a teaching on this thread would reach, with counts. */
  teachPreview: (threadId: ThreadId) => get<TeachPreviewDTO>(withQuery('/api/teach/preview', { threadId })),
  undo: (undoId: string) => post<ActionResult>(`/api/undo/${enc(undoId)}`),
  send: (r: SendRequest) => post<{ threadId: ThreadId }>('/api/send', r),
  search: (q: string) => get<ThreadPage>(withQuery('/api/search', { q })),
  skipped: () => get<ThreadPage>('/api/skipped'),
  restore: (id: ThreadId) => post<ActionResult>(`/api/skipped/${enc(id)}/restore`),
  reportSpam: (id: ThreadId) => threadAction(id, 'spam'),
  /** Gmail's spam, read live: these threads are not in the index, so they have their own routes. */
  spam: (signal?: AbortSignal) => request<ThreadPage>('GET', '/api/spam', undefined, signal),
  spamThread: (id: ThreadId) => get<ThreadDetailDTO>(`/api/spam/${enc(id)}`),
  notSpam: (id: ThreadId) => post<ActionResult>(`/api/spam/${enc(id)}/not-spam`),
  filters: () => get<FilterDTO[]>('/api/filters'),
  storage: () => get<StorageUsageDTO>('/api/storage'),
  labels: () => get<GmailLabelDTO[]>('/api/labels'),
  createGroup: (r: CreateGroupRequest) => post<GroupDTO>('/api/groups', r),
  patchGroup: (id: string, p: GroupPatch) => request<GroupDTO>('PATCH', `/api/groups/${enc(id)}`, p),
  deleteGroup: (id: string) => request<void>('DELETE', `/api/groups/${enc(id)}`),
  removeAccount: (id: string) => request<void>('DELETE', `/api/accounts/${enc(id)}`),
  logout: () => post<void>('/auth/logout'),
  /** What the owner has taught, newest first. */
  teaching: () => get<TeachingDTO[]>('/api/teaching'),
  deleteTeaching: (kind: TeachingDTO['kind'], id: string) => request<void>('DELETE', `/api/teaching/${enc(kind)}/${enc(id)}`),
  pushKey: () => get<PushKeyDTO>('/api/push/key'),
  pushSubscribe: (r: PushSubscribeRequest) => post<PushSubscribeResult>('/api/push/subscribe', r),
  pushUnsubscribe: (endpoint: string) => request<void>('DELETE', '/api/push/subscribe', { endpoint }),
  pushDevices: () => get<PushDeviceDTO[]>('/api/push/devices'),
  removePushDevice: (id: string) => request<void>('DELETE', `/api/push/devices/${enc(id)}`),
  pushTest: (endpoint: string) => post<PushTestResult>('/api/push/test', { endpoint }),
};

/** Href for an attachment download (served by the attachment route, never cached on disk). */
/** `name` lets the server find the file if Gmail has since issued a new attachmentId; `download` forces a download. */
export function attachmentUrl(accountId: string, gmailMessageId: string, attachmentId: string, opts: { name?: string; download?: boolean } = {}): string {
  const q = new URLSearchParams();
  if (opts.name) q.set('name', opts.name);
  if (opts.download) q.set('download', '1');
  const qs = q.toString();
  return `/api/attachments/${enc(accountId)}/${enc(gmailMessageId)}/${enc(attachmentId)}${qs ? `?${qs}` : ''}`;
}

/**
 * TanStack Query keys shared by every view, so live server events can patch the right caches.
 * Thread lists are keyed by their filter only; pagination lives inside the query (infinite pages).
 */
export const qk = {
  me: () => ['me'] as const,
  accounts: () => ['accounts'] as const,
  groups: (accountId?: string | null) => ['groups', accountId ?? null] as const,
  threads: (q: Pick<ThreadQuery, 'accountId' | 'groupId' | 'includeDone'>) => ['threads', { accountId: q.accountId ?? null, groupId: q.groupId ?? null, includeDone: q.includeDone ?? false }] as const,
  thread: (id: ThreadId) => ['thread', id] as const,
  search: (q: string) => ['search', q] as const,
  skipped: () => ['skipped'] as const,
  spam: () => ['spam'] as const,
  spamThread: (id: ThreadId) => ['spamThread', id] as const,
  filters: () => ['filters'] as const,
  storage: () => ['storage'] as const,
  labels: () => ['labels'] as const,
  teaching: () => ['teaching'] as const,
  teachPreview: (threadId: ThreadId) => ['teach-preview', threadId] as const,
  pushStatus: () => ['push', 'status'] as const,
  pushDevices: () => ['push', 'devices'] as const,
};
