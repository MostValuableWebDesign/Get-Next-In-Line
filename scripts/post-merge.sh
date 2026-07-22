#!/bin/bash
set -e

pnpm install --frozen-lockfile

# Sync schema to the database.
# drizzle-kit push compares the Drizzle schema against the live DB and applies
# only the missing tables/columns — no migration-file tracking needed, and it
# exits cleanly with no TTY (stdin is closed in post-merge context).
cd lib/db && pnpm exec drizzle-kit push --config ./drizzle.config.ts
