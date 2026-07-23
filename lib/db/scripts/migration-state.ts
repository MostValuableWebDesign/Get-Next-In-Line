/**
 * Moved to lib/db/src/migration-state.ts so both the CLI scripts and server
 * startup self-heal can share it. This re-export keeps script imports stable.
 */
export * from "../src/migration-state";
