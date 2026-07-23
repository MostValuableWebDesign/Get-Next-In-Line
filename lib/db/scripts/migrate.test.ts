/**
 * Regression tests for scripts/migrate.ts --reconcile: unstamped-but-applied
 * migrations must be re-stamped (skipping benign "already exists" errors)
 * instead of failing like the strict replay does.
 *
 * Uses the live dev DB: temporarily deletes the newest migration's bookkeeping
 * row, then verifies strict migrate fails loudly (pointing at db:reconcile)
 * and reconcile restores the row. State is restored even on test failure.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchAppliedMigrations, loadMigrations } from "./migration-state";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrations = loadMigrations(path.join(packageDir, "migrations"));
const newest = migrations[migrations.length - 1];

function runMigrate(args: string[]) {
  return spawnSync("pnpm", ["exec", "tsx", "./scripts/migrate.ts", ...args], {
    cwd: packageDir,
    encoding: "utf8",
    env: process.env,
    timeout: 110_000,
  });
}

describe("migrate --reconcile", () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set to run migrate reconcile tests");
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

  beforeAll(async () => {
    // Simulate the recurring failure mode: DDL applied, bookkeeping row missing.
    await pool.query(`DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = $1`, [
      newest.hash,
    ]);
  });

  afterAll(async () => {
    // Restore the stamp no matter what happened above.
    await pool.query(
      `INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at)
       SELECT $1, $2
       WHERE NOT EXISTS (
         SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE hash = $1
       )`,
      [newest.hash, newest.when],
    );
    await pool.end();
  });

  it("strict migrate fails loudly on an unstamped-but-applied migration and points at db:reconcile", () => {
    const result = runMigrate([]);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain(`MIGRATE FAILED in ${newest.file}`);
    expect(result.stderr).toContain("pnpm run db:reconcile");
  });

  it("reconcile re-stamps the migration by skipping already-applied statements", async () => {
    const result = runMigrate(["--reconcile"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`Applied ${newest.file}`);
    expect(result.stdout).toContain("skipped (already applied");

    const applied = await fetchAppliedMigrations(pool);
    expect(applied.some((row) => row.hash === newest.hash)).toBe(true);
  });
});
