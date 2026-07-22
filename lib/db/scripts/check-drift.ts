/**
 * CLI: verify the dev database matches the Drizzle schema in code.
 * Exits 1 (with details) when tables/columns defined in code are missing.
 *
 * Usage: pnpm --filter @workspace/db run check-drift
 */
import { pool, checkSchemaDrift, formatDriftReport } from "../src/index";

const report = await checkSchemaDrift(pool);

if (report.ok) {
  console.log("Schema check passed: database matches lib/db/src/schema.");
} else {
  console.error(formatDriftReport(report));
  process.exitCode = 1;
}

await pool.end();
