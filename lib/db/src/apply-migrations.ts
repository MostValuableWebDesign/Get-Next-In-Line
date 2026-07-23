/**
 * Programmatic, NON-DESTRUCTIVE migration applier shared by the CLI
 * (lib/db/scripts/migrate.ts) and server startup self-heal.
 *
 * It only ever applies pending migrations forward. It never drops, resets, or
 * rewinds anything. In reconcile mode, statements whose DDL is already in
 * effect (duplicate column/table/index/constraint) are skipped via savepoints;
 * any other SQL error rolls the migration back and fails loudly.
 *
 * This exists because the Replit dev database can be restored to an older
 * checkpoint snapshot while the code (and its migrations) stay newer — the
 * "dev DB drift / unstamped migrations" state. Applying the pending
 * migrations in reconcile mode is the safe repair: it re-adds the missing
 * tables/columns and stamps bookkeeping, without touching existing rows.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type pg from "pg";
import {
  compareBookkeeping,
  fetchAppliedMigrations,
  loadMigrations,
  type BookkeepingReport,
  type MigrationFile,
} from "./migration-state";

/**
 * Postgres error codes that mean "this DDL already took effect" — safe to skip
 * during reconcile because the statement's outcome is already in place:
 *   42701 duplicate_column, 42P07 duplicate_table (also indexes),
 *   42710 duplicate_object (constraints, types), 42723 duplicate_function,
 *   42P06 duplicate_schema.
 */
export const ALREADY_EXISTS_CODES = new Set([
  "42701",
  "42P07",
  "42710",
  "42723",
  "42P06",
]);

function pgErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function splitStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Locate lib/db/migrations by walking up from `startDir` (default: cwd).
 * Works from the monorepo root, from artifacts/api-server (dev workflow cwd),
 * and from bundled dist output, as long as the repo layout is present.
 */
export function findMigrationsDir(startDir = process.cwd()): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "lib", "db", "migrations");
    if (existsSync(path.join(candidate, "meta", "_journal.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export interface ApplyMigrationsOptions {
  migrationsDir: string;
  /** Skip benign "already exists" errors via savepoints (recovery mode). */
  reconcile?: boolean;
  log?: (message: string) => void;
}

export interface ApplyMigrationsResult {
  report: BookkeepingReport;
  applied: string[];
  /** statements skipped as already-in-effect (reconcile mode only) */
  skippedStatements: number;
}

/**
 * Apply all pending migrations, each in its own transaction (statements +
 * bookkeeping row commit atomically). Throws on any real SQL error or on
 * unknown applied hashes — never leaves partial state behind.
 */
export async function applyPendingMigrations(
  pool: pg.Pool,
  options: ApplyMigrationsOptions,
): Promise<ApplyMigrationsResult> {
  const { migrationsDir, reconcile = false, log = () => {} } = options;
  const migrations = loadMigrations(migrationsDir);
  const applied = await fetchAppliedMigrations(pool);
  const report = compareBookkeeping(migrations, applied);

  if (report.unknownHashes.length > 0) {
    throw new Error(
      `${report.summary}\nRefusing to run with unknown applied hashes — resolve the bookkeeping mismatch first.`,
    );
  }

  const appliedFiles: string[] = [];
  let skippedStatements = 0;

  for (const migration of report.pending) {
    const result = await applyOne(pool, migration, reconcile, log);
    skippedStatements += result.skipped;
    appliedFiles.push(migration.file);
    log(`Applied ${migration.file}`);
  }

  return { report, applied: appliedFiles, skippedStatements };
}

async function applyOne(
  pool: pg.Pool,
  migration: MigrationFile,
  reconcile: boolean,
  log: (message: string) => void,
): Promise<{ skipped: number }> {
  const statements = splitStatements(migration.sql);
  log(
    `Applying ${migration.file} (${statements.length} statement(s))${reconcile ? " [reconcile mode]" : ""}...`,
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let skipped = 0;
    for (const statement of statements) {
      if (reconcile) await client.query("SAVEPOINT reconcile_stmt");
      try {
        await client.query(statement);
      } catch (error) {
        const code = pgErrorCode(error);
        if (reconcile && code !== undefined && ALREADY_EXISTS_CODES.has(code)) {
          await client.query("ROLLBACK TO SAVEPOINT reconcile_stmt");
          skipped += 1;
          log(
            `  skipped (already applied, ${code}): ${statement.split("\n")[0].slice(0, 100)}`,
          );
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `MIGRATE FAILED in ${migration.file}\nSQL error: ${message}\nOffending statement:\n${statement}\n` +
            (reconcile
              ? 'This error is not a benign "already exists" — reconcile refuses to skip it. The migration was rolled back; nothing was recorded.'
              : "The failed migration was rolled back; no partial changes or bookkeeping were recorded.\nIf this failed because the DDL already exists (migration applied out-of-band but never stamped), run `pnpm run db:reconcile` to replay pending migrations, skipping already-applied statements, and stamp them."),
        );
      }
    }
    if (skipped > 0) {
      log(
        `  ${migration.file}: ${skipped}/${statements.length} statement(s) were already in effect and skipped.`,
      );
    }
    await client.query(
      `INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
      [migration.hash, migration.when],
    );
    await client.query("COMMIT");
    return { skipped };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
