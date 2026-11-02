# SuperMail Day-One Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the day-one SuperMail described in spec §5. That means a merged multi-Gmail inbox
with learned groups as real Gmail labels, Done/snooze/undo, read/reply/compose/search, a
"Skipped your inbox" view, a keyboard UI with an always-visible cheat-sheet panel, and Home
Assistant add-on hosting behind a public HTTPS address (for example `https://mail.example.com`).

**Architecture:** There is one Node process, a Fastify server, which serves a JSON API, an SSE
stream and the built React app. SQLite holds the index and the owner's teaching, and Gmail stays
the source of truth. Every Gmail call goes through one `GmailApi` interface, so all server logic
is tested against an in-memory fake.

**Tech Stack:** Node 22, TypeScript 5, npm workspaces (`shared`, `server`, `web`), Fastify 5,
better-sqlite3, googleapis, nodemailer `MailComposer` (MIME only), chrono-node, vitest; React 18,
Vite 6, Tailwind 3, TanStack Query 5, TanStack Virtual 3, DOMPurify, @testing-library/react.

**Spec:** `docs/design/specs/2026-10-29-super-mail-design.md`. Read it before any task.

## Global Constraints

- Gmail is the source of truth. No email ever leaves the inbox without an explicit owner action
  (Done or snooze) or an owner rule. **No auto-archive, ever.**
- "Not important" means the **Low priority** group. It is never hidden or archived.
- Group labels: built-in groups map to Gmail labels named `SuperMail/<Group name>`. Unsorted has
  no label. Existing-label groups use the existing label in place and never rename it. Snoozed
  threads get `SuperMail/Snoozed`.
- Labels are written to Gmail for: new mail, threads currently in the inbox, and snoozed threads.
  Archived history is never bulk-relabelled.
- OAuth scopes are exactly `openid`, `https://www.googleapis.com/auth/userinfo.email` and
  `https://www.googleapis.com/auth/gmail.modify`. Do not add scopes.
- Redirect URIs: `<public URL>/auth/google/callback` (prod) and
  `http://localhost:8787/auth/google/callback` (dev). The port is `8787` in both.
- The OAuth client JSON is never committed, logged or printed. Dev path:
  `~/.config/super-mail/client_secret.json`. Add-on path: `/config/client_secret.json`.
- The Google Cloud OAuth app is unverified on purpose; never submit it for verification.
- Disk limits (defaults, all configurable): body cache 1024 MB, index 1024 MB, logs 50 MB,
  total `/data` 3072 MB, keep at least 20 GB free on the disk.
- Memory: `NODE_OPTIONS=--max-old-space-size=256`. Steady state stays under about 400 MB RSS.
- No external AI. Classification is deterministic.
- Sync polls `history.list` every 30 s per account. No Pub/Sub.
- The `/privacy` page is public. Everything else except `/auth/*` requires a session.
- Never touch the domain's MX records, or the existing blocks in the reverse proxy's Caddy
  config.
- Outward-facing steps (DNS change, Caddy change, add-on install on the server) need the owner's
  confirmation in chat at execution time.

## Review Focus

1. **Revoked or expired Google token (`invalid_grant`).** That account flips to
   `reconnect_needed`, other accounts keep syncing, and there is no crash loop. Test in Task 3.
2. **Server offline for days, so `history.list` returns 404.** A full resync of inbox plus 90 days
   without duplicate threads, keeping overrides, rules and snoozes. Test in Task 3.
3. **A reply arrives on a Done or snoozed thread.** The thread is back in the inbox and its snooze
   is cancelled. Its group is recomputed from the latest message not sent by the owner. Test in
   Task 5.
4. **The owner moves a snoozed thread back to the inbox, or archives it, in the Gmail app.** The
   scheduler does not re-archive or resurrect it, and the snooze row is cleared. Test in Task 5.
5. **Hostile or huge HTML email** (scripts, event handlers, forms, 5 MB+). It renders inert in a
   sandboxed iframe. Bodies over 2 MB are served but not cached. Test in Tasks 6 and 10b.

---

## Execution waves (for the coordinator)

Each task owns the files it lists, and workers never edit files owned by another task. The API
contract (`shared/src/api.ts`) is frozen after Task 1. Changing it needs a coordinator decision.

| Wave | Tasks (parallel within a wave) | Needs |
|---|---|---|
| 0 | 1 Foundation | — |
| 1 | 2 Auth & accounts · 3 Gmail & sync · 4 Classifier · 9 Web shell · 11 Add-on packaging | 1 |
| 2 | 5 Labels, actions, snooze · 6 Read, compose, search · 7 Storage limits | 2, 3, 4 |
| 3 | 8 Skipped & filters · 10a Inbox UI · 10b Thread & compose UI · 10c Settings, skipped, login UI | 5–7, 9 |
| 4 | 12 Deploy & owner acceptance | all |

**Shared files:** `server/src/main.ts` and `server/src/http/routes/index.ts` (the plugin list) are
append-only. Each task adds only its own wiring lines there, and the coordinator resolves trivial
merge conflicts.

Commands used throughout (from the repo root): `npm test -w server -- <file>`,
`npm test -w web -- <file>`, `npm run typecheck`, `npm run build`.

---

### Task 1: Foundation (repo, contract, config, database, app skeleton)

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.nvmrc` (`22`), extend `.gitignore` (`node_modules/`, `dist/`, `*.db*`, `.env*`)
- Create: `shared/package.json`, `shared/src/api.ts`
- Create: `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`
- Create: `server/src/config.ts`, `server/src/db/index.ts`, `server/src/db/migrations/001_init.sql`, `server/src/db/seed.ts`
- Create: `server/src/google/gmailApi.ts` (interface only), `server/src/events.ts`, `server/src/http/app.ts`, `server/src/http/routes/index.ts`, `server/src/main.ts`
- Create: `server/src/threads/queries.ts`
- Create: `web/package.json`, `web/vite.config.ts`, `web/index.html`, `web/src/main.tsx` (placeholder "SuperMail")
- Test: `server/test/config.test.ts`, `server/test/db.test.ts`, `server/test/app.test.ts`, `server/test/queries.test.ts`

**Interfaces — Produces:**

`shared/src/api.ts` (the frozen contract):
```ts
export type ThreadId = string; // `${accountId}:${gmailThreadId}`
export type AccountStatus = 'syncing' | 'ok' | 'reconnect_needed';
export interface AccountDTO { id: string; email: string; color: string; status: AccountStatus }
export type GroupKind = 'builtin' | 'custom' | 'existing_label';
export interface GroupDTO { id: string; name: string; position: number; color: string; notify: boolean; kind: GroupKind; inboxCount: number; unreadCount: number }
export type ReasonSource = 'override' | 'rule' | 'existing_label' | 'mark' | 'heuristic' | 'default';
export interface GroupReasonDTO { source: ReasonSource; text: string; at: number | null }
export interface ThreadSummaryDTO { id: ThreadId; accountId: string; subject: string; snippet: string; fromName: string | null; fromEmail: string | null; lastMessageAt: number; unread: boolean; inInbox: boolean; groupId: string; groupName: string; reason: GroupReasonDTO; snoozedUntil: number | null; hasAttachments: boolean; suggestRule: boolean }
export interface AddressDTO { name: string | null; email: string }
export interface AttachmentDTO { attachmentId: string; filename: string; mimeType: string; size: number }
export interface MessageDTO { id: string; gmailMessageId: string; from: AddressDTO; to: AddressDTO[]; cc: AddressDTO[]; date: number; subject: string; html: string | null; text: string | null; attachments: AttachmentDTO[] }
export interface ThreadDetailDTO { thread: ThreadSummaryDTO; messages: MessageDTO[] }
export interface ThreadPage { threads: ThreadSummaryDTO[]; nextCursor: string | null }
export interface ActionResult { undoId: string; thread: ThreadSummaryDTO | null }
export type TeachAction = 'important' | 'not_important' | 'always_group';
export type MatchType = 'sender' | 'domain' | 'list';
export interface TeachRequest { threadId: ThreadId; action: TeachAction; scope: MatchType; groupId?: string }
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
  | { type: 'storage.degraded'; degraded: boolean };
