# Google Cloud setup

SuperMail signs in and reads Gmail with your own Google OAuth client. This guide creates one. It
takes about ten minutes and costs nothing: the Gmail API has no charge at personal volumes.

You need:

- a Google account to own the Cloud project (any account; it does not have to be one you read mail from);
- the address you will serve SuperMail at, such as `https://mail.example.com`. You can add more
  addresses later, for example `http://localhost:8787` for local use.

Google renames console pages from time to time. If a label below differs, search the console for it.

## 1. Create a project

1. Open <https://console.cloud.google.com/> and sign in.
2. Open the project picker at the top, and choose **New project**.
3. Name it, for example `SuperMail`, leave the organization as it is, and click **Create**.
4. Make sure the new project is selected in the project picker before you go on.

## 2. Enable the Gmail API

1. Go to **APIs & Services → Library**.
2. Search for **Gmail API**, open it and click **Enable**.

## 3. Set up the consent screen

1. Go to **Google Auth Platform** (also reachable as **APIs & Services → OAuth consent screen**) and
   click **Get started**.
2. **App information:** app name `SuperMail`, and your own address as the user support email.
3. **Audience:** choose **External**. (*Internal* exists only for Google Workspace organizations, and it
   only allows that organization's accounts. If all your accounts are in one Workspace, it is fine too.)
4. **Contact information:** your own address.
5. Agree to the user data policy and click **Create**.
6. Open **Branding** and fill in:
   - **Application home page:** your SuperMail address, such as `https://mail.example.com`;
   - **Application privacy policy link:** `https://mail.example.com/privacy`. SuperMail serves this page
     itself, without sign-in;
   - **Authorized domains:** your domain, such as `example.com`.

   Click **Save**. You can skip the logo: an app with a logo needs brand verification.

## 4. Add the scopes

1. Open **Data Access** and click **Add or remove scopes**.
2. Tick `openid` and `.../auth/userinfo.email`.
3. Under **Manually add scopes**, paste `https://www.googleapis.com/auth/gmail.modify` and click
   **Add to table**. Make sure it is ticked.
4. Click **Update**, then **Save**.

`gmail.modify` lets SuperMail read mail, change labels (which is how Done, snooze and groups work),
archive and send. It does not allow permanent deletion. Google lists it under *restricted scopes*.

## 5. Create the OAuth client

1. Open **Clients** and click **Create client**.
2. **Application type:** **Web application**. Name it, for example `SuperMail web`.
3. Leave **Authorized JavaScript origins** empty.
4. Under **Authorized redirect URIs**, add one entry for every address you will open SuperMail at:
   - `https://mail.example.com/auth/google/callback`
   - `http://localhost:8787/auth/google/callback` (optional, for running it on your computer)

   The address must match SuperMail's public URL exactly, with the scheme and no trailing slash.
5. Click **Create**, then **Download JSON** in the dialog. Google may show the client secret only
   once, so download it now. The file is called something like `client_secret_1234…apps.googleusercontent.com.json`.

Keep this file private. Do not commit it, paste it into an issue or include it in a backup you share.
Where it goes depends on how you run SuperMail:

| How you run it | Put the JSON at |
|---|---|
| Docker Compose | `./client_secret.json` next to `docker-compose.yml` (mounted read-only) |
| Home Assistant add-on | the path in `SUPERMAIL_CLIENT_FILE` in `deploy/deploy.env`; `deploy/deploy.sh` copies it to the add-on's config folder |
| Plain Node | `~/.config/supermail/client_secret.json`, or anywhere with `SUPERMAIL_CLIENT_FILE` |

## 6. Publish the app

1. Open **Audience**.
2. Under **Publishing status**, click **Publish app** and confirm. The status becomes **In production**.
3. Do **not** click **Prepare for verification**, and do not submit the app for verification. A personal
   app does not need it, and verification of a restricted scope requires a paid security assessment.

**Why this matters.** While an app is in **Testing**, Google lets only listed test users sign in, and
it expires their refresh tokens after 7 days, so every account would show **Reconnect** once a week. In
production, refresh tokens last until you revoke them, change that account's password (Google then revokes
tokens with Gmail scopes), or leave them unused for six months.

## 7. Connect your accounts

1. Start SuperMail and open it.
2. Sign in with the owner email you configured.
3. Google shows **"Google hasn't verified this app"**. That is expected: the developer of this app is
   you. Click **Advanced**, then **Go to SuperMail (unsafe)**.
4. Tick the Gmail permission if Google shows it unticked, and continue.
5. In **Settings → Accounts**, click **Connect Gmail** for each further account. Each account goes
   through the same warning once.

An unverified app can be used by up to 100 Google accounts, which is plenty for one person.

## Troubleshooting

| Message | What to do |
|---|---|
| `Error 400: redirect_uri_mismatch` | The redirect URI in the client does not match SuperMail's public URL. Compare the `redirect_uri` in the address bar with step 5, including `http` versus `https` and the port |
| `Error 403: access_denied`, "has not completed the Google verification process" | The app is still in **Testing** and this account is not a test user. Publish it (step 6) |
| An account shows **Reconnect** a week after connecting | The app was in **Testing** when the account connected. Publish it, then click **Reconnect** once |
| "This app is blocked" on a Google Workspace account | The Workspace admin does not allow unverified apps with restricted scopes. The admin can trust the app's client ID under **Security → API controls** |
| 403 "not allowed to sign in" from SuperMail | You signed in with an address that is neither the owner email nor a connected account |
| SuperMail stops at startup with "client JSON is missing" | The JSON is not at the path SuperMail reads; see the table in step 5 |

To revoke SuperMail's access to an account at any time, remove the app at
<https://myaccount.google.com/permissions>. Removing an account in SuperMail deletes its local index,
cache and token.
