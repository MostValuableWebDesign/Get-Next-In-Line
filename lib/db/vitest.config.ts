import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/**/*.test.ts"],
    // The drift check spawns drizzle-kit / connects to the DB — slow.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