export const API_HEADER = 'x-supermail'; // non-GET /api requests must send `x-supermail: 1`
```

Routes (each later task implements its own; listed here so web and server agree):
`GET /api/me` → `{email}` | 401 · `GET /auth/login` · `GET /auth/connect` · `GET /auth/google/callback` · `POST /auth/logout` · `GET /api/accounts` · `DELETE /api/accounts/:id` · `GET|POST /api/groups` (POST body `CreateGroupRequest`) · `GET /api/labels` → `GmailLabelDTO[]` · `PATCH|DELETE /api/groups/:id` · `GET /api/threads?accountId&groupId&cursor&limit` → `ThreadPage` · `GET /api/threads/:id` → `ThreadDetailDTO` · `POST /api/threads/:id/{done,snooze,unsnooze,move,read}` → `ActionResult` (bodies: snooze `{until:number}`, move `{groupId}`, read `{read:boolean}`) · `POST /api/teach` → `ActionResult` · `POST /api/undo/:undoId` → `ActionResult` · `POST /api/send` → `{threadId}` · `GET /api/search?q` → `ThreadPage` · `GET /api/attachments/:accountId/:gmailMessageId/:attachmentId` · `GET /api/skipped` → `ThreadPage` · `POST /api/skipped/:id/restore` → `ActionResult` · `GET /api/filters` → `FilterDTO[]` · `GET /api/storage` → `StorageUsageDTO` · `GET /api/events` (SSE of `ServerEvent`) · `GET /privacy`.

`server/src/config.ts`:
```ts
export interface Limits { bodyCacheMB: number; indexMB: number; logsMB: number; totalMB: number; minFreeDiskGB: number }
export interface AppConfig { port: number; host: string; dataDir: string; publicUrl: string; ownerEmail: string; googleClientFile: string; pollSeconds: number; limits: Limits; secureCookies: boolean }
export function loadConfig(env: NodeJS.ProcessEnv, readFile?: (p: string) => string): AppConfig
```
If `/data/options.json` exists (add-on), read it: keys `owner_email, public_url, port, body_cache_mb, index_mb, logs_mb, total_mb, min_free_disk_gb`. Then dataDir is `/data`, the client file is `/config/client_secret.json`, host is `127.0.0.1` and `secureCookies` is true. Otherwise use dev env: `SUPERMAIL_DATA_DIR` (default `./.data`), `SUPERMAIL_PUBLIC_URL` (default `http://localhost:8787`), `SUPERMAIL_OWNER_EMAIL` (required), `SUPERMAIL_CLIENT_FILE` (default `~/.config/super-mail/client_secret.json`), host `127.0.0.1`, `secureCookies` false. Defaults are port 8787, pollSeconds 30, and limits 1024/1024/50/3072/20.

`server/src/db/index.ts`: `export type DB = Database.Database; export function openDb(file: string | ':memory:'): DB`. It sets WAL, `foreign_keys=ON`, runs every `migrations/*.sql` in order (tracked in `kv` key `schema_version`) and calls `seedGroups(db)`.

`server/src/db/seed.ts`: `export const BUILTIN_GROUPS` and `export function seedGroups(db: DB): void`, which is idempotent:

| builtin_key | name | position | color |
|---|---|---|---|
| important | Important | 0 | #dc2626 |
| money_security | Money & Security | 1 | #d97706 |
| dev | Dev | 2 | #4f46e5 |
| purchases | Purchases | 3 | #0891b2 |
| news | News | 4 | #16a34a |
| low_priority | Low priority | 5 | #64748b |
| unsorted | Unsorted | 6 | #9333ea |

`001_init.sql` creates exactly these tables. The column decisions are fixed; add indexes as needed:
```sql
CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE accounts(id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, color TEXT NOT NULL, token_enc BLOB, status TEXT NOT NULL DEFAULT 'syncing', history_id TEXT, backfill_page_token TEXT, backfill_done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE groups(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, position INTEGER NOT NULL, color TEXT NOT NULL, notify INTEGER NOT NULL DEFAULT 1, kind TEXT NOT NULL CHECK(kind IN ('builtin','custom','existing_label')), builtin_key TEXT UNIQUE, existing_label_name TEXT);
CREATE TABLE group_labels(group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, gmail_label_id TEXT NOT NULL, PRIMARY KEY(group_id, account_id));
CREATE TABLE threads(id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, gmail_thread_id TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', snippet TEXT NOT NULL DEFAULT '', from_name TEXT, from_email TEXT, last_message_at INTEGER NOT NULL, unread INTEGER NOT NULL DEFAULT 0, in_inbox INTEGER NOT NULL DEFAULT 0, is_sent_only INTEGER NOT NULL DEFAULT 0, has_attachments INTEGER NOT NULL DEFAULT 0, group_id TEXT REFERENCES groups(id) ON DELETE SET NULL, reason_source TEXT, reason_text TEXT, reason_at INTEGER, done_at INTEGER, last_accessed_at INTEGER, UNIQUE(account_id, gmail_thread_id));
CREATE TABLE messages(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, account_id TEXT NOT NULL, gmail_message_id TEXT NOT NULL, from_name TEXT, from_email TEXT, to_json TEXT NOT NULL DEFAULT '[]', cc_json TEXT NOT NULL DEFAULT '[]', subject TEXT NOT NULL DEFAULT '', snippet TEXT NOT NULL DEFAULT '', date INTEGER NOT NULL, label_ids_json TEXT NOT NULL DEFAULT '[]', list_id TEXT, has_list_unsubscribe INTEGER NOT NULL DEFAULT 0, rfc822_message_id TEXT, references_hdr TEXT, size_estimate INTEGER NOT NULL DEFAULT 0, UNIQUE(account_id, gmail_message_id));
CREATE TABLE body_cache(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, html TEXT, text TEXT, attachments_json TEXT NOT NULL DEFAULT '[]', bytes INTEGER NOT NULL, last_accessed_at INTEGER NOT NULL);
CREATE TABLE rules(id TEXT PRIMARY KEY, match_type TEXT NOT NULL CHECK(match_type IN ('sender','domain','list')), match_value TEXT NOT NULL, group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, UNIQUE(match_type, match_value));
CREATE TABLE sender_marks(id TEXT PRIMARY KEY, match_type TEXT NOT NULL CHECK(match_type IN ('sender','domain','list')), match_value TEXT NOT NULL, mark TEXT NOT NULL CHECK(mark IN ('important','not_important')), created_at INTEGER NOT NULL, UNIQUE(match_type, match_value));
CREATE TABLE overrides(thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE, group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE, source TEXT NOT NULL CHECK(source IN ('app','gmail')), created_at INTEGER NOT NULL, suggest_rule INTEGER NOT NULL DEFAULT 0);
CREATE TABLE snoozes(thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE, until INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE label_writes(id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, gmail_thread_id TEXT NOT NULL, added_json TEXT NOT NULL, removed_json TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE undo(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL);
```
Reminders and push subscriptions are later-batch tables. Do not create them.

`server/src/google/gmailApi.ts` is the interface only (Task 3 implements it):
```ts
import type { gmail_v1 } from 'googleapis';
export interface GmailApi {
  getProfile(): Promise<{ emailAddress: string; historyId: string }>;
  listThreads(p: { q?: string; labelIds?: string[]; pageToken?: string; maxResults?: number }): Promise<{ ids: string[]; nextPageToken?: string }>;
  getThread(id: string, format: 'metadata' | 'full'): Promise<gmail_v1.Schema$Thread>;
  listHistory(startHistoryId: string, pageToken?: string): Promise<{ history: gmail_v1.Schema$History[]; historyId: string; nextPageToken?: string }>; // throws GmailHistoryExpired on 404
  modifyThread(id: string, add: string[], remove: string[]): Promise<void>;
  listLabels(): Promise<{ id: string; name: string; type: 'system' | 'user' }[]>;
  createLabel(name: string): Promise<{ id: string; name: string }>; // throws GmailLabelExists on 409
  sendRaw(rawBase64Url: string, threadId?: string): Promise<{ id: string; threadId: string }>;
  getAttachment(messageId: string, attachmentId: string): Promise<Buffer>;
  listFilters(): Promise<gmail_v1.Schema$Filter[]>;
}
export class GmailHistoryExpired extends Error {}
export class GmailLabelExists extends Error {}
export class GmailAuthRevoked extends Error {} // invalid_grant / 401 after refresh
export const METADATA_HEADERS = ['From','To','Cc','Subject','Date','List-Id','List-Unsubscribe','Message-ID','In-Reply-To','References'];
```

