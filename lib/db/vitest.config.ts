import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/**/*.test.ts"],
    // The drift check spawns drizzle-kit / connects to the DB — slow.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // migrate.test.ts temporarily unstamps a migration row in the shared dev
    // DB; check-drift.test.ts asserts a healthy DB. Run files sequentially so
    // they don't race on that shared state.
    fileParallelism: false,
  },
});
