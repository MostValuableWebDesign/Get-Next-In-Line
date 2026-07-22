/**
 * Exit-code contract tests for scripts/check-drift.ts:
 *   0 — healthy DB, no drift
 *   2 — DB unreachable / DATABASE_URL missing, schema clean (could not verify)
 *   1 — DB unreachable AND the code schema has un-migrated edits (DB-free fallback)
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpDir = path.join(packageDir, ".drift-check-tmp");
const schemaIndexPath = path.join(packageDir, "src", "schema", "index.ts");
const originalSchemaIndex = readFileSync(schemaIndexPath, "utf8");

const TEMP_SCHEMA_EDIT = `
// TEMP (drift-check test): un-migrated schema edit — must never be committed.
import { pgTable as __driftTestPgTable, text as __driftTestText } from "drizzle-orm/pg-core";
export const __driftCheckTestTable = __driftTestPgTable("__drift_check_test_table", {
  id: __driftTestText("id").primaryKey(),
});
`;

function runCheckDrift(env: Record<string, string | undefined>) {
  return spawnSync("pnpm", ["exec", "tsx", "./scripts/check-drift.ts"], {
    cwd: packageDir,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 110_000,
  });
}

afterEach(() => {
  writeFileSync(schemaIndexPath, originalSchemaIndex);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("check-drift exit codes", () => {
  it("exits 0 when the DB is reachable and matches the schema", () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL must be set to run the healthy-DB scenario");
    }
    const result = runCheckDrift({});
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Schema check passed");
  });

  it("exits 2 when DATABASE_URL is missing and the schema is clean", () => {
    const result = runCheckDrift({ DATABASE_URL: undefined });
    expect(result.status, result.stdout + result.stderr).toBe(2);
    expect(result.stderr).toContain("COULD NOT VERIFY");
    expect(existsSync(tmpDir)).toBe(false);
  });

  it("exits 1 when the DB is unreachable and the schema has un-migrated edits", () => {
    writeFileSync(schemaIndexPath, originalSchemaIndex + TEMP_SCHEMA_EDIT);
    const result = runCheckDrift({
      DATABASE_URL: "postgres://invalid:invalid@127.0.0.1:1/nonexistent",
    });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("Schema drift detected (DB-free check)");
    expect(existsSync(tmpDir)).toBe(false);
  });
});
