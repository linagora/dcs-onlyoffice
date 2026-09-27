#!/bin/sh
# Creates deploy/.env from deploy/.env.example with freshly generated secrets.
# On an existing deploy/.env, adds the secrets an upgrade introduces and
# changes nothing else: other new settings have defaults in the Compose file.
set -eu
umask 077

DEPLOY_DIR=$(cd "$(dirname "$0")/.." && pwd)
ENV_FILE="$DEPLOY_DIR/.env"
EXAMPLE="$DEPLOY_DIR/.env.example"

SECRETS="ONLYOFFICE_JWT_SECRET OIDC_CLIENT_SECRET OPENTDF_DB_PASSWORD DIRECTORY_DB_PASSWORD DIRECTORY_READER_PASSWORD OPENTDF_PROVISIONER_CLIENT_SECRET DIRECTORY_ADMINISTRATION_SECRET"

# A line of .env.example, with a fresh value when it is an empty secret.
with_secret() {
  case "$1" in
    OPENTDF_DB_PASSWORD=)
      printf '%s%s\n' "$1" "$(openssl rand -hex 24)" ;;
    ONLYOFFICE_JWT_SECRET= | OIDC_CLIENT_SECRET= | DIRECTORY_DB_PASSWORD= | DIRECTORY_READER_PASSWORD= | \
      OPENTDF_PROVISIONER_CLIENT_SECRET= | DIRECTORY_ADMINISTRATION_SECRET=)
      printf '%s%s\n' "$1" "$(openssl rand -hex 32)" ;;
    *)
      printf '%s\n' "$1" ;;
  esac
}

if [ ! -e "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    with_secret "$line"
  done < "$EXAMPLE" > "$ENV_FILE"
  echo "created $ENV_FILE"
  exit 0
fi

# Appended settings must start on a line of their own.
if [ -s "$ENV_FILE" ] && [ -n "$(tail -c 1 "$ENV_FILE")" ]; then
  echo >> "$ENV_FILE"
fi
added=0
for name in $SECRETS; do
  if ! grep -q "^$name=" "$ENV_FILE"; then
    with_secret "$name=" >> "$ENV_FILE"
    echo "added $name"
    added=$((added + 1))
  fi
done
echo "$ENV_FILE had $added missing secret(s)"
