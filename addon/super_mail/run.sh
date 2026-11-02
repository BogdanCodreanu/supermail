#!/bin/sh
# SuperMail entrypoint, for the Home Assistant add-on and for plain Docker.
# As the add-on, options come from /data/options.json (read by the server); in plain Docker, from SUPERMAIL_* variables.
set -eu

CLIENT_FILE=${SUPERMAIL_CLIENT_FILE:-/config/client_secret.json}

if [ ! -f "$CLIENT_FILE" ]; then
  echo "[supermail] FATAL: the Google OAuth client JSON is missing at $CLIENT_FILE." >&2
  echo "[supermail] As the Home Assistant add-on: copy it into the add-on's config folder as client_secret.json." >&2
  echo "[supermail] With Docker Compose: mount it read-only at $CLIENT_FILE (see docker-compose.yml)." >&2
  echo "[supermail] How to create it: docs/google-cloud-setup.md. Then start SuperMail again." >&2
  exit 1
fi

cd /app
exec node server/dist/main.js
