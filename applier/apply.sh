#!/usr/bin/env bash
# apply.sh — host-side applier for the CloudHosting AI Panel.
#
# The web panel container is UNPRIVILEGED: it can only WRITE to the shared /data
# volume and then `touch /data/.apply-request`. It cannot reach docker. This
# script runs ON THE HOST (via a systemd path unit watching .apply-request) and
# is the only thing allowed to drive docker compose. Keeping docker control on
# the host — not in the web surface — is the whole point.
#
# What it does:
#   1. Reads PRODUCT (env, or /etc/cloudhosting-panel.env, or argv[1]).
#   2. For AGENT products (hermes/openclaw): restarts the agent service so it
#      re-reads the config the panel just wrote (config.yaml/openclaw.json + .env).
#   3. For BUILDER products: nothing to restart (provider/key is set in the
#      product's own UI), so it just logs and exits 0.
#
# Configure these paths per VM (env or /etc/cloudhosting-panel.env):
#   PRODUCT            hermes | openclaw | flowise | langflow | dify
#   COMPOSE_FILE       absolute path to the product's docker-compose.yml
#   COMPOSE_PROJECT_DIR (optional) dir to run compose from (defaults to dirname COMPOSE_FILE)
#   DATA_DIR           the shared data dir (default /srv/ai-vms/<product>/data)
#
# Idempotent and safe to re-run.

set -euo pipefail

ENV_FILE="${PANEL_APPLIER_ENV:-/etc/cloudhosting-panel.env}"
# shellcheck disable=SC1090
[ -f "${ENV_FILE}" ] && . "${ENV_FILE}"

PRODUCT="${PRODUCT:-${1:-}}"
DATA_DIR="${DATA_DIR:-/data}"

log() { printf '[applier %s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { printf '[applier ERROR] %s\n' "$*" >&2; exit 1; }

[ -n "${PRODUCT}" ] || die "PRODUCT is not set (env, ${ENV_FILE}, or argv[1])."

# Map product -> docker compose SERVICE NAME to restart (from the sibling repos).
case "${PRODUCT}" in
  hermes)   SERVICE="gateway" ;;
  openclaw) SERVICE="openclaw-gateway" ;;
  flowise|langflow|dify)
    log "Product '${PRODUCT}' is a BUILDER: provider/key is configured in its own UI."
    log "Nothing to restart from the panel. Exiting 0."
    exit 0
    ;;
  *) die "Unknown PRODUCT '${PRODUCT}'." ;;
esac

command -v docker >/dev/null 2>&1 || die "docker not found on host."
docker compose version >/dev/null 2>&1 || die "docker compose v2 required."

# Locate the product's compose file.
if [ -z "${COMPOSE_FILE:-}" ]; then
  for guess in \
    "/srv/ai-vms/${PRODUCT}-vm/docker-compose.yml" \
    "/srv/avots-vm/${PRODUCT}/docker-compose.yml" \
    "/srv/ai-vms/${PRODUCT}/docker-compose.yml"; do
    if [ -f "${guess}" ]; then COMPOSE_FILE="${guess}"; break; fi
  done
fi
[ -n "${COMPOSE_FILE:-}" ] && [ -f "${COMPOSE_FILE}" ] \
  || die "COMPOSE_FILE not set/found. Set it in ${ENV_FILE}."

PROJECT_DIR="${COMPOSE_PROJECT_DIR:-$(dirname "${COMPOSE_FILE}")}"

# Sanity: confirm a config artifact the panel writes is present before bouncing.
case "${PRODUCT}" in
  hermes)   CFG="${DATA_DIR}/config.yaml" ;;
  openclaw) CFG="${DATA_DIR}/openclaw.json" ;;
esac
if [ ! -f "${CFG}" ]; then
  log "WARN: expected config ${CFG} not found yet; restarting anyway so the agent re-reads .env."
fi

log "PRODUCT=${PRODUCT} SERVICE=${SERVICE} COMPOSE_FILE=${COMPOSE_FILE}"
log "Restarting service '${SERVICE}' so it picks up the new config..."

# --project-directory keeps relative volume paths (./data) resolving correctly.
docker compose --project-directory "${PROJECT_DIR}" -f "${COMPOSE_FILE}" restart "${SERVICE}"

log "Restart issued for '${SERVICE}'. Done."
