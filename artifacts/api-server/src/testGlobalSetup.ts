// Vitest global setup: runs ONCE per test invocation, before any worker
// starts. Sweeps tenants stranded by previously crashed test runs so junk
// can't accumulate in the shared dev database (and can't break future runs
// via duplicate phone numbers). The sweep's structural subdomain match and
// age threshold guarantee it never touches real tenants or tenants created
// by the current (or any live parallel) run.
export default async function setup(): Promise<void> {
  const { sweepStaleTestTenants } = await import("./lib/testTenantSweep");
  const swept = await sweepStaleTestTenants();
  if (swept.length > 0) {
    console.log(
      `[testGlobalSetup] swept ${swept.length} stale test tenant(s): ${swept
        .map((t) => t.subdomain)
        .join(", ")}`,
    );
  }
  const { pool } = await import("@workspace/db");
  // Global setup runs in its own process; release its DB connections so the
  // process can exit cleanly.
  await pool.end();
}