`server/src/threads/queries.ts` (pure SQL over the schema):
```ts
export function toSummary(db: DB, threadId: ThreadId): ThreadSummaryDTO; // group_id NULL → Unsorted with reason {source:'default', text:'Unsorted: no confident match (automatic guess)', at:null}; suggestRule from overrides.suggest_rule; snoozedUntil from snoozes
export function listInbox(db: DB, q: { accountId?: string; groupId?: string; cursor?: string; limit?: number }): ThreadPage; // in_inbox=1, order last_message_at desc; cursor `${lastMessageAt}:${id}`; limit default 50, max 200
export function groupCounts(db: DB, accountId?: string): GroupDTO[]; // ordered by position
```

`server/src/events.ts`: `export const bus: { publish(e: ServerEvent): void; subscribe(fn: (e: ServerEvent) => void): () => void }`.

`server/src/http/app.ts`:
```ts
export type ThreadHook = (threadId: string, reason: 'new' | 'changed') => void;
export interface StorageGate { canIndexMore(): boolean; canCacheBodies(): boolean }
export interface AppDeps { db: DB; config: AppConfig; gmailFor: (accountId: string) => GmailApi; now: () => number; onThreadChange: ThreadHook; storage: StorageGate }
export const ALLOW_ALL: StorageGate; // both true; replaced by Task 7 in main.ts
export const NOOP_HOOK: ThreadHook;  // replaced by Task 5 in main.ts
export type RoutePlugin = (app: FastifyInstance, deps: AppDeps) => Promise<void>;
export async function buildApp(deps: AppDeps, plugins: RoutePlugin[]): Promise<FastifyInstance>
```
It registers: JSON errors as `{error:string}`, the `x-supermail: 1` check on non-GET `/api/*` (otherwise 403), static `web/dist` with SPA fallback for non-`/api`/`/auth` paths, and `GET /api/events` as SSE fed by `bus`, with a heartbeat comment every 25 s. Session enforcement is a `preHandler` that Task 2 provides and `main.ts` wires in. `main.ts` loads config, opens `${dataDir}/supermail.db`, builds the app with every task's plugin and listens on `config.host:config.port`.

- [ ] **Step 1: Write failing tests**
  - `config.test.ts`: `loadConfig` with an options.json containing `{owner_email:'o@x.com', public_url:'https://mail.example.com', port:8787, body_cache_mb:1024, index_mb:1024, logs_mb:50, total_mb:3072, min_free_disk_gb:20}` returns `dataDir:'/data'`, `googleClientFile:'/config/client_secret.json'`, `secureCookies:true`, `limits.totalMB:3072`. Dev env without `SUPERMAIL_OWNER_EMAIL` throws `/SUPERMAIL_OWNER_EMAIL/`.
  - `db.test.ts`: `openDb(':memory:')` creates all 15 tables listed above; the `groups` table has 7 rows whose names and positions match the seed table; calling `seedGroups` twice still gives 7 rows; deleting an account cascades to its threads and messages.
  - `queries.test.ts`: with 3 inserted inbox threads, `listInbox({limit:2})` returns the newest 2 and a `nextCursor`, and the next page returns the 3rd with no duplicates; `groupId`/`accountId` filters apply; a thread with `group_id` NULL summarizes as Unsorted with source `default`; `groupCounts` returns 7 groups in seed order with correct `inboxCount`.
  - `app.test.ts`: `POST /api/anything` without the header returns 403; `GET /nonexistent-page` returns `index.html` (SPA fallback); `GET /api/events` responds with `content-type: text/event-stream` and delivers an event published on `bus`.
- [ ] **Step 2: Run** `npm test -w server` → FAIL (modules missing).
- [ ] **Step 3: Implement** the files above. Root `package.json` has scripts `test` (runs both workspaces), `typecheck` (`tsc -b`) and `build` (`npm run build -w web && npm run build -w server`). The server build emits `server/dist` with tsc and copies `migrations/*.sql`.
- [ ] **Step 4: Run** `npm test -w server && npm run typecheck && npm run build` → all PASS. `web/dist/index.html` exists.
- [ ] **Step 5: Commit** `feat: foundation — contract, config, schema, app skeleton`.

---

### Task 2: Token crypto, app sign-in, account connect

**Files:**
- Create: `server/src/crypto/tokens.ts`, `server/src/google/oauth.ts`, `server/src/auth/sessions.ts`, `server/src/accounts/accounts.ts`, `server/src/http/routes/auth.ts`, `server/src/http/routes/accounts.ts`, `server/src/http/routes/privacy.ts`
- Test: `server/test/tokens.test.ts`, `server/test/auth.test.ts`, `server/test/accounts.test.ts`

**Interfaces:**
- Consumes: `DB`, `AppConfig`, `RoutePlugin`, `AccountDTO`, `bus`.
- Produces:
```ts
// crypto/tokens.ts
export function loadOrCreateKey(dataDir: string): Buffer; // `${dataDir}/secret.key`, 32 random bytes, mode 0600
export function encrypt(key: Buffer, plaintext: string): Buffer; // AES-256-GCM: iv(12)|tag(16)|ciphertext
export function decrypt(key: Buffer, blob: Buffer): string; // throws TokenDecryptError
export class TokenDecryptError extends Error {}
// google/oauth.ts
export const LOGIN_SCOPES = ['openid', 'https://www.googleapis.com/auth/userinfo.email'];
export const CONNECT_SCOPES = [...LOGIN_SCOPES, 'https://www.googleapis.com/auth/gmail.modify'];
export function readClientFile(path: string): { clientId: string; clientSecret: string }; // reads `web` key of Google JSON
export function oauthClient(cfg: AppConfig): OAuth2Client; // redirect `${publicUrl}/auth/google/callback`
// auth/sessions.ts
export const SESSION_COOKIE = 'sm_session'; export const SESSION_DAYS = 90;
export function createSession(db: DB, email: string, now: number): string; // returns raw token; stores sha256
export function sessionEmail(db: DB, rawToken: string | undefined, now: number): string | null;
export function isAllowedEmail(db: DB, cfg: AppConfig, email: string): boolean; // ownerEmail OR any accounts.email (case-insensitive)
export function requireSession(db: DB, cfg: AppConfig): preHandlerHookHandler; // 401 for /api/*, redirect to /login otherwise; skips /auth/*, /privacy, static assets
// accounts/accounts.ts
export const ACCOUNT_COLORS = ['#2563eb','#16a34a','#d97706','#9333ea','#db2777','#0891b2'];
export function upsertAccount(db: DB, key: Buffer, email: string, refreshToken: string, now: number): AccountDTO; // new → next color, status 'syncing'; existing → replace token, status 'syncing', history_id NULL (the next poller tick resyncs it)
export function listAccounts(db: DB): AccountDTO[];
export function getRefreshToken(db: DB, key: Buffer, accountId: string): string; // on TokenDecryptError: sets status 'reconnect_needed', publishes account.updated, rethrows
export function removeAccount(db: DB, accountId: string): void; // cascades index, cache, labels map
export function setAccountStatus(db: DB, accountId: string, status: AccountStatus): void;
```
- Routes: `GET /auth/login` and `GET /auth/connect` redirect to Google with a `state` that is random and stored in a 10-minute httpOnly cookie `sm_oauth_state`, plus a mode. Connect uses `access_type=offline` and `prompt=consent` and requires a session. The `/auth/google/callback` checks state, exchanges the code and verifies the `id_token` email. Login mode only succeeds if `isAllowedEmail`; it sets the session cookie (httpOnly, SameSite=Lax, Secure when `secureCookies`) and redirects to `/`. Connect mode calls `upsertAccount` and redirects to `/?connected=<email>`. `POST /auth/logout` deletes the session. `GET /api/me` and `GET`/`DELETE /api/accounts` are served too. `GET /privacy` is static HTML, about 120 words: it says SuperMail is a single-owner, self-hosted client, that Gmail data stays on the owner's server and in Google, that nothing is shared with third parties, and that access can be revoked at myaccount.google.com/permissions.

- [ ] **Step 1: Write failing tests**
  - `tokens.test.ts`: `decrypt(key, encrypt(key, 'rt-123')) === 'rt-123'`; decrypting with a different key throws `TokenDecryptError`; `loadOrCreateKey` twice on the same dir returns identical bytes and the file mode is `0o600`.
  - `auth.test.ts` (Google token exchange stubbed by injecting `exchangeCode` into the route plugin): login with `stranger@x.com` → 403 and no cookie; login with the owner email → 302 to `/` with an `sm_session` cookie; a callback with a mismatched state → 400; `GET /api/accounts` without a cookie → 401; `GET /privacy` without a cookie → 200.
  - `accounts.test.ts`: the first two accounts get `#2563eb` then `#16a34a`; upserting the same email twice gives one row with the token replaced; once an account is connected, its email passes `isAllowedEmail`; a corrupted `token_enc` makes `getRefreshToken` throw and sets status `reconnect_needed`.
