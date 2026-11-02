# SuperMail — design

Date: 2026-10-29 · Status: approved 2026-10-29

A self-hosted, keyboard-first Gmail client that replaces Superhuman. It runs on a small home
server (for example a Raspberry Pi with Home Assistant) and is served at a public HTTPS address
such as `https://mail.example.com`. There is one user (the owner) and any number of connected
Gmail accounts.

Decisions are marked **(owner)** when the owner made them in conversation and **(call)** when the
designer made them and the owner has not yet reviewed them specifically. Anything not marked is
context or requirement.

---

## 1. Why

The owner uses Superhuman, and it has lost their trust:

- **It hides emails.** Superhuman's AI auto-labels (Marketing, News, Social, Pitch) can be
  combined with "Auto Archive", and then mislabelled emails skip the inbox entirely. Typical
  examples that end up in `Auto Archived`: a bookstore's security-incident notice (labelled
  "news"), a broker's account-safety notice, or bank mail (labelled "marketing"). Superhuman's own
  split settings show warning icons on the News and Marketing splits for exactly this conflict.
- **It groups badly.** A handful of splits (Important, Shared, Calendar, News, GitHub, Purchases,
  Other), and everything unmatched falls into "Other", which grows into a pile of a hundred or more.
  That pile mixes security alerts, pension statements, bank fraud warnings, card statements and
  failed-deployment alerts with recurring course newsletters. None of those senders get a group of
  their own, and there is no way to teach it.

**What success looks like:** the owner trusts that nothing vanishes. Every email lands in a group
they understand, the app can say why it is there, and one keystroke corrects it permanently. It
should be as fast to triage as Superhuman, on the computer and on the phone.

## 2. Goals, non-goals, anti-goals

**Goals**
- Several Gmail accounts, a merged inbox, and a per-account view **(owner)**.
- Grouping that learns from explicit owner feedback **(owner)**.
- Snooze, reminders, Done and keyboard shortcuts, as in Superhuman **(owner)**.
- Keyboard shortcuts always visible on the computer **(owner)**.
- Usable on the phone, with notifications **(owner)**.
- Self-hosted on a small home server, for example as a Home Assistant add-on **(owner)**.

**Non-goals (v1)**
- AI-written replies. Dropped **(owner)**: they were not used in Superhuman.
- Non-Gmail accounts (for example a company mailbox on another provider). Gmail only "for now"
  **(owner)**.
- Multiple users or teams, shared inboxes, calendar features, read receipts and scheduled send.
  None of these were asked for.
- Storing a full copy of the mailboxes on the server **(owner)**.

**Anti-goals: things that would make this a failure even if it technically works**
- Any email leaving the inbox without an explicit owner action (Done or snooze) or an
  owner-created rule. **No auto-archive, ever.**
- "Less important" meaning hidden. A low-priority group is always one keypress away, and its
  emails are searchable and counted.
- A grouping the owner cannot explain or override.
- Filling the server's disk, or slowing down Home Assistant.
- Losing mail or labels if the server or app is down. Gmail stays the source of truth.

## 3. Constraints and environment

- **Host:** a small always-on machine, for example a Raspberry Pi (aarch64) with a few GB of RAM
  running Home Assistant OS, shared with other services. The app must stay light.
- **Packaging:** a local Home Assistant add-on (`config.yaml` plus `Dockerfile`), following the
  usual local add-on conventions. A plain Docker setup should work too.
- **Public HTTPS:** an existing reverse proxy (for example Caddy) terminates TLS and forwards to
  the app on localhost. The home IP may be dynamic, tracked by a dynamic DNS name. Port 80 may not
  be forwarded, so certificates may have to be issued with the TLS-ALPN challenge.
- **DNS:** the owner's domain is managed by a DNS provider (for example AWS Route 53). A `mail.`
  record is added as a CNAME to the dynamic DNS name. The domain's MX records must not be touched.
- **Backups:** Home Assistant takes regular full backups, which may be copied off-site. The
  add-on's `/data` is included, so anything secret in it must be encrypted at rest.
- **Google:** Gmail API with OAuth. Accounts are personal `@gmail.com` addresses (or Google
  Workspace addresses).

## 4. How it works

### 4.1 Accounts and sign-in
- The owner adds an account with **Connect Gmail**, which runs the Google OAuth consent flow.
  Accounts can be added without limit and removed at any time **(owner)**. Removing an account
  deletes its local index, cache and tokens.
- The Gmail API is used rather than IMAP **(call)**. It is faster, labels map natively, and it
  supports push.
- OAuth scopes: `gmail.modify` (read, label, archive, send) plus `openid email`. `gmail.modify`
  is a restricted scope, so the Google Cloud OAuth app stays **unverified, in production mode, for
  personal use** **(call)**. The owner clicks through Google's "unverified app" warning once per
  account. Production mode (not "Testing") is required so refresh tokens do not expire after 7
  days.
