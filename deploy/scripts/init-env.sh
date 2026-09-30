#!/bin/sh
# Creates deploy/.env from deploy/.env.example with freshly generated secrets.
# On an existing deploy/.env, sets the secrets that are missing or empty, such
# as those an upgrade introduces, and changes nothing else: other new settings
# have defaults in the Compose file. The one exception is the self-signed demo
# signing key of earlier versions, which gives way to a key that a demo
# certificate authority certifies.
set -eu
umask 077

DEPLOY_DIR=$(cd "$(dirname "$0")/.." && pwd)
ENV_FILE="$DEPLOY_DIR/.env"
EXAMPLE="$DEPLOY_DIR/.env.example"

SECRETS="ONLYOFFICE_JWT_SECRET OIDC_CLIENT_SECRET OPENTDF_DB_PASSWORD OPENTDF_PLATFORM_DB_PASSWORD DIRECTORY_DB_PASSWORD DIRECTORY_READER_PASSWORD JOURNAL_DB_PASSWORD OPENTDF_PROVISIONER_CLIENT_SECRET DIRECTORY_ADMINISTRATION_SECRET OPENTDF_KAS_ROOT_KEY BINDING_SIGNATURE_SECRET"
# The settings of the demo key that signs document label bindings and of its
# certificate, set together; with those of the demo authority that issues the
# certificate, when deploy/.env has none.
SIGNER_SETTINGS="BINDING_SIGNING_KEY BINDING_SIGNING_CERTIFICATE"
AUTHORITY_SETTINGS="BINDING_TRUST_ANCHORS BINDING_AUTHORITY_KEY"

# Where the keys and certificates are generated.
KEY_DIR=$(mktemp -d)
trap 'rm -rf "$KEY_DIR" "$ENV_FILE.new"' EXIT
cat > "$KEY_DIR/extensions.cnf" << 'EXTENSIONS'
[ authority ]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
[ signer ]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
EXTENSIONS

# OpenSSL reports on each certificate it signs: shown only when it fails.
quietly() {
  if ! output=$("$@" 2>&1); then
    printf '%s\n' "$output" >&2
    return 1
  fi
}

# Whether deploy/.env gives a setting a value.
is_set() {
  grep -q "^$1=." "$ENV_FILE"
}

# A value that deploy/.env sets.
value_of() {
  sed -n "s/^$1=//p" "$ENV_FILE" | head -n 1
}

# A generated key or certificate, base64-encoded to fit on one line.
encoded() {
  openssl base64 -A < "$KEY_DIR/$1"
}

# A new demo signing key, ECDSA P-256 as ADatP-4778.2 requires, and its
# certificate, which the demo authority issues: deploy/.env's, whose
# certificate is the first trust anchor, else a new one. Generated before
# deploy/.env is written, so that a failure leaves it unchanged.
new_signer() {
  if [ -e "$ENV_FILE" ] && is_set BINDING_AUTHORITY_KEY; then
    value_of BINDING_AUTHORITY_KEY | openssl base64 -d -A > "$KEY_DIR/authority.key"
    value_of BINDING_TRUST_ANCHORS | openssl base64 -d -A | openssl x509 -out "$KEY_DIR/authority.pem"
  else
    openssl ecparam -name prime256v1 -genkey -noout -out "$KEY_DIR/authority.key"
    openssl req -new -key "$KEY_DIR/authority.key" -subj "/CN=DCS ONLYOFFICE demo signing authority" -out "$KEY_DIR/authority.csr"
    quietly openssl x509 -req -in "$KEY_DIR/authority.csr" -signkey "$KEY_DIR/authority.key" -days 3650 -sha256 \
      -extfile "$KEY_DIR/extensions.cnf" -extensions authority -out "$KEY_DIR/authority.pem"
  fi
  openssl ecparam -name prime256v1 -genkey -noout -out "$KEY_DIR/key.pem"
  openssl req -new -key "$KEY_DIR/key.pem" -subj "/CN=DCS ONLYOFFICE demo binding signer" -out "$KEY_DIR/signer.csr"
  quietly openssl x509 -req -in "$KEY_DIR/signer.csr" -CA "$KEY_DIR/authority.pem" -CAkey "$KEY_DIR/authority.key" \
    -set_serial "0x$(openssl rand -hex 16)" -days 3650 -sha256 -extfile "$KEY_DIR/extensions.cnf" -extensions signer \
    -out "$KEY_DIR/certificate.pem"
}