- [ ] **Step 2: Run** `npm test -w server -- tokens auth accounts` → FAIL.
- [ ] **Step 3: Implement** the files above, plus the `main.ts` wiring: the `requireSession` preHandler, and the auth/accounts/privacy plugins in `routes/index.ts`. Use `crypto.randomBytes`, `createCipheriv('aes-256-gcm')` and `OAuth2Client.verifyIdToken`. Never log tokens: add a Fastify serializer that strips `code`, `token` and `refresh_token`.
- [ ] **Step 4: Run** the tests → PASS.
- [ ] **Step 5: Commit** `feat: token crypto, owner-only sign-in, Gmail account connect`.

---

### Task 3: Gmail client, fake, initial sync, history poller

**Files:**
- Create: `server/src/google/gmailClient.ts`, `server/src/google/parse.ts`, `server/src/sync/indexer.ts`, `server/src/sync/initialSync.ts`, `server/src/sync/poller.ts`, `server/test/fakes/fakeGmail.ts`, `server/test/fixtures/threads.ts`
- Test: `server/test/parse.test.ts`, `server/test/sync.test.ts`, `server/test/poller.test.ts`

**Interfaces:**
- Consumes: `GmailApi` and its error classes, `getRefreshToken`, `setAccountStatus`, `bus`.
- Produces:
```ts
// google/gmailClient.ts
export function createGmailApi(auth: OAuth2Client): GmailApi; // maps 404 history → GmailHistoryExpired, 409 label → GmailLabelExists, invalid_grant/401 → GmailAuthRevoked; concurrency limit 5 per account
export function gmailForFactory(db: DB, cfg: AppConfig, key: Buffer): (accountId: string) => GmailApi; // caches clients per account
// google/parse.ts
export interface ParsedMessage { gmailMessageId: string; gmailThreadId: string; from: AddressDTO; to: AddressDTO[]; cc: AddressDTO[]; subject: string; snippet: string; date: number; labelIds: string[]; listId: string | null; hasListUnsubscribe: boolean; rfc822MessageId: string | null; references: string | null; sizeEstimate: number; hasAttachments: boolean }
export function parseMessage(m: gmail_v1.Schema$Message): ParsedMessage; // listId lowercased, angle brackets stripped
// sync/indexer.ts — ThreadHook is the type from http/app.ts (Task 1); Task 5 supplies the real hook
export function indexThread(db: DB, accountId: string, t: gmail_v1.Schema$Thread, ownEmails: Set<string>, onChange?: ThreadHook): ThreadId;
// upserts thread + messages; in_inbox = any message has INBOX; unread = any UNREAD; is_sent_only = all messages SENT; from_* = latest message not from ownEmails (fallback latest); clears snoozes row and done_at when a new non-own message arrives after done_at/snooze creation (Review Focus 3)
export function removeThread(db: DB, accountId: string, gmailThreadId: string): void;
// sync/initialSync.ts
export async function initialSync(db: DB, accountId: string, gmail: GmailApi, onChange?: ThreadHook): Promise<void>; // getProfile → store history_id first; index `in:inbox` (all pages) then `newer_than:90d` (all pages), metadata format; status → 'ok'
export async function backfillStep(db: DB, accountId: string, gmail: GmailApi, canIndexMore: () => boolean): Promise<boolean>; // one page of 100 older threads (`older_than:90d`), resumes from accounts.backfill_page_token; returns false when done or !canIndexMore()
// sync/poller.ts
export interface Poller { start(): void; stop(): void; tick(): Promise<void> }
export function createPoller(deps: { db: DB; gmailFor: (id: string) => GmailApi; intervalMs: number; onChange?: ThreadHook; canIndexMore?: () => boolean; onAfterTick?: () => void }): Poller;
// each tick, per account: status 'syncing' with history_id NULL (just connected or reconnected) → initialSync first; then history; then, if !backfill_done && canIndexMore(), one backfillStep (≈100 threads per 30 s)
// per account: listHistory(history_id) → collect touched thread ids → re-fetch each (metadata) → indexThread / removeThread (404 thread or deleted); save new history_id; GmailHistoryExpired → initialSync again; GmailAuthRevoked → status 'reconnect_needed', skip account until reconnect; other errors logged, retried next tick. One account's failure never blocks others.
```
`fakeGmail.ts`: `export function createFakeGmail(email: string): GmailApi & { addThread(t: FakeThread): void; deliver(threadId: string, msg: FakeMessage): void; setLabels(threadId: string, add: string[], remove: string[], viaApp?: boolean): void; expireHistory(): void; revoke(): void; calls: { modifyThread: [string, string[], string[]][]; sendRaw: string[]; createLabel: string[] } }`. It keeps an incrementing historyId and a history log, and supports `q` for `in:inbox`, `newer_than:Nd`, `older_than:Nd` and `-in:inbox -in:sent newer_than:30d`. Fixtures in `fixtures/threads.ts` cover the spec's typical cases (a bookstore's security incident with List-Id, Google "Security alert", GitHub notifications, Vercel failed deployment, a course newsletter, Bolt receipt, a personal email from a human, an Alibaba promo with `CATEGORY_PROMOTIONS`).

- [ ] **Step 1: Write failing tests**
  - `parse.test.ts`: `From: "Bolt" <receipts@bolt.eu>` → `{name:'Bolt', email:'receipts@bolt.eu'}`; `List-Id: Ground News <daily.ground.news>` → `listId 'daily.ground.news'`; the `Date` header is parsed to epoch ms; `hasAttachments` is true when any part has `filename`.
  - `sync.test.ts`: a freshly connected account (status `syncing`, no history_id) gets `initialSync` on the first `tick()`; after `initialSync`, inbox fixtures have `in_inbox=1`, the account has `history_id` set and status `ok`; running `initialSync` twice gives the same thread count (no duplicates); `backfillStep` with `canIndexMore` returning false indexes nothing.
  - `poller.test.ts`: `deliver()` a new message, then `tick()` indexes the thread and publishes `thread.updated`. **Review Focus 1:** account A `revoke()` makes A `reconnect_needed` while account B still indexes new mail in the same tick, and a second tick makes no calls for A. **Review Focus 2:** after `expireHistory()`, `tick()` runs a full resync, the thread count is unchanged, and an existing `overrides` row and `snoozes` row survive. **Review Focus 3 (index part):** for a thread with `done_at` set, delivering a reply from another sender clears `done_at`, deletes its `snoozes` row and sets `in_inbox=1`.
- [ ] **Step 2: Run** `npm test -w server -- parse sync poller` → FAIL.
- [ ] **Step 3: Implement** with `google.gmail({version:'v1', auth})`, `format:'metadata'` and `metadataHeaders: METADATA_HEADERS`.
- [ ] **Step 4: Run** the tests → PASS.
- [ ] **Step 5: Commit** `feat: Gmail client, indexer, initial sync and history poller`.

---

### Task 4: Classifier (pure)

**Files:**
- Create: `server/src/classify/heuristics.ts`, `server/src/classify/resolve.ts`
- Test: `server/test/classify.test.ts`

**Interfaces — Produces:**
```ts
export interface ClassifyInput { fromEmail: string | null; listId: string | null; labelIds: string[]; subject: string; snippet: string; hasListUnsubscribe: boolean }
export interface Rule { matchType: MatchType; matchValue: string; groupId: string; createdAt: number }
export interface Mark { matchType: MatchType; matchValue: string; mark: 'important' | 'not_important'; createdAt: number }
export interface Override { groupId: string; source: 'app' | 'gmail'; createdAt: number }
export interface GroupRef { id: string; name: string; builtinKey: string | null; kind: GroupKind; labelIdsByAccount: Map<string, string> }
export function heuristicGroupKey(i: ClassifyInput): { key: 'important' | 'money_security' | 'dev' | 'purchases' | 'news' | 'low_priority' | 'unsorted'; why: string };
export function resolveGroup(i: ClassifyInput & { accountId: string }, t: { override?: Override; rules: Rule[]; marks: Mark[] }, groups: GroupRef[]): { groupId: string; reason: GroupReasonDTO };
export function matchKeys(i: ClassifyInput): { sender: string | null; domain: string | null; list: string | null }; // lowercased; domain = part after @
```
**Precedence (decided):** override, then rule, then existing label, then mark, then heuristic. Within rules and marks, `sender` beats `list`, which beats `domain`. An existing label means the message carries a Gmail label mapped to a group of kind `existing_label` for that account. A mark `important` maps to the Important group and `not_important` to Low priority. Reason texts: `In {Group} because you said so on {d MMM}` (override/rule/mark, en-GB date), `In {Group}: has your Gmail label "{name}"`, `In {Group}: {why} (automatic guess)`, `Unsorted: no confident match (automatic guess)`.

