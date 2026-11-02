import type { RoutePlugin } from '../app.js';

// Public: linked from the Google OAuth consent screen as the app's privacy policy.
const PRIVACY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SuperMail privacy</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 Inter, system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 16px; }
</style>
</head>
<body>
<h1>SuperMail privacy policy</h1>
<p>SuperMail is a self-hosted email client with a single owner. It is not a public service, and
only its owner can sign in.</p>
<p>When the owner connects a Gmail account, SuperMail uses Google's Gmail API to read, label, archive
and send that account's mail on the owner's behalf. Your Gmail data stays in two places: Google, and
the owner's own server, which keeps an index of message headers, a limited cache of message bodies and
an encrypted access token. Nothing is sold or shared with third parties, and no external AI or
analytics service ever sees your mail.</p>
<p>If the owner turns on notifications, the sender, subject and a short preview of new mail go to the
owner's own devices through their browser's push service. They are encrypted for those devices, so
the push service cannot read them.</p>
<p>You can revoke SuperMail's access at any time at
<a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>. Removing an
account in SuperMail deletes its local index, cache and token.</p>
</body>
</html>
`;

export const privacyRoutes: RoutePlugin = async (app) => {
  app.get('/privacy', async (_req, reply) => reply.type('text/html; charset=utf-8').send(PRIVACY_HTML));
};
