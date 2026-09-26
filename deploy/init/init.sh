#!/bin/sh
# One-shot initialisation of the stack's volumes. Safe to run on every start:
# nothing that already exists is overwritten.
set -eu

DOCUMENTS=/data/documents
PKI_PUBLIC=/pki/public
PKI_PRIVATE=/pki/private
PORTAL_UID=1000

seed_demo_documents() {
  mkdir -p "$DOCUMENTS"
  for source in /demo/documents/*.docx; do
    target="$DOCUMENTS/$(basename "$source")"
    if [ ! -e "$target" ]; then
      cp "$source" "$target"
      echo "seeded $(basename "$source")"
    fi
  done
  chown -R "$PORTAL_UID:$PORTAL_UID" "$DOCUMENTS"
}

# Local certificate authority used by the standalone reverse proxy. Services
# only receive the public certificate, to trust the proxy's host names.
create_local_ca() {
  mkdir -p "$PKI_PUBLIC" "$PKI_PRIVATE"
  chmod 700 "$PKI_PRIVATE"
  if [ ! -e "$PKI_PRIVATE/ca.key" ]; then
    openssl ecparam -name prime256v1 -genkey -noout -out "$PKI_PRIVATE/ca.key"
    openssl req -x509 -new -key "$PKI_PRIVATE/ca.key" -sha256 -days 3650 \
      -subj "/O=DCS ONLYOFFICE demo/CN=DCS ONLYOFFICE local CA" \
      -addext "basicConstraints=critical,CA:TRUE" \
      -addext "keyUsage=critical,keyCertSign,cRLSign" \
      -out "$PKI_PUBLIC/ca.crt"
    chmod 600 "$PKI_PRIVATE/ca.key"
    chmod 644 "$PKI_PUBLIC/ca.crt"
    echo "created the local certificate authority"
  fi
}

seed_demo_documents
create_local_ca
