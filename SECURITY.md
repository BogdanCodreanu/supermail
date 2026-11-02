# Security

SuperMail is a self-hosted client for one owner. This page says what it can reach, what it stores,
and how to report a problem.

## What the app can access

- **Gmail, through the `gmail.modify` scope**, for every account you connect: read mail and settings,
  add and remove labels (Done, snooze and groups are label changes), archive, mark spam, and send. It
  cannot permanently delete mail. It reads your Gmail filters to warn you about the ones that hide mail,
  and never changes them.
- **Your Google address**, through `openid` and `userinfo.email`, to check who is signing in.
- Nothing else: no contacts, calendar, Drive or other Google data.

Only the configured owner email, and accounts that owner has connected, can sign in. Anyone else is
refused after Google sign-in.

## Where secrets live

Everything is in the data directory (`/data` in Docker and the add-on, `./.data` by default otherwise):

| What | How it is stored |
|---|---|
| `secret.key` | 32 random bytes, file mode 0600, made on first start |
| Refresh tokens | AES-256-GCM, encrypted with `secret.key` |
| Push (VAPID) private key | AES-256-GCM, encrypted with `secret.key` |
| Sessions | only the SHA-256 of each session token; the cookie is httpOnly, SameSite=Lax, and Secure behind HTTPS |
| Google OAuth client JSON | outside the data directory, mounted read-only; never logged |

The Home Assistant add-on excludes `secret.key` from backups (`backup_exclude`), so a leaked backup holds
no usable token. Do the same with your own backups of the data directory. After a restore without the
key, each account needs one **Reconnect**.

The index (headers, labels, your teaching) and the body cache are not encrypted at rest. Protect the
data directory as you would protect your mail.

## What never leaves your server

- Mail content, the index, your groups and teaching rules. The only outbound calls go to Google's APIs
  (OAuth, Gmail) and, when you turn notifications on, to your browser's push service.
- Push notifications carry the sender, the subject and a short preview, encrypted end-to-end for your
  devices (Web Push), so the push service cannot read them.
- There is no telemetry, analytics or AI service, and no third-party script in the web app.

## Hardening built in

- Every non-GET API request needs an `x-supermail: 1` header, which a cross-site form or image cannot send.
- Email HTML is sanitized (DOMPurify) and rendered in a sandboxed frame that never allows scripts, with a
  Content Security Policy. Spam opens with all remote content blocked.
- The server listens on `127.0.0.1` by default. Put it behind an HTTPS reverse proxy; do not expose it
  over plain HTTP on the internet.

## Reporting a vulnerability

Please report vulnerabilities privately through a GitHub security advisory:
**Security → Advisories → Report a vulnerability** on this repository. Do not open a public issue.

Include what you found, how to reproduce it, and the version or commit. You will get a reply as soon as
possible. Please give a reasonable time for a fix before you disclose it publicly.