- **Signing in to SuperMail itself** uses Google sign-in, allowed only for email addresses of
  connected accounts **(call)**. The very first sign-in is restricted to
  the owner's address, set in the add-on options (`owner_email`). Sessions are long-lived httpOnly
  cookies.
- Refresh tokens are encrypted at rest with a key file in the add-on's `/data`. The key file is
  **excluded from HA backups** with the add-on's `backup_exclude` **(call)**. The backups
  may be encrypted too, but this keeps a usable token out of them entirely. As a result,
  restoring from backup means clicking "Reconnect" once per account. The app has to detect
  tokens it cannot decrypt and show that state; it must not crash or wipe data. Restarting and
  updating work unattended because `/data` survives them.
- **Google Cloud setup** (done by the owner, by hand, because it needs their Google login): a
  Google Cloud project with the Gmail API enabled. The Google Auth Platform app "SuperMail" is
  External and **In production**, unverified (do not submit it for verification), with Google's
  100-user lifetime cap. Scopes are `openid`, `userinfo.email` and `gmail.modify`. The home page is
  the public URL and the privacy policy is `<public URL>/privacy` (**the app must serve a short
  public privacy page at `/privacy`**); the authorized domain is the owner's domain. A Web OAuth
  client has the redirect URIs `<public URL>/auth/google/callback` and
  `http://localhost:8787/auth/google/callback` (dev) **(call: the path and dev port are fixed
  now)**. The owner downloads the client JSON themselves and keeps it at
  `~/.config/super-mail/client_secret.json` (mode 600) on their computer; it is copied into the
  add-on's config at install time. Never commit it, print it or read it into logs. The assistant
  never handles the secret. See `docs/google-cloud-setup.md`.
- **Pub/Sub is deferred (call):** day one uses `history.list` polling (about every 15 s per
  account), which avoids a service-account key on the server. Push via Pub/Sub can be added later.

### 4.2 Storage (owner: don't fill the disk)
- **Gmail is the source of truth.** Locally there is a single-file SQLite database **(call)**
  holding:
  - a per-message index: account, Gmail ids, thread id, from, to, subject, date, snippet, Gmail
    labels, assigned group, and the reason for the group. About 2 KB per message;
  - the owner's teaching: marks and rules;
  - snooze and reminder schedules, push subscriptions and sessions.
- **Body cache:** full bodies of new and recently opened messages, capped at **1 GB total**,
  oldest evicted first **(call)**.
- **Hard disk limits (owner asked for GB limits; numbers are a call):**

  | What | Limit | When reached |
  |---|---|---|
  | Body cache | **1 GB** | evict oldest-accessed bodies |
  | Mail index (`threads` + `messages`) | **1 GB** | stop indexing older history, drop index rows for the oldest *archived* threads (they stay in Gmail and remain findable through search); never drop inbox, snoozed, or reminder threads |
  | Logs | **50 MB** | rotate, keep the newest |
  | **Everything in the add-on's `/data`** | **3 GB hard ceiling** | stop all caching and history indexing; core features keep working; show a warning banner |
  | Free space on the host's disk | keep **≥ 20 GB free** | same as the hard ceiling, so the app never starves Home Assistant |

  The limits are add-on options, so they can be changed without a rebuild. Settings shows the
  current usage of each item against its limit.
- **Attachments are never stored.** They are streamed from Gmail on demand.
- **Search** uses Gmail's search (`q=`) across all accounts, with results merged. It covers full
  history without a local copy.
