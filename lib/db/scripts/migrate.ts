/**
 * CLI: apply pending migrations from lib/db/migrations with loud,
 * per-migration progress and explicit failure reporting.
 *
 * Replaces `drizzle-kit migrate`, which has repeatedly exited 1 without
 * printing which migration failed. The actual apply logic lives in
 * lib/db/src/apply-migrations.ts (shared with server startup self-heal) and
 * is strictly additive-forward: it never drops, resets, or rewinds anything.
 *
 * Usage:
 *   pnpm --filter @workspace/db run migrate
 *   pnpm --filter @workspace/db run migrate -- --mark-applied 0004_foo.sql
 *     Records the given migration as applied WITHOUT running its SQL.
 *     Explicit recovery tool for migrations whose DDL was applied out-of-band
 *     (e.g. manually) but never stamped. Use only after verifying the DDL is
 *     already in effect.
 *   pnpm --filter @workspace/db run migrate -- --reconcile
 *     Recovery mode for unstamped-but-(partially-)applied migrations: replays
 *     each pending migration statement-by-statement inside a transaction,
 *     skipping ONLY benign "already exists" errors (duplicate column/table/
 *     index/constraint) via savepoints, then stamps the migration. Any other
 *     SQL error still fails loudly and rolls back. Always follow with
 *     `pnpm run db:check-drift` (db:reconcile does this) so the live schema is
 *     verified against the code schema after stamping.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import {
  compareBookkeeping,
  fetchAppliedMigrations,
  loadMigrations,
} from "../src/migration-state";
import { applyPendingMigrations } from "../src/apply-migrations";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(packageDir, "migrations");

if (!process.env.DATABASE_URL) {
  console.error("MIGRATE FAILED: DATABASE_URL is not set.");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

let exitCode = 0;
try {
  const migrations = loadMigrations(migrationsDir);
  const applied = await fetchAppliedMigrations(pool);
  const report = compareBookkeeping(migrations, applied);

  const markIdx = process.argv.indexOf("--mark-applied");
  if (markIdx !== -1) {
    const target = process.argv[markIdx + 1];
    const migration = migrations.find((m) => m.file === target);
    if (!migration) {
      console.error(
        `MIGRATE FAILED: --mark-applied ${target ?? "(missing argument)"} matches no file in lib/db/migrations.`,
      );
      process.exit(1);
    }
    if (!report.pending.some((m) => m.hash === migration.hash)) {
      console.log(`${migration.file} is already recorded as applied; nothing to do.`);
      process.exit(0);
    }
    await pool.query(
      `INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
      [migration.hash, migration.when],
    );
    console.log(
      `Marked ${migration.file} as applied WITHOUT running its SQL. Run \`pnpm run db:check-drift\` to confirm the schema actually matches.`,
    );
    process.exit(0);
  }

  const reconcile = process.argv.includes("--reconcile");

  if (report.pending.length === 0 && report.unknownHashes.length === 0) {
    console.log(`All ${migrations.length} migrations already applied; nothing to do.`);
  } else {
    if (report.pending.length > 0) {
      console.log(
        `${migrations.length} migrations in folder, ${migrations.length - report.pending.length} already applied, ${report.pending.length} pending:`,
      );
      for (const m of report.pending) console.log(`  - ${m.file}`);
    }
    const result = await applyPendingMigrations(pool, {
      migrationsDir,
      reconcile,
      log: (m) => console.log(m),
    });
    console.log(`Done: applied ${result.applied.length} migration(s).`);
  }
} catch (error) {
  console.error(
    `MIGRATE FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
process.exit(exitCode);
