#!/bin/sh
# Creates deploy/.env from deploy/.env.example with freshly generated secrets.
# Existing values are never overwritten.
set -eu

DEPLOY_DIR=$(cd "$(dirname "$0")/.." && pwd)
ENV_FILE="$DEPLOY_DIR/.env"

if [ -e "$ENV_FILE" ]; then
  echo "$ENV_FILE already exists, nothing to do"
  exit 0
fi

sed -e "s/^ONLYOFFICE_JWT_SECRET=$/ONLYOFFICE_JWT_SECRET=$(openssl rand -hex 32)/" \
    -e "s/^OIDC_CLIENT_SECRET=$/OIDC_CLIENT_SECRET=$(openssl rand -hex 32)/" \
  "$DEPLOY_DIR/.env.example" > "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "created $ENV_FILE"