**Heuristic order (first match wins; the safety intent is that money and security are checked first):**

| # | Condition (case-insensitive) | Key |
|---|---|---|
| 1 | domain in `accounts.google.com, revolut.com, ing.ro, ing.com, xtb.com, tastytrade.com, nn.ro, zen.com, paypal.com, wise.com, bt.ro, raiffeisen.ro` **or** subject/snippet matches `security alert|sign-in|signin|fraud|frauda|incident de securitate|password|parola|statement|extras de cont|pensie|invoice|factura` | money_security |
| 2 | domain in `github.com, vercel.com, gitlab.com, fly.io, sentry.io, cloudflare.com, amazonaws.com, npmjs.com, docker.com, coderabbit.ai` | dev |
| 3 | subject/snippet matches `order|comanda|receipt|bon fiscal|shipping|livrare|delivered|your ride|rezervare|booking confirmed` | purchases |
| 4 | `CATEGORY_PROMOTIONS` or `CATEGORY_SOCIAL` in labelIds | low_priority |
| 5 | `listId` present or `hasListUnsubscribe` | news |
| 6 | `CATEGORY_PERSONAL` (or no CATEGORY_* label), no list headers, sender local part not matching `no-?reply|notifications?|mailer|newsletter|info|team|support` | important |
| 7 | otherwise | unsorted |

- [ ] **Step 1: Write failing tests** (table-driven, `it.each`): a bookstore's `Informare incident de securitate` with a List-Id → money_security (it is not news); `no-reply@accounts.google.com` "Security alert" → money_security; `notifications@github.com` → dev; Vercel "Failed deployment" → dev; `receipts@bolt.eu` "Your Bolt Scooter ride" → purchases; Alibaba with `CATEGORY_PROMOTIONS` → low_priority; a course newsletter with List-Unsubscribe → news; `sam@carter.example` personal → important; `info@shop.ro` with no headers → unsorted. For `resolveGroup`: an override beats a rule; a sender rule beats a domain rule; a `not_important` mark on `alibaba.com` → Low priority with reason source `mark`; an existing-label group wins over a mark; the reason text for a rule created 2026-10-28 is exactly `In Dev because you said so on 28 Oct`.
- [ ] **Step 2: Run** `npm test -w server -- classify` → FAIL.
- [ ] **Step 3: Implement** both files as pure functions with no DB access.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: deterministic classifier with owner-teaching precedence`.

---

### Task 5: Labels, actions, teaching, snooze scheduler, undo, two-way overrides

**Files:**
- Create: `server/src/labels/labelWriter.ts`, `server/src/threads/classifyThread.ts`, `server/src/actions/actions.ts`, `server/src/actions/undo.ts`, `server/src/scheduler/snoozeScheduler.ts`, `server/src/http/routes/threads.ts`, `server/src/http/routes/groups.ts`
- Test: `server/test/labels.test.ts`, `server/test/actions.test.ts`, `server/test/snooze.test.ts`, `server/test/twoWay.test.ts`, `server/test/threadsRoutes.test.ts`

**Interfaces:**
- Consumes: `resolveGroup`, `matchKeys`, `GroupRef` (Task 4); `indexThread`, the poller (Task 3); `toSummary`, `listInbox`, `groupCounts`, `ThreadHook`, `AppDeps` (Task 1); `GmailApi`, `bus`.
- Produces:
```ts
// labels/labelWriter.ts
export const SNOOZED_LABEL = 'SuperMail/Snoozed';
export function groupLabelName(g: GroupRef): string | null; // builtin/custom → `SuperMail/${name}`; existing_label → existing_label_name; unsorted → null
export async function ensureLabel(db: DB, gmail: GmailApi, accountId: string, groupId: string): Promise<string | null>; // cache in group_labels; on GmailLabelExists → listLabels and reuse by name
export async function applyThreadLabels(db: DB, gmail: GmailApi, threadId: ThreadId, opts: { snoozed?: boolean }): Promise<void>; // add the current group's label, remove other SuperMail group labels; never touches INBOX; logs label_writes; only when thread in_inbox or snoozed or new
export function wasWrittenByUs(db: DB, accountId: string, gmailThreadId: string, labelId: string, now: number): boolean; // label_writes within 120 s
// threads/classifyThread.ts
export function makeThreadHook(deps: { db: DB; gmailFor: (id: string) => GmailApi; now: () => number }): ThreadHook; // recompute group from the latest non-own message, persist group+reason, applyThreadLabels, publish thread.updated + groups.updated
// actions/actions.ts (each returns ActionResult and records an undo row)
export async function done(d: AppDeps, threadId: ThreadId): Promise<ActionResult>; // modifyThread remove INBOX (+ SNOOZED_LABEL), done_at=now, delete snoozes
export async function snooze(d: AppDeps, threadId: ThreadId, until: number): Promise<ActionResult>; // until must be > now+60s else 400; remove INBOX, add SNOOZED_LABEL, snoozes row
export async function unsnooze(d: AppDeps, threadId: ThreadId): Promise<ActionResult>;
export async function moveToGroup(d: AppDeps, threadId: ThreadId, groupId: string): Promise<ActionResult>; // override source 'app'
export async function setRead(d: AppDeps, threadId: ThreadId, read: boolean): Promise<ActionResult>;
export async function teach(d: AppDeps, r: TeachRequest): Promise<ActionResult>; // always_group → rules upsert; important/not_important → sender_marks upsert; then reclassify every thread from that sender/domain/list that is in_inbox or snoozed (relabel those only)
// actions/undo.ts
export const UNDO_TTL_MS = 5 * 60_000;
export function recordUndo(db: DB, threadId: ThreadId, kind: string, payload: unknown, now: number): string; // used by Task 8 too
export async function undo(d: AppDeps, undoId: string): Promise<ActionResult>; // inverse of done/snooze/unsnooze/move/read/teach; 410 if expired
// scheduler/snoozeScheduler.ts
export function createSnoozeScheduler(d: AppDeps, intervalMs?: number /* 30_000 */): { start(): void; stop(): void; runDue(): Promise<number> }; // due rows: add INBOX, remove SNOOZED_LABEL, delete row, bump thread to top (last_accessed_at), publish; runDue() also called once at startup
```
- Two-way (inside `makeThreadHook`): if a thread now has a group label that differs from its stored group and `wasWrittenByUs` is false, write `overrides(source='gmail', suggest_rule=1)` and do not revert it. If the owner removed `SNOOZED_LABEL` or added INBOX in Gmail while a snooze row exists, delete the row (Review Focus 4). A thread that has a snooze row but no INBOX and no SNOOZED_LABEL (archived in Gmail) also has its row deleted.
- Routes implement every `/api/threads*` entry except `GET /api/threads/:id` (Task 6), plus `/api/teach`, `/api/undo/:id`, `/api/groups*` and `/api/labels` from Task 1. `GET /api/threads` uses `listInbox`. `DELETE` on a builtin group → 400. For `POST /api/groups` with `existingLabelName`, `ensureLabel` resolves the label by name per account and never renames it. It creates the label in another account only when a thread from that account is routed to the group. Deleting a custom group moves its threads to reclassification.
- `main.ts` wiring: `deps.onThreadChange = makeThreadHook(...)`, passed to the poller; start the scheduler.

- [ ] **Step 1: Write failing tests**
  - `labels.test.ts`: a thread classified Dev gets `modifyThread(id, ['<Dev label id>'], [])` and a `label_writes` row; reclassifying to News removes Dev and adds News; Unsorted adds nothing; when `SuperMail/Dev` already exists in the fake (createLabel → `GmailLabelExists`), the existing id is reused and only one label exists; an archived thread from backfill (`in_inbox=0`, not new) gets **no** `modifyThread` call.
  - `actions.test.ts`: `done` removes INBOX, the summary has `inInbox:false`, and `undo` restores INBOX; `teach({action:'not_important', scope:'domain'})` on an Alibaba thread moves **all** inbox threads from `alibaba.com` to Low priority, and an archived Alibaba thread keeps its labels untouched; `teach always_group` creates a rule and the reason text starts `In <Group> because you said so on`; snooze with `until` in the past → 400.
  - `snooze.test.ts`: a due snooze → `runDue()` returns 1, INBOX is added and SNOOZED_LABEL removed; a snooze due while the scheduler was stopped is restored by the first `runDue()` after `start()`. **Review Focus 3:** a reply delivered to a snoozed thread → after poller tick the snooze row is gone and the thread is in the inbox. **Review Focus 4:** the owner adds INBOX in Gmail (fake `setLabels`) → after the tick the row is gone, and a later `runDue()` makes no `modifyThread` call for it.
  - `twoWay.test.ts`: the owner moves a thread from `SuperMail/News` to `SuperMail/Dev` in Gmail → an override with source `gmail`, `suggestRule:true` in the summary, and no reverting `modifyThread`; a label change we wrote ourselves 5 s earlier is not treated as an override.
  - `threadsRoutes.test.ts`: `POST /api/groups {existingLabelName:'Legal - Example Studio SRL'}` creates a group of kind `existing_label`, a thread carrying that label resolves into it, and no `createLabel` call is made for the account that already has it; `GET /api/threads?groupId=<dev>` returns only Dev inbox threads newest first; with `accountId`, only that account; pagination with `limit=2` returns `nextCursor` and no duplicates across pages.
- [ ] **Step 2: Run** `npm test -w server -- labels actions snooze twoWay threadsRoutes` → FAIL.
- [ ] **Step 3: Implement** the files above and the wiring in `main.ts`.
- [ ] **Step 4: Run** `npm test -w server` (full suite) → PASS.
- [ ] **Step 5: Commit** `feat: Gmail labels, Done/snooze/undo, teaching, two-way overrides`.

---

### Task 6: Read, render, compose, send, search, attachments

**Files:**
- Create: `server/src/mail/bodies.ts`, `server/src/mail/compose.ts`, `server/src/mail/search.ts`, `server/src/http/routes/mail.ts`
- Test: `server/test/bodies.test.ts`, `server/test/compose.test.ts`, `server/test/search.test.ts`

**Interfaces:**
- Consumes: `GmailApi`, `toSummary` (Task 1), `indexThread` (Task 3), `deps.onThreadChange`, `deps.storage.canCacheBodies()`.
- Produces:
```ts
export const MAX_CACHED_BODY_BYTES = 2 * 1024 * 1024;
export async function getThreadDetail(d: AppDeps, threadId: ThreadId): Promise<ThreadDetailDTO>; // per message: body_cache hit, else getThread(full) → extract text/html (prefer html), attachments; cache if bytes <= MAX_CACHED_BODY_BYTES and deps.storage.canCacheBodies(); update last_accessed_at
export function buildRaw(r: SendRequest, from: AddressDTO, reply?: { rfc822MessageId: string; references: string | null; subject: string; quotedText: string }): Promise<string>; // MailComposer → base64url; reply sets In-Reply-To/References, subject `Re: ` once; forward subject `Fwd: ` + quoted original
export async function send(d: AppDeps, r: SendRequest): Promise<{ threadId: ThreadId }>; // sendRaw with gmail threadId on replies; reindex thread
export async function search(d: AppDeps, q: string): Promise<ThreadPage>; // every ok account in parallel, listThreads({q, maxResults:25}), index unknown ids (metadata, no label writes), merge by lastMessageAt desc
```
Routes: `GET /api/threads/:id` (detail only; the client marks it read with `api.read`), `POST /api/send`, `GET /api/search`, and `GET /api/attachments/...`, which streams with the Gmail filename as `content-disposition` and never touches disk. The day-one composer is **plain text**, with the quoted original included as text (decided).

- [ ] **Step 1: Write failing tests**
  - `bodies.test.ts`: the first `getThreadDetail` calls `getThread(full)` and the second doesn't (cache hit); **Review Focus 5:** a 5 MB HTML body is returned in the DTO but `body_cache` has no row for it; html with `<script>` is returned raw (sanitizing is the client's job, tested in 10b) but the response has `content-type: application/json` and a `content-security-policy: default-src 'none'` header on the attachment route.
  - `compose.test.ts`: a reply to a message with Message-ID `<a@x>` produces `In-Reply-To: <a@x>`, `References` containing `<a@x>`, subject `Re: Hello`, and `Re: Re:` never appears; the send calls `sendRaw` with the Gmail thread id; `from` is the account that received the thread.
  - `search.test.ts`: results from two accounts are merged newest-first; search never calls `modifyThread`.
- [ ] **Step 2: Run** `npm test -w server -- bodies compose search` → FAIL.
- [ ] **Step 3: Implement** the files above.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: read, compose, send, search, attachments`.

