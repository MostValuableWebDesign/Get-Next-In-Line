import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Sweep tenants stranded by crashed previous runs before suites start.
    globalSetup: ["src/testGlobalSetup.ts"],
    // Integration tests share one dev database and run alongside other
    // validation commands; the default 5s per-test timeout flakes under
    // that load (different test each run), so give them headroom.
    testTimeout: 20000,
  },
});
