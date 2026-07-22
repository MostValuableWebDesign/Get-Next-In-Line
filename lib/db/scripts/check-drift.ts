/**
 * CLI: verify the dev database matches the Drizzle schema in code.
 *
 * Exit codes:
 *   0 — live DB matches the code schema (no drift)
 *   1 — drift detected: the live DB is missing tables/columns, or — when the
 *       DB is unreachable — the code schema has edits with no corresponding
 *       migration (detected by a dry-run drizzle-kit generate)
 *   2 — could NOT verify: DB unreachable/missing DATABASE_URL. The DB-free
 *       fallback found no un-migrated schema edits, but live drift was not
 *       verified. This is an infra failure, not a clean pass — the check must
 *       not be silently skippable.
 *
 * Usage: pnpm --filter @workspace/db run check-drift
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpDirName = ".drift-check-tmp";
const tmpDir = path.join(packageDir, tmpDirName);

function listSqlMigrations(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".sql"));
}

/**
 * DB-free fallback: dry-run `drizzle-kit generate` against a temp copy of
 * lib/db/migrations. If it produces a new migration file, the code schema has
 * edits that were never migrated (drift) — exit 1. Otherwise exit 2, because
 * live drift still could not be verified.
 */
function runDbFreeFallback(): never {
  console.error(
    "COULD NOT VERIFY: unable to reach the dev database to check live schema drift.",
  );
  console.error(
    "Falling back to a DB-free check: dry-run drizzle-kit generate against lib/db/migrations...",
  );

  rmSync(tmpDir, { recursive: true, force: true });
  let exitCode = 2;
  try {
    mkdirSync(tmpDir, { recursive: true });
    cpSync(path.join(packageDir, "migrations"), path.join(tmpDir, "migrations"), {
      recursive: true,
    });
    // NOTE: drizzle-kit resolves schema/out paths relative to the process cwd
    // (packageDir), not the config file location. Keep paths relative —
    // drizzle-kit v0.31 mishandles absolute paths.
    writeFileSync(
      path.join(tmpDir, "drizzle.config.ts"),
      `import { defineConfig } from "drizzle-kit";
export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./${tmpDirName}/migrations",
  dialect: "postgresql",
});
`,
    );

    const before = listSqlMigrations(path.join(tmpDir, "migrations")).length;
    const result = spawnSync(
      "pnpm",
      ["exec", "drizzle-kit", "generate", "--config", `./${tmpDirName}/drizzle.config.ts`],
      { cwd: packageDir, stdio: "inherit", env: process.env },
    );

    if (result.error || result.status !== 0) {
      console.error(
        `COULD NOT VERIFY: fallback drizzle-kit generate failed to run${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}.`,
      );
    } else if (listSqlMigrations(path.join(tmpDir, "migrations")).length > before) {
      console.error(
        "Schema drift detected (DB-free check): lib/db/src/schema has changes with no corresponding migration in lib/db/migrations. Run `pnpm run db:push` to generate and apply them.",
      );
      exitCode = 1;
    } else {
      console.error(
        "Fallback passed (no un-migrated schema edits), but live database drift was NOT verified.",
      );
      console.error(
        "COULD NOT VERIFY: fix database connectivity (DATABASE_URL / DB availability) and re-run.",
      );
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

if (!process.env.DATABASE_URL) {
  console.error("COULD NOT VERIFY: DATABASE_URL is not set.");
  runDbFreeFallback();
}

const { pool, checkSchemaDrift, formatDriftReport } = await import(
  "../src/index"
);

let report;
try {
  report = await checkSchemaDrift(pool);
} catch (error) {
  console.error(
    `Connection/query error while checking drift: ${error instanceof Error ? error.message : String(error)}`,
  );
  await pool.end().catch(() => {});
  runDbFreeFallback();
}

if (report.ok) {
  console.log("Schema check passed: database matches lib/db/src/schema.");
} else {
  console.error(formatDriftReport(report));
  process.exitCode = 1;
}

await pool.end();
