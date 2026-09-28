#!/bin/sh
# Creates deploy/.env from deploy/.env.example with freshly generated secrets.
# On an existing deploy/.env, sets the secrets that are missing or empty, such
# as those an upgrade introduces, and changes nothing else: other new settings
# have defaults in the Compose file.
set -eu
umask 077

DEPLOY_DIR=$(cd "$(dirname "$0")/.." && pwd)
ENV_FILE="$DEPLOY_DIR/.env"
EXAMPLE="$DEPLOY_DIR/.env.example"

SECRETS="ONLYOFFICE_JWT_SECRET OIDC_CLIENT_SECRET OPENTDF_DB_PASSWORD OPENTDF_PLATFORM_DB_PASSWORD DIRECTORY_DB_PASSWORD DIRECTORY_READER_PASSWORD OPENTDF_PROVISIONER_CLIENT_SECRET DIRECTORY_ADMINISTRATION_SECRET OPENTDF_KAS_ROOT_KEY BINDING_SIGNING_KEY BINDING_SIGNING_CERTIFICATE BINDING_SIGNATURE_SECRET"

# The demo key that signs document label bindings, ECDSA P-256 as
# ADatP-4778.2 requires, and its self-signed certificate: generated once per
# run, so that the key and the certificate match.
SIGNER_DIR=$(mktemp -d)
trap 'rm -rf "$SIGNER_DIR" "$ENV_FILE.new"' EXIT
signer() {
  if [ ! -s "$SIGNER_DIR/certificate.pem" ]; then
    openssl ecparam -name prime256v1 -genkey -noout -out "$SIGNER_DIR/key.pem"
    openssl req -new -x509 -key "$SIGNER_DIR/key.pem" -out "$SIGNER_DIR/certificate.pem" -days 3650 \
      -subj "/CN=DCS ONLYOFFICE demo binding signer"
  fi
  openssl base64 -A < "$SIGNER_DIR/$1"
}

# A line of .env.example, with a fresh value when it is an empty secret.
with_secret() {
  case "$1" in
    OPENTDF_DB_PASSWORD=)
      printf '%s%s\n' "$1" "$(openssl rand -hex 24)" ;;
    ONLYOFFICE_JWT_SECRET= | OIDC_CLIENT_SECRET= | OPENTDF_PLATFORM_DB_PASSWORD= | DIRECTORY_DB_PASSWORD= | \
      DIRECTORY_READER_PASSWORD= | OPENTDF_PROVISIONER_CLIENT_SECRET= | DIRECTORY_ADMINISTRATION_SECRET= | \
      OPENTDF_KAS_ROOT_KEY= | BINDING_SIGNATURE_SECRET=)
      printf '%s%s\n' "$1" "$(openssl rand -hex 32)" ;;
    BINDING_SIGNING_KEY=)
      printf '%s%s\n' "$1" "$(signer key.pem)" ;;
    BINDING_SIGNING_CERTIFICATE=)
      printf '%s%s\n' "$1" "$(signer certificate.pem)" ;;
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

# Whether deploy/.env gives a setting a value.
is_set() {
  grep -q "^$1=." "$ENV_FILE"
}

# A key or a certificate generated now would not match the other one.
key_set=false
certificate_set=false
is_set BINDING_SIGNING_KEY && key_set=true
is_set BINDING_SIGNING_CERTIFICATE && certificate_set=true
if [ "$key_set" != "$certificate_set" ]; then
  echo "$ENV_FILE sets only one of BINDING_SIGNING_KEY and BINDING_SIGNING_CERTIFICATE, which go together: set the other, or empty both for a new demo pair" >&2
  exit 1
fi

missing=""
for name in $SECRETS; do
  if ! is_set "$name"; then
    missing="$missing $name"
  fi
done

# A line of deploy/.env, with a fresh value when it is a missing secret.
filled() {
  case "$1" in
    *=)
      case " $missing " in
        *" ${1%=} "*)
          with_secret "$1"
          return ;;
      esac ;;
  esac
  printf '%s\n' "$1"
}

if [ -n "$missing" ]; then
  {
    while IFS= read -r line || [ -n "$line" ]; do
      filled "$line"
    done < "$ENV_FILE"
    # Secrets without even an empty line.
    for name in $missing; do
      grep -q "^$name=" "$ENV_FILE" || with_secret "$name="
    done
  } > "$ENV_FILE.new"
  mv "$ENV_FILE.new" "$ENV_FILE"
fi
count=0
for name in $missing; do
  echo "set $name"
  count=$((count + 1))
done
echo "$ENV_FILE had $count missing secret(s)"
