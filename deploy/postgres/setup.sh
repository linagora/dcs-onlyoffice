#!/bin/sh
# Prepares the roles of the stack's PostgreSQL, idempotently, as the database
# superuser on every start, before the services that use them:
# - the OpenTDF platform's role may create schemas, which the platform needs to
#   create its own, and owns those; it has no right on the clearance directory,
#   which only entity resolution reads, through the reader role;
# - the policy service's role owns the clearance directory's schema, creates
#   its table and grants the reader role the columns an access decision needs.
# The platform's role can thus create a schema of any name, such as one a
# role's search path would look in first: every other role searches pg_catalog
# only, and names its tables with their schema.
set -eu

psql -v ON_ERROR_STOP=1 -q \
  -v platform_password="$OPENTDF_PLATFORM_DB_PASSWORD" \
  -v directory_password="$DIRECTORY_DB_PASSWORD" \
  -v reader_password="$DIRECTORY_READER_PASSWORD" <<'SQL'
SET search_path = pg_catalog;
ALTER ROLE CURRENT_USER SET search_path = pg_catalog;

SELECT 'CREATE ROLE dcs_opentdf LOGIN'
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dcs_opentdf')\gexec
SELECT 'CREATE ROLE dcs_directory LOGIN'
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dcs_directory')\gexec
SELECT 'CREATE ROLE dcs_directory_reader LOGIN'
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dcs_directory_reader')\gexec
ALTER ROLE dcs_opentdf PASSWORD :'platform_password';
ALTER ROLE dcs_directory PASSWORD :'directory_password';
ALTER ROLE dcs_directory_reader PASSWORD :'reader_password';
ALTER ROLE dcs_directory SET search_path = pg_catalog;
ALTER ROLE dcs_directory_reader SET search_path = pg_catalog;

-- Each service of the platform keeps its tables in a schema named after the
-- configured one and the service, opentdf_policy for instance. The platform
-- creates it with CREATE SCHEMA IF NOT EXISTS, which needs the right to create
-- schemas even when the schema exists.
GRANT CREATE ON DATABASE opentdf TO dcs_opentdf;

-- Stacks created before this role have the platform's schemas and objects
-- owned by the superuser: hand them over, since the platform's migrations
-- alter them. Indexes, and the sequences, multiranges and array types that
-- belong to another object, follow it.
DO $$
DECLARE
  statement text;
BEGIN
  FOR statement IN
    WITH platform AS (
      SELECT oid, nspname, nspowner FROM pg_namespace WHERE nspname LIKE 'opentdf\_%'
    )
    SELECT format('ALTER SCHEMA %I OWNER TO dcs_opentdf', nspname)
      FROM platform
     WHERE nspowner <> 'dcs_opentdf'::regrole
    UNION ALL
    SELECT format('ALTER %s %I.%I OWNER TO dcs_opentdf',
                  CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE' WHEN 'c' THEN 'TYPE' ELSE 'TABLE' END,
                  platform.nspname, c.relname)
      FROM pg_class c JOIN platform ON platform.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'c') AND c.relowner <> 'dcs_opentdf'::regrole
       AND NOT (c.relkind = 'S' AND EXISTS (
         SELECT FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a', 'i')))
    UNION ALL
    SELECT format('ALTER %s %I.%I OWNER TO dcs_opentdf', CASE t.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, platform.nspname, t.typname)
      FROM pg_type t JOIN platform ON platform.oid = t.typnamespace
     WHERE t.typtype IN ('e', 'd', 'r') AND t.typowner <> 'dcs_opentdf'::regrole
    UNION ALL
    SELECT format('ALTER ROUTINE %s OWNER TO dcs_opentdf', p.oid::regprocedure)
      FROM pg_proc p JOIN platform ON platform.oid = p.pronamespace
     WHERE p.proowner <> 'dcs_opentdf'::regrole
  LOOP
    EXECUTE statement;
  END LOOP;
END
$$;

CREATE SCHEMA IF NOT EXISTS directory AUTHORIZATION dcs_directory;
GRANT USAGE ON SCHEMA directory TO dcs_directory_reader;
SQL
echo "dcs: database roles ready"