# A line of .env.example, with a fresh value when it is an empty secret.
with_secret() {
  case "$1" in
    OPENTDF_DB_PASSWORD=)
      printf '%s%s\n' "$1" "$(openssl rand -hex 24)" ;;
    ONLYOFFICE_JWT_SECRET= | OIDC_CLIENT_SECRET= | OPENTDF_PLATFORM_DB_PASSWORD= | DIRECTORY_DB_PASSWORD= | \
      DIRECTORY_READER_PASSWORD= | JOURNAL_DB_PASSWORD= | OPENTDF_PROVISIONER_CLIENT_SECRET= | DIRECTORY_ADMINISTRATION_SECRET= | \
      OPENTDF_KAS_ROOT_KEY= | BINDING_SIGNATURE_SECRET=)
      printf '%s%s\n' "$1" "$(openssl rand -hex 32)" ;;
    BINDING_SIGNING_KEY=)
      printf '%s%s\n' "$1" "$(encoded key.pem)" ;;
    BINDING_SIGNING_CERTIFICATE=)
      printf '%s%s\n' "$1" "$(encoded certificate.pem)" ;;
    BINDING_TRUST_ANCHORS=)
      printf '%s%s\n' "$1" "$(encoded authority.pem)" ;;
    BINDING_AUTHORITY_KEY=)
      printf '%s%s\n' "$1" "$(encoded authority.key)" ;;
    *)
      printf '%s\n' "$1" ;;
  esac
}

# Without OpenSSL, the secrets would be left empty.
require_openssl() {
  if ! command -v openssl > /dev/null 2>&1; then
    echo "OpenSSL generates the secrets of $ENV_FILE: install it, then run this command again" >&2
    exit 1
  fi
}

if [ ! -e "$ENV_FILE" ]; then
  require_openssl
  new_signer
  while IFS= read -r line || [ -n "$line" ]; do
    with_secret "$line"
  done < "$EXAMPLE" > "$ENV_FILE"
  echo "created $ENV_FILE"
  exit 0
fi

# A key or a certificate generated now would not match the other one.
key_set=false
certificate_set=false
is_set BINDING_SIGNING_KEY && key_set=true
is_set BINDING_SIGNING_CERTIFICATE && certificate_set=true
if [ "$key_set" != "$certificate_set" ]; then
  echo "$ENV_FILE sets only one of BINDING_SIGNING_KEY and BINDING_SIGNING_CERTIFICATE, which go together: set the other, or empty both for a new demo pair" >&2
  exit 1
fi
anchors_set=false
is_set BINDING_TRUST_ANCHORS && anchors_set=true
if is_set BINDING_AUTHORITY_KEY && [ "$anchors_set" = false ]; then
  echo "$ENV_FILE sets BINDING_AUTHORITY_KEY without its certificate, the first of BINDING_TRUST_ANCHORS: set it, or empty both" >&2
  exit 1
fi
if [ "$key_set" = false ] && [ "$anchors_set" = true ] && ! is_set BINDING_AUTHORITY_KEY; then
  echo "$ENV_FILE trusts the authorities of BINDING_TRUST_ANCHORS, whose keys it does not hold: set BINDING_SIGNING_KEY and BINDING_SIGNING_CERTIFICATE to a key and a certificate that one of them issued" >&2
  exit 1
fi

# Whether deploy/.env signs with the self-signed demo certificate that this
# script generated before demo authorities existed.
signs_with_self_signed_demo_certificate() {
  value_of BINDING_SIGNING_CERTIFICATE | openssl base64 -d -A > "$KEY_DIR/earlier.pem"
  subject=$(openssl x509 -in "$KEY_DIR/earlier.pem" -noout -subject)
  issuer=$(openssl x509 -in "$KEY_DIR/earlier.pem" -noout -issuer)
  [ "${subject#subject=}" = "${issuer#issuer=}" ] && [ "${subject#*DCS ONLYOFFICE demo binding signer}" != "$subject" ]
}

missing=""
for name in $SECRETS; do
  if ! is_set "$name"; then
    missing="$missing $name"
  fi
done
# Without a signing key, a new one, and the demo authority when there is
# none yet. The self-signed demo certificate gives way to a new key that a
# new demo authority certifies.
replaced=""
if [ "$key_set" = false ]; then
  missing="$missing $SIGNER_SETTINGS"
  [ "$anchors_set" = true ] || missing="$missing $AUTHORITY_SETTINGS"
elif [ "$anchors_set" = false ] && signs_with_self_signed_demo_certificate; then
  replaced="$SIGNER_SETTINGS"
  missing="$missing $AUTHORITY_SETTINGS"
fi

# A line of deploy/.env, with a fresh value when it is a missing secret or a
# replaced one.
filled() {
  name=${1%%=*}
  if [ -n "$replaced" ] && [ "$name" != "$1" ]; then
    case " $replaced " in
      *" $name "*)
        with_secret "$name="
        return ;;
    esac
  fi
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
  require_openssl
  if [ "$key_set" = false ] || [ -n "$replaced" ]; then
    new_signer
  fi
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
if [ -n "$replaced" ]; then
  echo "replaced BINDING_SIGNING_KEY and BINDING_SIGNING_CERTIFICATE, the demo's self-signed pair, with a key that the new demo authority certifies: files signed with the previous key are logged until their next save"
elif [ "$key_set" = true ] && [ "$anchors_set" = false ]; then
  echo "BINDING_TRUST_ANCHORS is empty: the policy service trusts its signing certificate alone, and would log the files signed with it after a change of key. To have a demo authority certify the key instead, empty BINDING_SIGNING_KEY and BINDING_SIGNING_CERTIFICATE, then run this command again"
fi
