import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "./schema";

export interface SchemaDriftReport {
  ok: boolean;
  missingTables: string[];
  /** Map of table name -> column names defined in code but absent in the DB. */
  missingColumns: Record<string, string[]>;
}

interface QueryClient {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
}

function isPgTable(value: unknown): value is PgTable {
  try {
    getTableConfig(value as PgTable);
    return true;
  } catch {
    return false;
  }
}

/** Collect { tableName -> Set<columnName> } from the Drizzle schema in code. */
export function expectedSchema(): Map<string, Set<string>> {
  const expected = new Map<string, Set<string>>();
  for (const value of Object.values(schema)) {
    if (!isPgTable(value)) continue;
    const config = getTableConfig(value);
    expected.set(
      config.name,
      new Set(config.columns.map((c) => c.name)),
    );
  }
  return expected;
}

/**
 * Compare the Drizzle schema defined in code against the live database's
 * information_schema. Reports tables and columns that exist in code but are
 * missing from the database (i.e. schema drift from un-pushed changes).
 *
 * Extra tables/columns in the DB are ignored — only missing DDL is drift.
 */
export async function checkSchemaDrift(
  client: QueryClient,
): Promise<SchemaDriftReport> {
  const expected = expectedSchema();
  const tableNames = [...expected.keys()];

  const { rows } = await client.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1)`,
    [tableNames],
  );

  const actual = new Map<string, Set<string>>();
  for (const row of rows) {
    const table = String(row["table_name"]);
    const column = String(row["column_name"]);
    if (!actual.has(table)) actual.set(table, new Set());
    actual.get(table)!.add(column);
  }

  const missingTables: string[] = [];
  const missingColumns: Record<string, string[]> = {};

  for (const [table, columns] of expected) {
    const dbColumns = actual.get(table);
    if (!dbColumns) {
      missingTables.push(table);
      continue;
    }
    const missing = [...columns].filter((c) => !dbColumns.has(c));
    if (missing.length > 0) missingColumns[table] = missing;
  }

  return {
    ok: missingTables.length === 0 && Object.keys(missingColumns).length === 0,
    missingTables,
    missingColumns,
  };
}

/** Human-readable summary of a drift report (empty string when ok). */
export function formatDriftReport(report: SchemaDriftReport): string {
  if (report.ok) return "";
  const parts: string[] = [];
  if (report.missingTables.length > 0) {
    parts.push(`missing tables: ${report.missingTables.join(", ")}`);
  }
  for (const [table, cols] of Object.entries(report.missingColumns)) {
    parts.push(`table "${table}" missing columns: ${cols.join(", ")}`);
  }
  return `Database schema drift detected — ${parts.join("; ")}. Run \`pnpm run db:push\` to apply the code schema to the dev database.`;
}
