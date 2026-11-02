# Shared by deploy.sh, render.sh and verify.sh: loads deploy/deploy.env and fills templates.
# shellcheck shell=bash

DEPLOY_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$DEPLOY_DIR/.." && pwd)
ENV_FILE=$DEPLOY_DIR/deploy.env

load_env() {
  if [ ! -f "$ENV_FILE" ]; then
    echo "deploy/deploy.env is missing." >&2
    echo "Copy deploy/deploy.env.example to deploy/deploy.env and fill in your values, then run this again." >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  SUPERMAIL_PORT=${SUPERMAIL_PORT:-8787}
}

# require VAR...: stop with a clear message if any of them is empty.
require() {
  local missing=()
  for name in "$@"; do
    [ -n "${!name:-}" ] || missing+=("$name")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    echo "deploy/deploy.env does not set: ${missing[*]}" >&2
    exit 1
  fi
}

# render TEMPLATE: prints the template with every ${NAME} replaced by that variable's value.
render() {
  local text name
  text=$(<"$1")
  for name in $(grep -o '\${[A-Z_][A-Z0-9_]*}' "$1" | sort -u | tr -d '${}'); do
    text=${text//"\${$name}"/"${!name:-}"}
  done
  printf '%s\n' "$text"
}
