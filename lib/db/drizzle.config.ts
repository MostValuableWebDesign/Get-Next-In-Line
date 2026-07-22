import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

// Paths are relative to this package dir; scripts always run with cwd=lib/db.
// drizzle-kit prepends "./" to absolute paths, creating a double-slash
// (e.g. ".//home/runner/...") that breaks snapshot lookups with ENOENT.
export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