---

### Task 7: Storage limits

**Files:**
- Create: `server/src/storage/limits.ts`, `server/src/storage/logs.ts`, `server/src/http/routes/storage.ts`
- Test: `server/test/limits.test.ts`

**Interfaces — Produces:**
```ts
export function measure(db: DB, cfg: AppConfig, statfs?: (p: string) => { bavail: bigint; bsize: bigint }): StorageUsageDTO; // sizes from dbstat (body_cache vs threads+messages), log dir size, total dataDir size, free disk
export function enforceLimits(db: DB, cfg: AppConfig, now: number): { evictedBodies: number; prunedThreads: number; degraded: boolean };
// body cache over limit → delete by last_accessed_at asc until 90% of limit
// index over limit → delete archived threads (in_inbox=0, no snooze, no override) oldest last_message_at first until 90%; stop backfill
// total > totalMB or free < minFreeDiskGB → degraded=true: canIndexMore()=false, no new body caching; publish storage.degraded on change
export function canIndexMore(): boolean; export function canCacheBodies(): boolean;
export function createLogger(cfg: AppConfig): pino.Logger; // pino to `${dataDir}/logs/supermail.log`, rotate at 10 MB, keep total <= logsMB
```
Runs at startup, every 15 min, and from the poller's `onAfterTick`. In `main.ts`, set `deps.storage = { canIndexMore, canCacheBodies }` and pass `canIndexMore` to `createPoller`. `GET /api/storage` returns `measure()`.

- [ ] **Step 1: Write failing tests:** with `bodyCacheMB` set tiny, the oldest-accessed bodies are evicted first and the newest stay; with `indexMB` tiny, archived threads are pruned but inbox, snoozed and overridden threads all remain; a stubbed `statfs` reporting 19 GB free → `degraded:true` and `canIndexMore()` false, and 25 GB free → false again after enforcement; `measure` reports `limits.totalMB === 3072` with defaults.
- [ ] **Step 2: Run** `npm test -w server -- limits` → FAIL.
- [ ] **Step 3: Implement** using the `dbstat` virtual table (better-sqlite3 build includes it; otherwise approximate via `page_count*page_size` split by row bytes).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: hard storage limits with eviction and degraded mode`.

---

### Task 8: "Skipped your inbox" and hiding filters

**Files:**
- Create: `server/src/skipped/skipped.ts`, `server/src/http/routes/skipped.ts`
- Test: `server/test/skipped.test.ts`

**Interfaces:** Consumes `recordUndo`, `undo` (Task 5), `toSummary` (Task 1). Produces:
```ts
export function listSkipped(db: DB, now: number, accountId?: string): ThreadPage; // in_inbox=0, is_sent_only=0, done_at NULL, no snoozes row, last_message_at >= now-30d
export async function restore(d: AppDeps, threadId: ThreadId): Promise<ActionResult>; // add INBOX, recorded for undo
export async function listHidingFilters(d: AppDeps): Promise<FilterDTO[]>; // per ok account: filters whose action removes INBOX → 'skip_inbox', adds TRASH → 'trash', removes UNREAD → 'mark_read'; criteria rendered "from:x subject:y"; gmailSettingsUrl `https://mail.google.com/mail/u/?authuser=${email}#settings/filters`
```
Filters are **listed** on day one. Deleting a filter needs the `gmail.settings.basic` scope, which we don't request, so the UI links to Gmail's filter settings instead (decided).

- [ ] **Step 1: Write failing tests:** a thread archived by Superhuman 3 days ago appears in the list; one archived 40 days ago does not; a thread Done in SuperMail does not; sent-only does not; `restore` adds INBOX and `undo` removes it again; a fake filter `{criteria:{from:'x@y'}, action:{removeLabelIds:['INBOX']}}` → `hides:['skip_inbox']`, and a filter that only adds a label is excluded.
- [ ] **Step 2: Run** `npm test -w server -- skipped` → FAIL.
- [ ] **Step 3: Implement** the files above.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: skipped-inbox view and hiding-filter list`.

