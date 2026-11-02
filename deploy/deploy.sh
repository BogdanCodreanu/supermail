#!/usr/bin/env bash
# Deploy SuperMail to a Home Assistant host as the local add-on `local_super_mail`.
# Run from your computer (any directory). It changes the remote host: check deploy/deploy.env first.
#
#   deploy/deploy.sh [--force-secret]
#
#   --force-secret   overwrite the client JSON already on the host
#
# Settings come from deploy/deploy.env (copy deploy/deploy.env.example): DEPLOY_HOST, an ssh
# destination whose shell has the `ha` CLI, and SUPERMAIL_CLIENT_FILE.
#
# The client secret is copied file-to-file and never printed.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
load_env
require DEPLOY_HOST SUPERMAIL_CLIENT_FILE SUPERMAIL_OWNER_EMAIL SUPERMAIL_DOMAIN

HOST=$DEPLOY_HOST
CLIENT_FILE=$SUPERMAIL_CLIENT_FILE
APP=local_super_mail
APP_DIR=/local_apps/super_mail

FORCE_SECRET=0
for arg in "$@"; do
  case $arg in
    --force-secret) FORCE_SECRET=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '[deploy] %s\n' "$*"; }

# 1. The repo at the add-on folder root (the build context), with config.yaml, Dockerfile and
#    .dockerignore copied to that root where the Supervisor looks for them. The Supervisor scans
#    for config.yaml recursively, so the repo's own addon/super_mail/config.yaml must NOT reach the
#    host: it would register that nested folder (no sources in it) as the add-on and build it instead.
log "syncing the repo to $HOST:$APP_DIR/"
ssh "$HOST" "mkdir -p $APP_DIR"
rsync -rlptz --delete \
  --exclude node_modules --exclude .data --exclude .git --exclude .superpowers \
  --exclude dist --exclude '*.tsbuildinfo' --exclude .tsbuild --exclude '*.db' --exclude '*.db-*' \
  --exclude '.env*' --exclude 'client_secret*.json' --exclude '*.pem' \
  --exclude /deploy/deploy.env --exclude /deploy/out \
  --exclude '/config.yaml' --exclude '/Dockerfile' --exclude '/.dockerignore' \
  --exclude '/addon/super_mail/config.yaml' --delete-excluded \
  "$REPO/" "$HOST:$APP_DIR/"
log "placing config.yaml, Dockerfile and .dockerignore at $APP_DIR/"
scp -q "$REPO/addon/super_mail/config.yaml" "$REPO/addon/super_mail/Dockerfile" "$HOST:$APP_DIR/"
scp -q "$REPO/addon/super_mail/Dockerfile.dockerignore" "$HOST:$APP_DIR/.dockerignore"

# 2. OAuth client JSON into the add-on's config folder (/config inside the container).
# HA OS's SSH shell names it /app_configs; older releases use /addon_configs.
CONFIG_ROOT=$(ssh "$HOST" 'if [ -d /app_configs ]; then echo /app_configs; elif [ -d /addon_configs ]; then echo /addon_configs; fi')
if [ -z "$CONFIG_ROOT" ]; then
  echo "[deploy] neither /app_configs nor /addon_configs exists on $HOST" >&2
  exit 1
fi
SECRET_DEST=$CONFIG_ROOT/$APP/client_secret.json
if [ "$FORCE_SECRET" = 1 ] || ! ssh "$HOST" "test -f $SECRET_DEST"; then
  if [ ! -f "$CLIENT_FILE" ]; then
    echo "[deploy] client JSON not found at $CLIENT_FILE" >&2
    exit 1
  fi
  log "copying the OAuth client JSON to $HOST:$SECRET_DEST (mode 600)"
  ssh "$HOST" "mkdir -p $CONFIG_ROOT/$APP"
  scp -q "$CLIENT_FILE" "$HOST:$SECRET_DEST.tmp"
  ssh "$HOST" "chmod 600 $SECRET_DEST.tmp && mv $SECRET_DEST.tmp $SECRET_DEST"
else
  log "client JSON already on the host (use --force-secret to replace it)"
fi

# 3. Install the first time, otherwise rebuild; then make sure it runs.
log "reloading the app store"
ssh "$HOST" 'ha store reload'
# The reload is applied asynchronously: wait until the Supervisor reports this version.
WANT=$(sed -n 's/^version: *"\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' "$REPO/addon/super_mail/config.yaml")
for _ in $(seq 1 40); do
  GOT=$(ssh "$HOST" "ha apps info $APP --raw-json | jq -r '.data.version_latest // empty'")
  [ "$GOT" = "$WANT" ] && break
  sleep 3
done
if [ "$GOT" != "$WANT" ]; then
  echo "[deploy] Supervisor still reports version '$GOT', expected '$WANT' after the store reload" >&2
  exit 1
fi
VERSION=$(ssh "$HOST" "ha apps info $APP --raw-json | jq -r '.data.version // empty'")
if [ -z "$VERSION" ] || [ "$VERSION" = null ]; then
  log "installing $APP (first time; builds the image on the host)"
  ssh "$HOST" "ha apps install $APP"
elif [ "$VERSION" != "$WANT" ]; then
  log "updating $APP from $VERSION to $WANT (rebuilds the image)"
  ssh "$HOST" "ha apps update $APP"
else
  log "rebuilding $APP (same version $VERSION)"
  ssh "$HOST" "ha apps rebuild $APP"
fi
# The add-on's options have empty defaults (nothing personal is committed), and the Supervisor can reset them to
# those defaults on an update. Set owner_email and public_url from deploy.env every time, through the Supervisor
# API (the `ha` CLI cannot set options), restarting only if something changed.
OPTIONS=$(ssh "$HOST" "ha apps info $APP --raw-json | jq -c '.data.options'")
NEW=$(printf '%s' "$OPTIONS" | jq -c --arg e "$SUPERMAIL_OWNER_EMAIL" --arg u "https://$SUPERMAIL_DOMAIN" --argjson p "$SUPERMAIL_PORT" \
  '.owner_email = $e | .public_url = $u | .port = $p')
if [ "$NEW" != "$OPTIONS" ]; then
  log "setting the add-on options owner_email, public_url and port from deploy.env"
  printf '{"options":%s}' "$NEW" | ssh "$HOST" 'curl -sf -X POST -H "Authorization: Bearer $SUPERVISOR_TOKEN" -H "Content-Type: application/json" --data-binary @- http://supervisor/addons/'"$APP"'/options >/dev/null' \
    || { echo "[deploy] could not set the add-on options; set owner_email and public_url in the add-on's Configuration tab" >&2; exit 1; }
  ssh "$HOST" "ha apps restart $APP" >/dev/null 2>&1 || true
fi
STATE=$(ssh "$HOST" "ha apps info $APP --raw-json | jq -r '.data.state'")
if [ "$STATE" != started ]; then
  log "starting $APP"
  ssh "$HOST" "ha apps start $APP"
fi
log "done. Check: ssh $HOST 'ha apps logs $APP' should show 'listening on 127.0.0.1:$SUPERMAIL_PORT'"
