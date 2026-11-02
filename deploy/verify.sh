#!/usr/bin/env bash
# Read-only checks that SuperMail is live at https://$SUPERMAIL_DOMAIN. Run from your computer.
# Exits non-zero if any check fails.
#
# Settings come from deploy/deploy.env: SUPERMAIL_DOMAIN, plus DNS_TARGET for the DNS check and
# DEPLOY_HOST for the Home Assistant checks (each is skipped when unset).
set -uo pipefail
. "$(dirname "$0")/lib.sh"
load_env
require SUPERMAIL_DOMAIN

HOST=$SUPERMAIL_DOMAIN
APP=local_super_mail
MAX_MEM_MIB=400

failures=0
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; failures=$((failures + 1)); }

# DNS: the CNAME points at DNS_TARGET.
if [ -n "${DNS_TARGET:-}" ]; then
  dns=$(dig +short "$HOST" 2>/dev/null)
  if grep -qxF -e "$DNS_TARGET" -e "$DNS_TARGET." <<<"$dns"; then pass "dig $HOST -> $DNS_TARGET"
  else fail "dig $HOST does not include $DNS_TARGET (got: ${dns:-nothing})"; fi
fi

# Public privacy page: 200 over a certificate curl trusts (no -k).
read -r code verify < <(curl -s -o /dev/null -I -w '%{http_code} %{ssl_verify_result}\n' --max-time 20 "https://$HOST/privacy" || echo "000 -1")
if [ "$code" = 200 ] && [ "$verify" = 0 ]; then pass "GET /privacy -> 200 with a valid certificate"
else fail "GET /privacy -> HTTP $code, ssl_verify_result $verify"; fi

# The API needs a session.
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$HOST/api/accounts" || echo 000)
if [ "$code" = 401 ]; then pass "GET /api/accounts without a session -> 401"
else fail "GET /api/accounts without a session -> $code (want 401)"; fi

# On the Home Assistant host: the app is started and under the memory budget. The HA OS SSH shell
# has no `docker`, so memory comes from the Supervisor's stats (same container numbers as docker stats).
if [ -n "${DEPLOY_HOST:-}" ]; then
  state=$(ssh "$DEPLOY_HOST" "ha apps info $APP --raw-json | jq -r '.data.state'" 2>/dev/null)
  if [ "$state" = started ]; then pass "ha apps info $APP: state started"
  else fail "ha apps info $APP: state ${state:-unknown} (want started)"; fi

  mem_bytes=$(ssh "$DEPLOY_HOST" "ha apps stats $APP --raw-json | jq -r '.data.memory_usage'" 2>/dev/null)
  if [[ "$mem_bytes" =~ ^[0-9]+$ ]]; then
    mem_mib=$((mem_bytes / 1024 / 1024))
    if [ "$mem_mib" -lt "$MAX_MEM_MIB" ]; then pass "memory ${mem_mib} MiB < ${MAX_MEM_MIB} MiB"
    else fail "memory ${mem_mib} MiB >= ${MAX_MEM_MIB} MiB"; fi
  else
    fail "could not read memory usage for $APP"
  fi
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
