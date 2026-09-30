#!/bin/sh
# Container start-up for a standalone deployment (Render).
#
# Exists as a file rather than a chained dockerCommand because Render's argv
# handling mangled the quoting: `sh -c "a && b && c"` in render.yaml reached the
# container as a single command name, and sh reported the whole string as
# "not found" (exit 127). A two-token command with no quotes and no && cannot
# be misparsed however the platform splits it.
#
# Not used by docker-compose, which runs migrate and seed as their own one-shot
# services and starts the API with its own command.
set -e

# Run from the script's own directory, so `dist/...` resolves regardless of what
# working directory the platform starts the container in.
cd "$(dirname "$0")"

echo "[start] applying migrations"
node dist/db/migrate.js

echo "[start] seeding the admin account"
node dist/db/seed.js

echo "[start] starting the API"
exec node dist/index.js
