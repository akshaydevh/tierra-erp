#!/usr/bin/env bash
# Runs the Tierra frontend against the local ERPNext backend (erpnext/dev-backend.sh). API_URL set here wins
# over frontend/.env, which may point at another backend.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export API_URL="${HACK_API_URL:-http://localhost:3002}"
cd "$here/../frontend"
exec npm run dev
