#!/usr/bin/env bash
# Runs the Tierra backend on ERPNext (hackathon build): database tierra_hack, ERPNext keys from
# ~/tierra-data/erpnext.local.env (written by tools/erpnext-import/run.py setup). Other settings (OpenAI,
# Evolution) still come from backend/.env.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
set -a
# shellcheck disable=SC1090
. "${ERPNEXT_ENV_FILE:-$HOME/tierra-data/erpnext.local.env}"
set +a
export ERP_BACKEND=erpnext
export DATABASE_URL="${HACK_DATABASE_URL:-postgres://tierra:tierra@localhost:5432/tierra_hack}"
cd "$here/../backend"
exec npm run "${1:-dev}"