---

### Task 9: Web shell, keymap, cheat-sheet panel, API client

**Files:**
- Create: `web/tailwind.config.ts`, `web/postcss.config.js`, `web/src/styles.css`, `web/src/App.tsx`, `web/src/api/client.ts`, `web/src/api/events.ts`, `web/src/keys/keymap.ts`, `web/src/keys/useShortcuts.ts`, `web/src/components/Layout.tsx`, `web/src/components/ShortcutPanel.tsx`, `web/src/components/Kbd.tsx`, `web/src/state/ui.ts`, `web/test/setup.ts`
- Test: `web/test/keymap.test.ts`, `web/test/ShortcutPanel.test.tsx`, `web/test/client.test.ts`

**Interfaces — Produces:**
```ts
// keymap.ts — single source for handlers AND the panel
export type KeyContext = 'list' | 'thread' | 'compose' | 'skipped';
export type Section = 'Move' | 'Act' | 'Teach';
export interface Binding { id: string; keys: string[]; label: string; section: Section; contexts: KeyContext[] }
export const BINDINGS: Binding[];
export function bindingsFor(ctx: KeyContext): Record<Section, Binding[]>;
// useShortcuts.ts
export function useShortcuts(ctx: KeyContext, handlers: Partial<Record<string /* Binding.id */, () => void>>): void; // ignores keys while focus is in input/textarea/contenteditable except Escape and Ctrl+Enter
// api/client.ts — typed fetch for every route in Task 1; adds `x-supermail: 1` on non-GET; 401 → location '/login'
export const api: { me(); accounts(); groups(); threads(q); thread(id); done(id); snooze(id, until); unsnooze(id); move(id, groupId); read(id, read); teach(r); undo(undoId); send(r); search(q); skipped(); restore(id); filters(); storage(); labels(); createGroup(r: CreateGroupRequest); patchGroup(id, p); deleteGroup(id); removeAccount(id); logout() };
// api/events.ts
export function useServerEvents(): void; // EventSource('/api/events'), applies thread.updated/removed into TanStack Query caches, invalidates groups/accounts
// state/ui.ts
export function usePanelCollapsed(): [boolean, (v: boolean) => void]; // localStorage 'sm.panelCollapsed', try/catch
export function useAccountFilter(): [string | null, (id: string | null) => void];
```
`BINDINGS` (decided; ids are used by later tasks):

| id | keys | label | section | contexts |
|---|---|---|---|---|
| next / prev | `j` / `k` | Next / previous | Move | list, thread, skipped |
| open | `Enter` | Open | Move | list, skipped |
| back | `Escape` | Back | Move | thread, compose |
| nextGroup | `Tab` | Next group | Move | list |
| group1–9 | `1`–`9` | Go to group N | Move | list |
| cycleAccount | `` ` `` | Switch account | Move | list |
| search | `/` | Search | Move | list, thread |
| palette | `Ctrl+k` | Command palette | Move | list, thread |
| done | `e` | Done | Act | list, thread |
| snooze | `h` | Snooze | Act | list, thread |
| reply / replyAll / forward | `r` / `a` / `f` | Reply / Reply all / Forward | Act | thread |
| compose | `c` | Compose | Act | list, thread |
| toggleRead | `u` | Read / unread | Act | list, thread |
| undo | `z` | Undo | Act | list, thread |
| send | `Ctrl+Enter` | Send | Act | compose |
| important | `+` | Important to me | Teach | list, thread |
| notImportant | `-` | Not important | Teach | list, thread |
| groupTo | `l` | Always group to… | Teach | list, thread |
| restore | `i` | Restore to inbox | Act | skipped |
| togglePanel | `?` | Hide / show shortcuts | Move | list, thread, compose, skipped |

The layout follows mockup option B: a top bar (account switcher, group tabs with counts), the main area, and a right `ShortcutPanel` 230 px wide, with Move / Act / Teach sections for the current context. Styling is flat Inter, dense rows and light/dark through CSS variables. The panel is hidden below 768 px width (the phone layout is a later batch).

- [ ] **Step 1: Write failing tests:** `bindingsFor('compose').Act` contains `send` and not `done`; there are no duplicate keys within a single context; `ShortcutPanel` renders `Done` with `e` in list context and `Reply` in thread context; pressing `?` collapses it and the state survives a re-render (localStorage mocked) and also when localStorage throws; `useShortcuts` does not fire `done` while typing `e` in a textarea; `api.done('a:1')` sends `POST /api/threads/a%3A1/done` with header `x-supermail: 1`.
- [ ] **Step 2: Run** `npm test -w web` → FAIL.
- [ ] **Step 3: Implement** the files above. `App.tsx` routes are `/` (inbox), `/t/:id` (thread), `/compose`, `/search?q`, `/skipped`, `/settings`, `/login`, with placeholders that Task 10 fills.
- [ ] **Step 4: Run** `npm test -w web && npm run build -w web` → PASS.
- [ ] **Step 5: Commit** `feat(web): shell, keymap, always-visible shortcut panel, API client`.

---

### Task 10a: Inbox UI (list, groups, accounts, actions, teaching)

**Files:** Create `web/src/views/Inbox.tsx`, `web/src/components/ThreadRow.tsx`, `web/src/components/GroupTabs.tsx`, `web/src/components/AccountSwitcher.tsx`, `web/src/components/SnoozePicker.tsx`, `web/src/components/GroupPicker.tsx`, `web/src/components/UndoToast.tsx`, `web/src/lib/snoozeTimes.ts` · Test `web/test/Inbox.test.tsx`, `web/test/snoozeTimes.test.ts`

**Interfaces:**
- Consumes: `api`, `useShortcuts`, `useAccountFilter`, `ThreadSummaryDTO`, `GroupDTO`, `AccountDTO`.
- Produces: `export function presets(now: Date): { label: string; at: Date }[]` and `export function parseSnooze(text: string, now: Date): Date | null` (chrono-node, future only).

Presets (decided): **Later today** (now + 3 h rounded up to the hour; if that is past 18:00, tomorrow 08:00), **Tomorrow morning** (tomorrow 08:00), **This weekend** (Saturday 09:00; if it's already the weekend, next Saturday), **Next week** (next Monday 08:00).

Rows show the account dot (account color), sender, group label chip (hidden when viewing that group), subject, snippet and date. The selected row also shows the reason line in small blue text. When `suggestRule` is true it shows an inline "Make this a rule for <sender>?" button. Actions are optimistic through TanStack Query, roll back on error and show an `UndoToast` for 10 s with `z`. The list uses TanStack Virtual. Group tabs show `inboxCount` and follow the account filter. `+`/`-` default to scope `sender`, and the toast offers "apply to whole domain".

- [ ] **Step 1: Write failing tests:** with the mocked `api`, pressing `j j e` calls `api.done` for the 2nd thread and that row disappears; `z` calls `api.undo` with the returned undoId and the row reappears; pressing `` ` `` cycles the account filter All → A → B → All and the tabs re-fetch counts; `presets(new Date('2026-10-29T19:30'))[0].at` is `2026-10-30T08:00`; `parseSnooze('fri 9am', Thu 29 Oct 2026)` gives Fri 30 Oct 09:00; `parseSnooze('yesterday', …)` gives null.
- [ ] **Step 2–4:** Run `npm test -w web -- Inbox snoozeTimes` → FAIL, implement, then → PASS.
- [ ] **Step 5: Commit** `feat(web): merged inbox, groups, account switcher, actions, teaching`.

### Task 10b: Thread view, composer, search, command palette

**Files:** Create `web/src/views/Thread.tsx`, `web/src/components/MessageBody.tsx`, `web/src/views/Compose.tsx`, `web/src/views/Search.tsx`, `web/src/components/CommandPalette.tsx` · Test `web/test/MessageBody.test.tsx`, `web/test/Compose.test.tsx`

