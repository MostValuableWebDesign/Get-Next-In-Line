/**
 * Shared helpers for comparing lib/db/migrations (the journal + .sql files)
 * against the bookkeeping table drizzle.__drizzle_migrations.
 *
 * Compatible with drizzle-orm's migrator: each applied migration is recorded
 * as (hash = sha256 of the .sql file contents, created_at = journal `when`).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type pg from "pg";

export interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

export interface MigrationFile extends JournalEntry {
  file: string;
  sql: string;
  hash: string;
}

export interface AppliedRow {
  hash: string;
  created_at: string | number;
}

export function loadMigrations(migrationsDir: string): MigrationFile[] {
  const journalPath = path.join(migrationsDir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: JournalEntry[];
  };
  return journal.entries
    .slice()
    .sort((a, b) => a.idx - b.idx)
    .map((entry) => {
      const file = `${entry.tag}.sql`;
      const sql = readFileSync(path.join(migrationsDir, file), "utf8");
      return {
        ...entry,
        file,
        sql,
        hash: createHash("sha256").update(sql).digest("hex"),
      };
    });
}

export async function fetchAppliedMigrations(
  client: pg.Pool | pg.Client,
): Promise<AppliedRow[]> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
  await client.query(
    `CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
       id SERIAL PRIMARY KEY,
       hash text NOT NULL,
       created_at bigint
     )`,
  );
  const res = await client.query(
    `SELECT hash, created_at FROM "drizzle"."__drizzle_migrations" ORDER BY created_at, id`,
  );
  return res.rows as AppliedRow[];
}

export interface BookkeepingReport {
  /** migrations in the folder that have no applied row */
  pending: MigrationFile[];
  /** applied hashes that match no migration file (edited/deleted migration?) */
  unknownHashes: string[];
  ok: boolean;
  summary: string;
}

export function compareBookkeeping(
  migrations: MigrationFile[],
  applied: AppliedRow[],
): BookkeepingReport {
  const appliedHashes = new Set(applied.map((r) => r.hash));
  const fileHashes = new Set(migrations.map((m) => m.hash));
  const pending = migrations.filter((m) => !appliedHashes.has(m.hash));
  const unknownHashes = [...appliedHashes].filter((h) => !fileHashes.has(h));

  const lines: string[] = [];
  if (pending.length > 0) {
    lines.push(
      `Migration bookkeeping is behind: ${pending.length} migration(s) in lib/db/migrations have no row in drizzle.__drizzle_migrations: ${pending.map((m) => m.file).join(", ")}. Run \`pnpm run db:push\` to apply them.`,
    );
  }
  if (unknownHashes.length > 0) {
    lines.push(
      `drizzle.__drizzle_migrations contains ${unknownHashes.length} hash(es) that match no file in lib/db/migrations (a migration file was edited or deleted after being applied): ${unknownHashes.map((h) => h.slice(0, 12) + "…").join(", ")}.`,
    );
  }
  const ok = lines.length === 0;
  return {
    pending,
    unknownHashes,
    ok,
    summary: ok
      ? `Migration bookkeeping OK: all ${migrations.length} migrations recorded as applied.`
      : lines.join("\n"),
  };
}
