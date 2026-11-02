# Dev mock API

Run the web UI against an in-memory SuperMail server, with no Google sign-in, no `server/` process and no network.
Use it for UI work, screenshots and demos.

```sh
npm run dev:mock -w web     # http://localhost:5199
```

`MOCK=1` adds the `supermail-mock-api` Vite plugin (`plugin.ts`), which answers `/api/*` and `/auth/*` itself instead of
proxying to `127.0.0.1:8787`. The plugin has `apply: 'serve'`, so `vite build` never includes it, even with `MOCK=1`
set. Plain `npm run dev -w web` still proxies to the real server on port 5173.

## What is in it

- `fixtures.ts`: the mailbox. Every timestamp is relative to the moment the server starts, so the list always looks
  current. It contains:
  - two accounts: `you@example.com` (blue) and `work@example.com` (green);
  - the 7 starting groups;
  - 63 threads. 51 are in the inbox, a mix of read and unread; 3 are snoozed; 5 skipped the inbox, including
    a bookstore's "Informare incident de securitate"; 4 are Done, one of them too long ago for "Show done";
  - 6 threads in spam (`world.spam`, kept apart from the mailbox as the index keeps spam out), with remote images,
    a tracking pixel, CSS backgrounds and an attachment for the safe reader to deal with.
- The senders are a typical mix (every person, company and address is fictional; the big brands are only there to
  look familiar):
  - Google security alerts, ING, a Revolut statement (PDF);
  - GitHub and Vercel notifications;
  - Școala de Weekend and Slow Breath Weekly newsletters;
  - Bolt receipts with PDF invoices;
  - Alibaba promos;
  - Contabil Exemplu, with 2 attachments (PDF and PNG);
  - personal mail from Sam and Irina, in Romanian and English.
- Cases for testing the UI:
  - a 4-message thread with nested Gmail quotes (`gmail_quote`): *Weekend la Brașov?*;
  - a fixed 700px HTML newsletter whose images are inline SVG `data:` URIs: *Cursurile din noiembrie…*;
  - a very long plain-text email: *Notes from the publisher meeting (long)*;
  - taught reasons ("In Important because you said so on 28 Oct"), automatic guesses and Unsorted;
  - one thread with `suggestRule` set: the Monday Bolt trip;
  - Gmail labels and three "filters that hide mail".
- `assets.ts`: real attachment bytes, built in memory: valid one-page PDFs and a 120×160 PNG.
- `teaching.ts`: the rules and marks the mock starts with, and how they match a thread.
- `handler.ts`: `createMockApi({ now?, world? })` implements every route in `shared/src/api.ts` with the real
  server's rules:
  - the inbox is ordered newest first, and a thread that resurfaces (unsnoozed or restored) goes to the top;
  - paging uses a `${sortKey}:${id}` cursor: 50 threads per page by default, at most 200;
  - lists filter by `accountId` and `groupId`, `includeDone=1` adds threads done in the last 30 days, and group counts
    are computed live;
  - writes need the `x-supermail: 1` header;
  - done, snooze, unsnooze, move, read, teach, restore, report spam and Not spam each return an `undoId`; undoing one
    returns a new `undoId` that redoes it;
  - `POST /api/threads/bulk` and `POST /api/teach/bulk` act on many threads with one undo, and send `bulk.settled`. Its
    writes land at once here, so to see a partial failure ask "Gmail" to refuse the next few:
    `curl -X POST localhost:5199/api/mock/refuse-writes -H 'x-supermail: 1' -H 'content-type: application/json' -d '{"count":3}'`;
  - `POST /api/mock/deliver` with `{"count":300}` delivers that many new threads at once, for trying a big selection;
  - spam is left out of the inbox, search, skipped and the attachment route, and Not spam ranks a thread first;
  - teaching regroups every thread from the same sender, domain or list, adds a row to `/api/teaching`, replaces the
    opposite kind on the same match (undo puts it back), and returns `affected`;
  - `/api/teach/preview` gives the email's sender, domain (none for free mail) and list with inbox and snoozed counts;
  - removing a row puts its inbox and snoozed threads back on the next teaching or their earlier guess (Unsorted for a
    thread that was already taught in the fixtures, since those have no guess to go back to);
  - sending a reply adds a message to its thread;
  - search is a case-insensitive substring match over subjects, senders and bodies;
  - attachments are served inline, or as a download with `?download=1`;
  - the push routes keep their devices in memory and push nothing. Turn on installs `sw.js` (the only way it gets
    installed in development) and asks the browser for a real subscription, so that step needs a browser that can
    reach its push service. "Send a test notification" then answers with `preview`, and the app shows that itself:
    the service worker's push handling is not exercised here, `web/test/swPush.test.ts` covers it.

  The handler is a pure function from request to response, so tests can call it without starting a server.
- `plugin.ts`: plugs the handler into the Vite dev server and streams `/api/events` as SSE:
  - a new unread thread arrives every 45 s, and snoozes that have come due resurface;
  - every action sends `thread.updated` and `groups.updated`, as the server does.

All state lives in memory: restarting the dev server resets the mailbox.

## Tests

`web/test/mockApi.test.ts` covers paging, the account and group filters, done → undo, snooze, teach → undo, restore,
send, search, attachment bytes, live mail and the teaching routes.