`MessageBody` sanitizes HTML with DOMPurify (`FORBID_TAGS: ['script','style','form','input','button','iframe','object','embed']`, plus `FORBID_ATTR` for every `on*` handler). It renders into an `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc=…>` with **no** `allow-scripts` and no `allow-same-origin`. Links get `target=_blank rel="noopener noreferrer"` and remote images are allowed. When the message has no HTML it shows text in `<pre class="whitespace-pre-wrap">`. The composer is plain text with To/Cc/Bcc chips, and the From account is fixed to the thread's account (compose picks an account, defaulting to the current filter or the first). Send is `Ctrl+Enter` and `Esc` asks before discarding a non-empty draft. The palette lists every `BINDINGS` entry plus "Skipped your inbox", "Settings" and each group.

- [ ] **Step 1: Write failing tests:** **Review Focus 5:** `<img src=x onerror=alert(1)><script>alert(2)</script><form><input></form>` renders into a srcdoc that contains no `onerror`, no `<script`, no `<form`, and the iframe has no `allow-scripts` in its `sandbox` attribute; a reply prefills `to` with the original sender and subject `Re: …`; `Ctrl+Enter` calls `api.send` once (a double press does not send twice).
- [ ] **Step 2–4:** Run `npm test -w web -- MessageBody Compose` → FAIL, implement, then → PASS.
- [ ] **Step 5: Commit** `feat(web): thread view with sandboxed HTML, composer, search, palette`.

### Task 10c: Login, settings, storage, skipped, filters

**Files:** Create `web/src/views/Login.tsx`, `web/src/views/Settings.tsx`, `web/src/views/Skipped.tsx` · Test `web/test/Settings.test.tsx`, `web/test/Skipped.test.tsx`

Login is a single "Sign in with Google" button pointing to `/auth/login`. Settings has these sections:
- **Accounts:** list with color dot and status, "Connect Gmail" (`/auth/connect`), "Reconnect" when `reconnect_needed`, and Remove with a confirm.
- **Groups:** rename, reorder, color, notify bell (stored now, used by the later push batch), and create or delete custom groups, plus "Use a Gmail label as a group", which picks from `api.labels()`.
- **Storage:** each `StorageUsageDTO` value as "used / limit" plus a degraded banner.

Skipped shows threads with `Enter` to open and `i` to restore to inbox (also listed in the panel), then a "Filters that hide mail" table with an "Open in Gmail" link per row.

- [ ] **Step 1: Write failing tests:** an account with `reconnect_needed` shows a Reconnect link to `/auth/connect`; storage shows `1024 MB` for the cache limit; Skipped restore calls `api.restore` and removes the row; the filters table renders a `skip_inbox` badge and an `Open in Gmail` href containing `#settings/filters`.
- [ ] **Step 2–4:** Run `npm test -w web -- Settings Skipped` → FAIL, implement, then → PASS.
- [ ] **Step 5: Commit** `feat(web): login, settings, storage, skipped and filters views`.

---

### Task 11: Home Assistant add-on packaging and deploy scripts

**Files:**
- Create: `addon/super_mail/config.yaml`, `addon/super_mail/Dockerfile`, `addon/super_mail/run.sh`, `addon/super_mail/README.md`
- Create: `deploy/deploy.sh`, `deploy/caddy-site.caddy.tmpl`, `deploy/route53-cname.json.tmpl`, `deploy/verify.sh`

**Decisions:**
- `config.yaml` follows the usual local add-on conventions: `name: SuperMail`, `version: "0.1.0"`, `slug: super_mail`, `arch: [aarch64]`, `startup: application`, `boot: auto`, `init: false`, `host_network: true`, `map: [addon_config:rw]`, `backup_exclude: ["secret.key"]`. Options are `owner_email` and `public_url` (required, no defaults), `port: 8787`, `body_cache_mb: 1024`, `index_mb: 1024`, `logs_mb: 50`, `total_mb: 3072`, `min_free_disk_gb: 20`, and the schema types them (`email`, `url`, `port`, `int(100,20000)`…).
- `Dockerfile`: a multi-stage `node:22-bookworm-slim` build. `npm ci`, `npm run build`, `npm prune --omit=dev`, then copy `server/dist`, `web/dist`, `node_modules` and `package*.json`. The runtime sets `NODE_OPTIONS=--max-old-space-size=256` and `CMD ["/run.sh"]`. `run.sh` exits non-zero with a clear log line if `/config/client_secret.json` is missing.
- `deploy/deploy.sh` (run from the owner's computer):
  1. rsync the repo (excluding `node_modules`, `.data`, `.git`) to `<host>:/local_apps/super_mail/`, with `addon/super_mail/*` placed at that folder's root and the source under `src/`. The Dockerfile `COPY`s from `src/`.
  2. scp `~/.config/super-mail/client_secret.json` to `<host>:/addon_configs/local_super_mail/client_secret.json` with mode 600, but only if absent or `--force-secret`.
  3. `ha store reload`, then `ha apps install local_super_mail` the first time, otherwise `ha apps rebuild local_super_mail`, then `ha apps start local_super_mail`.

  The script never prints the secret.
- `deploy/caddy-mail.caddy` is the block to **append** to the reverse proxy's Caddy config: `mail.<your domain> { tls { issuer acme { … } }  reverse_proxy 127.0.0.1:8787 }`, with the same TLS issuer settings as the existing public blocks. Caddy is reloaded afterwards.
- `deploy/route53-cname.json.tmpl` (rendered into `deploy/out/` by `deploy/render.sh`): UPSERT `mail.<your domain>` CNAME `<your dynamic DNS name>` with TTL 300. It is applied with `aws route53 change-resource-record-sets --hosted-zone-id <zone id> --change-batch file://deploy/out/route53-cname.json`.
- `deploy/verify.sh` checks:
  - `dig +short mail.<your domain>` includes the dynamic DNS name;
  - `curl -sI <public URL>/privacy` returns 200 with a valid certificate;
  - `curl -s <public URL>/api/accounts` returns 401;
  - on the server, `ha apps info local_super_mail` shows `state: started`, and `docker stats --no-stream addon_local_super_mail` shows memory under 400 MiB.

- [ ] **Step 1: Build check** `docker buildx build --platform linux/arm64 -f addon/super_mail/Dockerfile .` on a development machine → succeeds. Then run the image with a fake `/data/options.json` and no client file → the container exits with the "client_secret.json missing" log line.
- [ ] **Step 2: Commit** `feat: Home Assistant add-on packaging and deploy scripts`. Do **not** run deploy, DNS or Caddy steps in this task; Task 12 owns them.

---

### Task 12: Deploy, DNS, gateway, owner acceptance (coordinator + owner)

**Outward-facing.** Before each numbered action, the coordinator states it to the owner and waits for an explicit yes.

- [ ] **Step 1:** `npm test && npm run typecheck && npm run build` on the merged branch → all green.
- [ ] **Step 2 (owner yes):** `deploy/deploy.sh` → the add-on is installed and started; `ha apps logs local_super_mail` shows `listening on 127.0.0.1:8787`.
- [ ] **Step 3: Backup exclusion check:** create a partial backup of the add-on only (`ha backups new --app local_super_mail --name sm-check`), list its tar and confirm `secret.key` is absent; then delete that check backup. If it is present, fix the `backup_exclude` glob and repeat.
- [ ] **Step 4 (owner yes):** apply `deploy/route53-cname.json.tmpl` (rendered into `deploy/out/` by `deploy/render.sh`).
- [ ] **Step 5 (owner yes):** append `deploy/caddy-mail.caddy` to the reverse proxy's Caddy config and reload Caddy. Confirm the existing sites (for example Home Assistant) are still served.
- [ ] **Step 6:** run `deploy/verify.sh` → all checks pass.
- [ ] **Step 7: Owner acceptance at the public URL:**
  - [ ] Signing in works for the owner, and a different Google account is refused.
  - [ ] Connect Gmail shows the "unverified app" warning, the owner continues, and the inbox fills within 2 minutes.
  - [ ] A Superhuman-hidden security email appears in "Skipped your inbox", and `i` restores it.
  - [ ] `-` on an Alibaba email moves all inbox Alibaba mail to Low priority, and it's still visible there.
  - [ ] `e`, `h` → Tomorrow morning, and `z` all behave; the Gmail app on the phone shows `SuperMail/` labels and `SuperMail/Snoozed`.
  - [ ] Reply from the correct account arrives at the recipient.
  - [ ] A second Gmail account connects, the merged inbox shows both dots, and `` ` `` filters per account.
  - [ ] Settings → Storage shows the limits (1024 / 1024 / 50 / 3072 MB, 20 GB free).
- [ ] **Step 8:** record the results in the spec (§5, "Day one shipped <date>"), then commit `docs: day-one acceptance results`.
