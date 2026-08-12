#!/bin/bash
# Runs once, as superuser, on first container init.
#
# Creates the TWO-ROLE separation the whole isolation model depends on
# (PLATFORM_BLUEPRINT.md §2.1):
#
#   app_migrator — owns the schema, BYPASSRLS. Migrations only.
#   app_user     — owns nothing, no BYPASSRLS. Every request.
#
# If app_user ever gains BYPASSRLS or table ownership, every RLS policy
# in the system silently stops applying. The isolation suite asserts
# against exactly that, because it is invisible in normal operation.

set -euo pipefail

APP_USER="${APP_DB_USER:-app_user}"
APP_PW="${APP_DB_PASSWORD:-app_user_dev_pw}"
MIGRATOR="${MIGRATOR_DB_USER:-app_migrator}"
MIGRATOR_PW="${MIGRATOR_DB_PASSWORD:-app_migrator_dev_pw}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    -- Schema owner. BYPASSRLS so migrations and support tooling can
    -- cross tenant boundaries; nothing else may use this role.
    CREATE ROLE ${MIGRATOR} LOGIN PASSWORD '${MIGRATOR_PW}' BYPASSRLS;

    -- Application role. Deliberately unremarkable: no ownership, no
    -- BYPASSRLS, no CREATEDB. Its powerlessness is the security model.
    CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PW}';

    GRANT ALL ON DATABASE ${POSTGRES_DB} TO ${MIGRATOR};
    ALTER SCHEMA public OWNER TO ${MIGRATOR};

    GRANT USAGE ON SCHEMA public TO ${APP_USER};

    -- Table-level grants are issued by the migration runner, which
    -- knows which tables are append-only (audit_log gets no UPDATE or
    -- DELETE). Sequence access is safe to grant broadly up front.
    ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR} IN SCHEMA public
        GRANT USAGE, SELECT ON SEQUENCES TO ${APP_USER};

    -- Explicitly deny schema modification to the app role.
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    REVOKE CREATE ON SCHEMA public FROM ${APP_USER};
EOSQL

echo "✔ Roles ${MIGRATOR} (BYPASSRLS) and ${APP_USER} (RLS-subject) created."
