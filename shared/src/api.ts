// SuperMail API contract — FROZEN after Task 1. Changing it needs a coordinator decision.
//
// Routes (each later task implements its own; listed here so web and server agree):
// GET /api/me → {email} | 401 · GET /auth/login · GET /auth/connect · GET /auth/google/callback ·
// POST /auth/logout · GET /api/accounts · DELETE /api/accounts/:id ·
// GET|POST /api/groups (POST body CreateGroupRequest) · GET /api/labels → GmailLabelDTO[] ·
// PATCH|DELETE /api/groups/:id · GET /api/threads?accountId&groupId&cursor&limit&includeDone → ThreadPage (includeDone=1 adds threads done in the last 30 days) ·
// GET /api/threads/:id → ThreadDetailDTO ·
// POST /api/threads/:id/{done,snooze,unsnooze,move,read,spam} → ActionResult
//   (bodies: snooze {until:number}, move {groupId}, read {read:boolean}; spam has thread: null) ·
// POST /api/teach → ActionResult · GET /api/teach/preview?threadId → TeachPreviewDTO · POST /api/undo/:undoId → ActionResult · POST /api/send → {threadId} ·
// GET /api/search?q → ThreadPage · GET /api/attachments/:accountId/:gmailMessageId/:attachmentId ·
// GET /api/skipped → ThreadPage · POST /api/skipped/:id/restore → ActionResult ·
// GET /api/filters → FilterDTO[] · GET /api/storage → StorageUsageDTO ·
// GET /api/spam → ThreadPage · GET /api/spam/:id → ThreadDetailDTO · POST /api/spam/:id/not-spam → ActionResult ·
// GET /api/events (SSE of ServerEvent) · GET /privacy.

export type ThreadId = string; // `${accountId}:${gmailThreadId}`
export type AccountStatus = 'syncing' | 'ok' | 'reconnect_needed';
export interface AccountDTO { id: string; email: string; color: string; status: AccountStatus }
export type GroupKind = 'builtin' | 'custom' | 'existing_label';
export interface GroupDTO { id: string; name: string; position: number; color: string; notify: boolean; kind: GroupKind; inboxCount: number; unreadCount: number }
export type ReasonSource = 'override' | 'rule' | 'existing_label' | 'mark' | 'heuristic' | 'default';
export interface GroupReasonDTO { source: ReasonSource; text: string; at: number | null }
export interface ThreadSummaryDTO { id: ThreadId; accountId: string; subject: string; snippet: string; fromName: string | null; fromEmail: string | null; lastMessageAt: number; unread: boolean; inInbox: boolean; groupId: string; groupName: string; reason: GroupReasonDTO; snoozedUntil: number | null; hasAttachments: boolean; suggestRule: boolean; doneAt?: number | null; listId?: string | null } // listId: lowercase, the id a teaching on the list matches
export interface AddressDTO { name: string | null; email: string }
export interface AttachmentDTO { attachmentId: string; filename: string; mimeType: string; size: number }
export interface MessageDTO { id: string; gmailMessageId: string; from: AddressDTO; to: AddressDTO[]; cc: AddressDTO[]; date: number; subject: string; html: string | null; text: string | null; attachments: AttachmentDTO[] }
export interface ThreadDetailDTO { thread: ThreadSummaryDTO; messages: MessageDTO[] }
export interface ThreadPage { threads: ThreadSummaryDTO[]; nextCursor: string | null }
export interface ActionResult { undoId: string; thread: ThreadSummaryDTO | null; affected?: number; skipped?: number } // affected: threads whose group changed, archived ones included; skipped: rows a bulk undo could not put back (a thread or group gone)
export type TeachAction = 'important' | 'not_important' | 'always_group';
export type MatchType = 'sender' | 'domain' | 'list';
export interface TeachRequest { threadId: ThreadId; action: TeachAction; scope: MatchType; groupId?: string }
export interface TeachScopeDTO { value: string; count: number } // count: inbox and snoozed threads that match now
export interface TeachPreviewDTO { subject: string; senderName: string | null; sender: TeachScopeDTO | null; domain: TeachScopeDTO | null; list: TeachScopeDTO | null } // domain is null for free-mail providers
export interface SendRequest { accountId: string; to: string[]; cc: string[]; bcc: string[]; subject: string; text: string; replyToThreadId?: ThreadId; replyToMessageId?: string; forward?: boolean }
export interface GmailLabelDTO { name: string; accountIds: string[] } // user labels across accounts, excluding SuperMail/*
export interface CreateGroupRequest { name: string; color?: string; existingLabelName?: string } // existingLabelName → kind 'existing_label', name defaults to the label name
export interface FilterDTO { accountId: string; filterId: string; criteria: string; hides: ('skip_inbox' | 'trash' | 'mark_read')[]; gmailSettingsUrl: string }
export interface StorageUsageDTO { bodyCacheMB: number; indexMB: number; logsMB: number; totalMB: number; diskFreeGB: number; limits: { bodyCacheMB: number; indexMB: number; logsMB: number; totalMB: number; minFreeDiskGB: number }; degraded: boolean }
export type ServerEvent =
  | { type: 'thread.updated'; thread: ThreadSummaryDTO }
  | { type: 'thread.removed'; id: ThreadId }
  | { type: 'groups.updated'; groups: GroupDTO[] }
  | { type: 'account.updated'; account: AccountDTO }
  | { type: 'storage.degraded'; degraded: boolean }
  | { type: 'bulk.settled'; undoId: string; affected: number; failed: ThreadId[]; skipped: ThreadId[] }; // a bulk action's Gmail writes are over: `affected` landed, `failed` were put back, `skipped` stood down on new mail and stay where they were
