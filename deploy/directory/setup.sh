#!/bin/sh
# Creates the clearance directory's roles and schema in the stack's
# PostgreSQL, idempotently, as the database superuser on every start. The
# policy service owns the schema, creates its table and grants OpenTDF's
# reader role the columns an access decision needs.
set -eu

psql -v ON_ERROR_STOP=1 -q \
  -v directory_password="$DIRECTORY_DB_PASSWORD" \
  -v reader_password="$DIRECTORY_READER_PASSWORD" <<'SQL'
SELECT 'CREATE ROLE dcs_directory LOGIN'
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dcs_directory')\gexec
SELECT 'CREATE ROLE dcs_directory_reader LOGIN'
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dcs_directory_reader')\gexec
ALTER ROLE dcs_directory PASSWORD :'directory_password';
ALTER ROLE dcs_directory_reader PASSWORD :'reader_password';
CREATE SCHEMA IF NOT EXISTS directory AUTHORIZATION dcs_directory;
GRANT USAGE ON SCHEMA directory TO dcs_directory_reader;
SQL
echo "dcs: clearance directory roles and schema ready"
