#!/bin/sh
# Starts the standalone stack in one command, on a machine with Docker and
# OpenSSL: writes deploy/.env with fresh secrets on the first run, and on
# later runs sets only the secrets an upgrade brings; then builds and starts
# the stack, waits until it is healthy, and tells where to go and how to sign
# in.
set -eu

DEPLOY_DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$DEPLOY_DIR"

scripts/init-env.sh

# A setting as Compose reads it: the environment's, else that of deploy/.env,
# without the quotes around it.
setting() {
  value=$(printenv "$1" || true)
  if [ -z "$value" ]; then
    value=$(sed -n "s/^$1=//p" .env | tail -n 1 | sed "s/^\([\"']\)\(.*\)\1\$/\2/")
  fi
  printf '%s' "$value"
}

case ",$(setting COMPOSE_PROFILES)," in
  *,standalone,*) ;;
  *)
    echo "deploy/.env does not enable the standalone profile: this script starts the standalone stack only. docs/hosting.md shows how to start a hosted stack." >&2
    exit 1 ;;
esac

# ONLYOFFICE Docs takes a few minutes to become healthy on a first start.
docker compose up -d --build --wait --wait-timeout 900

DOMAIN=$(setting DOMAIN)
case "$DOMAIN" in
  localhost | *.localhost) RESOLUTION="Chrome and Firefox reach these names without any change; another browser,
such as Safari, needs them in /etc/hosts, as the README shows." ;;
  *) RESOLUTION="Point these names to this machine, for instance in /etc/hosts, as the README
shows." ;;
esac
cat <<END

The stack is up.

  Portal                   https://portail.$DOMAIN
  ONLYOFFICE Docs          https://docs.$DOMAIN
  OpenTDF platform         https://tdf.$DOMAIN
  Local identity provider  https://idp.$DOMAIN

Sign in with a fictional account; the password is the login. The README
lists their clearances.

  alice   French officer, administrator: reads every label of the demo policy
  bob     allied officer: reads every label but DIFFUSION RESTREINTE – SPÉCIAL FRANCE
  chloe   reads NON PROTÉGÉ only
  dan     for the tests: holds no clearance
  erin    for the tests: holds a clearance that has ended

$RESOLUTION
Your browser warns about the stack's local certificate authority the first
time. To stop the stack and delete its data: docker compose down -v, in
deploy/.
END
