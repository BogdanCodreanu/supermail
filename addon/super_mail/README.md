# SuperMail add-on

A local Home Assistant add-on (`local_super_mail`) that runs the SuperMail server. It listens on
`127.0.0.1:8787` only (host network), so your HTTPS reverse proxy on the same host serves it
publicly, for example at `https://mail.example.com`.

## Layout on the host

`deploy/deploy.sh` builds this layout. The Supervisor builds the image on the host from it.

```
/local_apps/super_mail/
  config.yaml  Dockerfile  .dockerignore   copied from addon/super_mail/
  ...                                      the repo, without node_modules, dist, .git, .data
/addon_configs/local_super_mail/client_secret.json   Google OAuth client JSON, mode 600 (/config in the container)
```

Newer Home Assistant OS releases show the config folder as `/app_configs` in the SSH shell; the
deploy script handles both.

The add-on's `/data` holds `options.json` (written by Home Assistant), `supermail.db` (the index and
your teaching), the body cache, logs, and `secret.key`, which encrypts the refresh tokens and the
push keys.

## Options

| Option | Default | Meaning |
|---|---|---|
| `owner_email` | *(required)* | The only Google address allowed to sign in before any account is connected |
| `public_url` | *(required)* | The HTTPS address SuperMail is served at, such as `https://mail.example.com`; the base for the OAuth redirect `/auth/google/callback` |
| `port` | `8787` | Port on 127.0.0.1. The reverse proxy must point at it |
| `body_cache_mb` | `1024` | Body cache limit; the oldest-accessed bodies are evicted first |
| `index_mb` | `1024` | Index limit; the oldest archived threads are pruned first |
| `logs_mb` | `50` | Log limit; logs rotate |
| `total_mb` | `3072` | Hard ceiling for `/data`; above it caching and history indexing stop |
| `min_free_disk_gb` | `20` | Free space to leave on the host's disk; below it, the same as the ceiling |

Until `owner_email` and `public_url` are set, the add-on stops at startup and its log says which
option is missing.

## Backups

`backup_exclude: ["secret.key"]` keeps the token key out of Home Assistant backups. After restoring
a backup, the tokens cannot be decrypted: each account shows **Reconnect**, and one click per
account fixes it. No mail or teaching is touched. The push keys cannot be read either, so new ones
are made and the old subscriptions are dropped: Settings shows **Turn notifications on again** on
each device.

## Startup

`run.sh` exits with a clear message if `/config/client_secret.json` is absent. Run
`deploy/deploy.sh` (or `deploy/deploy.sh --force-secret` to replace the file), then start the app.
The server runs with `NODE_OPTIONS=--max-old-space-size=256`; steady state should stay under about
400 MB RSS.

## Building locally

```sh
docker buildx build --platform linux/arm64 -f addon/super_mail/Dockerfile .
```

Arm64 builds on an x86 machine need QEMU binfmt. Without it, build with `--platform linux/amd64` to
check the image. The same Dockerfile is used by `docker-compose.yml` for plain Docker.

## Deploy, DNS and reverse proxy

Copy `deploy/deploy.env.example` to `deploy/deploy.env` (gitignored) and fill in your values. Each
step below changes something outside your computer, so check the values first.

1. `deploy/deploy.sh` syncs the files to `DEPLOY_HOST`, copies the client JSON if it is absent,
   then installs or rebuilds the app and starts it. Set `owner_email` and `public_url` in the
   add-on's Configuration tab and restart it.
2. `deploy/render.sh` fills `deploy/route53-cname.json.tmpl` and `deploy/caddy-site.caddy.tmpl` into
   `deploy/out/` and prints the commands that apply them: a CNAME from your domain to your dynamic
   DNS name, and a Caddy site block that proxies to `127.0.0.1:8787`.
3. Apply the DNS change, append the Caddy block to your reverse proxy's configuration and reload it.
   Leave your existing site blocks as they are.
4. `deploy/verify.sh` checks DNS, TLS, `/privacy` → 200, `/api/accounts` → 401, the app state
   and memory.
