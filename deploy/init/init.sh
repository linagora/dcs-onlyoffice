#!/bin/sh
# One-shot initialisation of the stack's volumes. Safe to run on every start.
set -eu

DOCUMENTS=/data/documents
PORTAL_UID=1000

mkdir -p "$DOCUMENTS"
for source in /demo/documents/*.docx; do
  target="$DOCUMENTS/$(basename "$source")"
  if [ ! -e "$target" ]; then
    cp "$source" "$target"
    echo "seeded $(basename "$source")"
  fi
done
chown -R "$PORTAL_UID:$PORTAL_UID" "$DOCUMENTS"
