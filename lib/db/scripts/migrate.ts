/**
 * CLI: apply pending migrations from lib/db/migrations with loud,
 * per-migration progress and explicit failure reporting.
 *
 * Replaces `drizzle-kit migrate`, which has repeatedly exited 1 without
 * printing which migration failed. This script:
 *   - logs each migration as it is applied (or skipped as already applied)
 *   - on failure, prints the migration FILE, the offending STATEMENT, and the
 *     SQL error, then exits 1 — never a bare exit code
 *   - reports bookkeeping mismatches (applied hashes matching no file)
 *
 * Bookkeeping stays drizzle-compatible: (hash = sha256 of file contents,
 * created_at = journal `when`) rows in drizzle.__drizzle_migrations, so
 * `drizzle-kit migrate` and drizzle-orm's migrate() agree with us.
 *
 * Each migration runs in its own transaction: statements + bookkeeping row
 * commit atomically, so a failed migration leaves no partial state behind.
 *
 * Usage:
 *   pnpm --filter @workspace/db run migrate
 *   pnpm --filter @workspace/db run migrate -- --mark-applied 0004_foo.sql
 *     Records the given migration as applied WITHOUT running its SQL.
 *     Explicit recovery tool for migrations whose DDL was applied out-of-band
 *     (e.g. manually) but never stamped. Use only after verifying the DDL is
 *     already in effect.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import {
  compareBookkeeping,
  fetchAppliedMigrations,
  loadMigrations,
} from "./migration-state";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(packageDir, "migrations");

if (!process.env.DATABASE_URL) {
  console.error("MIGRATE FAILED: DATABASE_URL is not set.");
  process.exit(1);
}

function splitStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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

  if (report.unknownHashes.length > 0) {
    console.error(report.summary);
    console.error(
      "MIGRATE FAILED: refusing to run with unknown applied hashes — resolve the bookkeeping mismatch first.",
    );
    process.exit(1);
  }

  if (report.pending.length === 0) {
    console.log(
      `All ${migrations.length} migrations already applied; nothing to do.`,
    );
  } else {
    console.log(
      `${migrations.length} migrations in folder, ${migrations.length - report.pending.length} already applied, ${report.pending.length} pending:`,
    );
    for (const m of report.pending) console.log(`  - ${m.file}`);

    for (const migration of report.pending) {
      const statements = splitStatements(migration.sql);
      console.log(
        `Applying ${migration.file} (${statements.length} statement(s))...`,
      );
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const statement of statements) {
          try {
            await client.query(statement);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            console.error(`\nMIGRATE FAILED in ${migration.file}`);
            console.error(`SQL error: ${message}`);
            console.error(`Offending statement:\n${statement}\n`);
            console.error(
              "The failed migration was rolled back; no partial changes or bookkeeping were recorded.",
            );
            throw new Error(`migration ${migration.file} failed`);
          }
        }
        await client.query(
          `INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
          [migration.hash, migration.when],
        );
        await client.query("COMMIT");
        console.log(`Applied ${migration.file}`);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        exitCode = 1;
        break;
      } finally {
        client.release();
      }
    }

    if (exitCode === 0) {
      console.log(`Done: applied ${report.pending.length} migration(s).`);
    }
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