export const API_HEADER = 'x-supermail'; // non-GET /api requests must send `x-supermail: 1`

// Teaching list (Settings → Rules). GET /api/teaching → TeachingDTO[], newest first ·
// DELETE /api/teaching/:kind/:id → {ok:true}: removes it and reclassifies matching inbox and snoozed threads.
export interface TeachingDTO { id: string; kind: 'rule' | 'mark'; matchType: MatchType; matchValue: string; groupId: string | null; groupName: string | null; mark: 'important' | 'not_important' | null; createdAt: number; threadCount: number } // threadCount: inbox or snoozed threads that match now

// Spam. Read live from Gmail and never stored: the summaries and details below have no index row, so their ids only
// work on these routes. POST /api/threads/:id/spam → ActionResult (thread: null; undo puts it back) ·
// GET /api/spam → ThreadPage, every account merged newest first; an account that fails is left out, and if none can
// be read the route fails · GET /api/spam/:id → ThreadDetailDTO, 404 once it is out of spam ·
// POST /api/spam/:id/not-spam → ActionResult (undo moves it back to spam, thread: null).

// Bulk. POST /api/threads/bulk (BulkRequest) → BulkResult: the index and the screen change before it answers, and
// Gmail follows in the background, so `affected` is what was accepted and `failed` only what the index does not have.
// A thread Gmail then refuses is put back and named in the `bulk.settled` event, as is one that stands down because new
// mail reached it first. `until` goes with snooze, `groupId` with
// move. POST /api/teach/bulk (TeachBulkRequest) → BulkResult teaches each unique sender among `ids` (at most
// MAX_BULK_SENDERS). Either way one undo covers everything: POST /api/undo/:undoId → ActionResult (thread: null).
export const MAX_BULK_IDS = 1000;
export const MAX_BULK_SENDERS = 50;
export type BulkAction = 'done' | 'snooze' | 'read' | 'unread' | 'move' | 'spam';
export interface BulkRequest { ids: ThreadId[]; action: BulkAction; until?: number; groupId?: string }
export interface BulkResult { undoId: string; affected: number; failed: ThreadId[] }
export interface TeachBulkRequest { ids: ThreadId[]; action: TeachAction; groupId?: string }

// Push. All session guarded, writes need `x-supermail: 1`. GET /api/push/key → PushKeyDTO ·
// POST /api/push/subscribe (PushSubscribeRequest) → PushSubscribeResult · DELETE /api/push/subscribe ({endpoint}) → {ok:true} ·
// GET /api/push/devices → PushDeviceDTO[] · DELETE /api/push/devices/:id → {ok:true} ·
// POST /api/push/test ({endpoint}) → PushTestResult, 404 for an endpoint the server does not know.
// keysReset: the VAPID keys had to be replaced (a restore without secret.key), so every device must turn notifications on again.
export interface PushKeyDTO { publicKey: string; keysReset: boolean }
// refresh: the app checking in by itself, not the owner asking. It never brings back a device the owner removed: `removed` says so.
export interface PushSubscribeRequest { endpoint: string; keys: { p256dh: string; auth: string }; userAgent?: string; refresh?: boolean }
export interface PushSubscribeResult { ok: true; removed?: boolean }
export interface PushDeviceDTO { id: string; endpoint: string; userAgent: string | null; createdAt: number; lastOkAt: number | null }
// preview: only the mock has it: with no push service to go through, the app shows this itself.
export interface PushTestResult { ok: boolean; preview?: { title: string; body: string } }
// What the service worker receives. Encrypted for the device by the Web Push protocol, so the push service sees none of it.
export type PushPayload =
  | { type: 'mail'; threadId: ThreadId; title: string; body: string; accountLabel: string; group: string; sentAt: number }
  | { type: 'summary'; tag: string; title: string; body: string }
  | { type: 'test'; title: string; body: string }
  | { type: 'clear'; threadId: ThreadId }
  | { type: 'clear'; threadIds: ThreadId[] };
export const PUSH_DEVICE_HEADER = 'x-supermail-push'; // sent with Done and Snooze from a notification: that device's endpoint, which needs no clear push

/**
 * Short, unique labels for the merged inbox: the first word of the address ("you" for
 * you@example.com, "work" for work@example.com), the whole part before the @ if first words collide, and
 * local@domain if even those collide ("me@gmail", "me@example").
 */
export function accountLabels(accounts: { id: string; email: string }[]): Map<string, string> {
  const local = (e: string) => e.split('@')[0] ?? e;
  const word = (e: string) => local(e).split(/[._+-]/)[0] || local(e);
  const full = (e: string) => `${local(e)}@${(e.split('@')[1] ?? '').split('.')[0] ?? ''}`;
  const unique = (f: (e: string) => string) => new Set(accounts.map((a) => f(a.email))).size === accounts.length;
  const pick = unique(word) ? word : unique(local) ? local : full;
  return new Map(accounts.map((a) => [a.id, pick(a.email)]));
}