- **First sync:** the most recent ~3 months are indexed first so the app is usable within minutes,
  then older history is indexed in the background at a gentle rate **(call: the depth and pace are
  the builder's)**.
- **Ongoing sync (day one):** `history.list` polling about every 15 s per account, so new mail notifies quickly; backfill keeps its 30 s pace. **Later:** Gmail `users.watch` sends to a Google Cloud Pub/Sub topic. The server consumes it
  with a **pull** subscription, so no inbound webhook is needed, then reads changes through
  `history.list` **(call)**. Polling stays on as the fallback.

### 4.3 Groups and labels
- A **group is a real Gmail label** under `SuperMail/` (for example `SuperMail/Dev`) **(owner)**.
  The phone's Gmail app and anything else see the same grouping, and if SuperMail disappears the
  sorting stays.
- **Groups are shared across accounts (owner).** "Dev" is one group containing mail from every
  account, and the same-named label is created in each account.
- Messages can have several labels, but the inbox shows each thread under **one** group: the
  highest-ranked for the owner. Nothing appears twice.
- The owner's existing non-system Gmail labels (for example "Legal - Example Studio SRL") can be
  used as groups **in place: never renamed or moved** **(call)**. Such a group maps to that label
  in each account where it exists. Mail already carrying the label counts as in the group. If
  mail in another account is routed to the group, a label with the same name is created there.
  So a group has one label per account, not a fixed `SuperMail/<name>` rule.
- **Which mail gets labels written to Gmail (call):** new mail, everything currently in the inbox,
  and snoozed threads. When the owner adds a mark or rule, it also relabels those same threads
  from that sender. Archived history is grouped in the app's index for search and display, but
  its Gmail labels are **not** rewritten: no bulk relabelling of tens of thousands of messages.
  Label writes are batched and quota-aware, and the label changes the app writes are logged so
  they can be reverted.
- **Label changes made outside SuperMail (call):** sync is two-way. If the owner moves a thread
  between groups in the Gmail app, SuperMail accepts it as a **one-off override for that thread**,
  not a rule. It never reverts the change. It shows a "Make this a rule for <sender>?" suggestion
  the next time the owner sees the thread in SuperMail.
- **Starting groups (call):** Important, Money & Security, Dev, Purchases, News, Low priority,
  and **Unsorted**. Unsorted is visible and counted, holds mail with no confident group, and
  prompts teaching. It is never a hidden "Other". The owner can create, rename, reorder and delete
  groups.
- **Superhuman import (later batch):** the `[superhuman]/ai/*` labels and "Auto Archived" are read
  once as seed hints. Mail currently sitting in "Auto Archived" from the last N days (default 30)
  is offered back to the inbox for review. The `[superhuman]` labels can then be removed from Gmail
  with an explicit owner confirmation.

### 4.4 Classification and teaching
Priority order, highest first:
1. **Owner rules: "Always group to X"** (owner). Matches by sender address, sender domain or
   mailing list (`List-Id`). These always win.
2. **Owner marks: "Important to me" / "Not important"** (owner). Applied to the sender (and
   offered for the domain or list) and generalised from then on. "Important" raises the email to
   the Important group and the top of lists. "Not important" moves it to **Low priority**, which
   is still visible and never archived.
3. **Safety net (later batch, call):** security alerts, bank and money mail, and personal mail
   from real people are never placed in Low priority automatically. Only an explicit owner action
   can do that.
4. **Automatic first guess (call):** deterministic heuristics with no external AI. They use
   Gmail's own categories (`CATEGORY_*`), `List-Id` and `List-Unsubscribe`, known sender domains
   (github.com, vercel.com and so on), and keywords. When confidence is low the email goes to
   Unsorted.

- Teaching applies **across all accounts** **(call)**.
- Every thread stores a **reason** that is shown in the UI, for example "In Dev because you said
  so on 28 Oct" or "In News: mailing list newsletter@… (automatic guess)".
- Changing a group re-labels the thread in Gmail.

### 4.5 Inbox, views and actions
- **Merged inbox** by default, with an **account switcher** (top left): *All accounts* or any one
  account **(owner)**. The group tabs stay the same, filtered to the selection, and counts follow
  the filter.
- Each row shows a colored **account dot**, its **group labels**, sender, subject, snippet and date
  **(owner)**.
- **Done (owner):** removes `INBOX`. A new reply puts the thread back in the inbox (Gmail does this
  natively).
- **Snooze (owner):** presets ("later today", "tomorrow morning", "next week") plus typed natural
  times ("fri 9am"). It removes `INBOX` and adds `SuperMail/Snoozed`. A scheduler on the server
  restores `INBOX`, removes the label and surfaces the thread at the top when it is due. If the
  server was down at the due time, the thread is restored on startup.
- **Reminders (owner; later batch):** set when sending ("remind me in N days if no reply"). If no
  reply from another party has arrived by then, the thread returns to the inbox with a "no reply
  yet" marker. It cancels itself when a reply arrives.
- **Undo** for a few seconds after any action **(call)**.
- **Read, reply, reply all, forward, compose:** sanitized HTML rendering with remote images
  allowed, plain-text fallback, attachments on demand, and sending from the account that received
  the email **(call: remote images shown by default, like Superhuman; easy to make a setting)**.

### 4.6 Computer UI (owner: option B)
- Keyboard-first with Superhuman-compatible keys: `J`/`K` move, `Enter` open, `E` done, `H` snooze,
  `R`/`A` reply/all, `F` forward, `C` compose, `/` search, `Z` undo, `Esc` back, a
  command palette, and group switching (`Tab` / number keys).
- Teaching keys: `+` important to me, `-` not important, `L` always group to….
- **A cheat-sheet panel on the right is always visible.** It is grouped into Move / Act / Teach,
  changes with context (list, reading, composing), and `?` collapses it, with the state
  remembered.
- Mockups: option B of the shortcut-layout mockups made during design (not kept in the repo).
- Visual direction **(call):** flat, Inter, a dense list, and light and dark themes.

### 4.7 Phone (owner)
- The same web app, responsive, installable to the home screen as a PWA. The main target is
  Android.
- Swipe right for Done, swipe left for Snooze, long-press for important / not important / always
  group to…. Groups are swipeable tabs, and tapping an email opens it full screen. No shortcut
  panel on the phone.
- **Notifications (owner):** Web Push for **every new email**, except groups the owner has muted
  (a bell toggle per group). A notification has **Done** and **Snooze** actions, opens the thread
  on tap, and clears itself when the email is handled elsewhere.

### 4.8 Hosting
- A local Home Assistant add-on `super_mail` with `host_network`, listening on localhost only, on
  a port the builder picks **(call)**.
- DNS: `mail.<your domain>` CNAME to the home dynamic DNS name **(call)**.
- Reverse proxy: a new site block for `mail.<your domain>` in the existing Caddy config, using the
  same TLS issuer settings as the other public blocks and `reverse_proxy 127.0.0.1:<port>`. Do not
  change the existing blocks.
- Resource budget: keep the add-on comfortably under ~400 MB RAM in steady state, and never
  contend with Home Assistant **(call)**.

### 4.9 Mail that skips the inbox (anti-goal guard)
- **Day one (call):** on connect, SuperMail lists every Gmail **filter** in that account that skips
  the inbox, archives, deletes or marks as read. They are shown on a "Filters that hide mail"
  screen. The owner can keep or delete each one, and nothing changes silently. A filter the owner
  keeps counts as an owner-created rule.
- **Day one (call):** a "**Skipped your inbox**" view lists mail from the last 30 days that is
  neither in the inbox nor marked Done or snoozed by SuperMail, and is not sent mail. That
  includes Superhuman's `[superhuman]/ai/autoarchived`. One key moves an item back to the inbox.
  This catches whatever Superhuman hid before the switch, until the full import ships.
- **Owner action, now:** turn off Auto Archive on Superhuman's auto-labels, so nothing more gets
  hidden before the switch.

## 5. Delivery

**Day one (owner agreed):**
accounts and the merged inbox with the account switcher; read, reply, compose and search; Done,
snooze and undo; groups as Gmail labels shared across accounts, with the first guess, teaching and
the "why" line; no auto-archive, plus the "Skipped your inbox" view and the filter list (§4.9);
the keyboard plus cheat-sheet panel; the HA add-on behind the public HTTPS address with
owner-only sign-in.

**If day one is at risk, cut in this order (call):** typed natural snooze times (keep the
presets); forward; Pub/Sub push (ship with 60 s polling); per-account view (keep the merged
view); the "Make this a rule?" suggestion. The core is never cut: merged inbox, groups and
teaching, Done, snooze, reply, the "Skipped your inbox" view, and the shortcut panel.

**Day one shipped 2026-10-29.** The owner ran the acceptance checklist and every item passed:
sign-in, Connect Gmail, Skipped restore, `-` to Low priority, Done/snooze/undo with labels visible
in the Gmail app, reply from the right account, a second account, and the storage limits. The
first UX feedback (one-click open, back buttons, attachments that would not open) was fixed in
0.1.3, and the UX kept improving from there.

**Next batch, about 1–2 weeks after:**
the phone layout and gestures plus PWA install; push notifications with per-group mute;
reminders; the safety net; the Superhuman import and cleanup; encrypted-token hardening, if it
was not done on day one.

Until the phone batch lands, the owner uses the Gmail app on the phone, which already shows the
`SuperMail/` labels.

## 6. Left to the builder

- **Stack: decided (owner reviewed and accepted, 2026-10-29):**
  - Server: Node 22, TypeScript, Fastify, `googleapis`, `web-push` (later batch), and Server-Sent
    Events for live updates to the browser.
  - Database: SQLite (WAL) in the add-on's `/data`, through `better-sqlite3` with plain SQL
    migrations. No database server.
  - Client: React + TypeScript and Vite, built to static files served by the same Fastify server.
    Also `vite-plugin-pwa`, Tailwind, TanStack Query, and TanStack Virtual for the list.
    HTML mail is sanitized with DOMPurify and rendered in a sandboxed iframe.
  - Not used: Next.js or any SSR framework.
- **Database contents** (owner reviewed): `accounts`, `sessions`; `threads`, `messages`,
  `body_cache`; `groups`, `rules`, `sender_marks`, `overrides`; `snoozes`, `reminders`;
  `label_writes`, `push_subscriptions`, `undo`. The exact columns are the builder's.
- Module boundaries, the classification heuristics' details, sync batching and rate
  limits, the add-on image build (on the host or cross-built for aarch64), test strategy, and the
  exact port.
- How the Google Cloud setup is scripted versus done by hand. The owner performs anything that
  requires their Google login.
