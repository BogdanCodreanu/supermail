#!/usr/bin/env bash
# Fills the DNS and reverse-proxy templates from deploy/deploy.env into deploy/out/ (gitignored),
# and prints the commands that apply them. It changes nothing by itself.
#
#   deploy/render.sh
set -euo pipefail
. "$(dirname "$0")/lib.sh"
load_env
require SUPERMAIL_DOMAIN SUPERMAIL_PORT DNS_TARGET

CADDY_TLS_BLOCK=
if [ -n "${CADDY_TLS_ALPN_PORT:-}" ]; then
  CADDY_TLS_BLOCK=$(printf '\ttls {\n\t\t# only 443 reaches Caddy (as port %s): prove the domain via TLS-ALPN\n\t\tissuer acme {\n\t\t\tdisable_http_challenge\n\t\t\talt_tlsalpn_port %s\n\t\t}\n\t}\n' "$CADDY_TLS_ALPN_PORT" "$CADDY_TLS_ALPN_PORT")
  CADDY_TLS_BLOCK+=$'\n'
fi
export CADDY_TLS_BLOCK

OUT=$DEPLOY_DIR/out
mkdir -p "$OUT"
render "$DEPLOY_DIR/route53-cname.json.tmpl" > "$OUT/route53-cname.json"
render "$DEPLOY_DIR/caddy-site.caddy.tmpl" > "$OUT/supermail.caddy"

cat <<NEXT
Wrote deploy/out/route53-cname.json and deploy/out/supermail.caddy.

DNS (Route 53), outward-facing:
  aws route53 change-resource-record-sets --profile ${AWS_PROFILE:-default} \\
    --hosted-zone-id "\$(aws route53 list-hosted-zones-by-name --profile ${AWS_PROFILE:-default} --dns-name ${ROUTE53_ZONE_NAME:-<your zone>} --query 'HostedZones[0].Id' --output text)" \\
    --change-batch file://deploy/out/route53-cname.json
  (Another DNS provider: create the same CNAME, ${SUPERMAIL_DOMAIN} -> ${DNS_TARGET}, by hand.)

Reverse proxy: append deploy/out/supermail.caddy to your Caddyfile and reload Caddy.
NEXT
