import { describe, it, expect } from "vitest";
import {
  assertProductionEnv,
  collectProductionEnvProblems,
} from "../startupChecks";

// Boot-time env validation: production must fail fast with actionable
// messages when critical secrets are missing; dev/test stay permissive.

describe("collectProductionEnvProblems", () => {
  it("is a no-op outside production even with everything missing", () => {
    for (const nodeEnv of [undefined, "development", "test"]) {
      const env = { NODE_ENV: nodeEnv } as NodeJS.ProcessEnv;
      expect(collectProductionEnvProblems(env)).toEqual([]);
      expect(() => assertProductionEnv(env)).not.toThrow();
    }
  });

  it("flags missing SESSION_SECRET and ADMIN_PASSWORD in production", () => {
    const problems = collectProductionEnvProblems({
      NODE_ENV: "production",
    } as NodeJS.ProcessEnv);
    expect(problems.some((p) => p.includes("SESSION_SECRET"))).toBe(true);
    expect(problems.some((p) => p.includes("ADMIN_PASSWORD"))).toBe(true);
  });

  it("passes in production when both are set", () => {
    const env = {
      NODE_ENV: "production",
      SESSION_SECRET: "a-long-random-string",
      ADMIN_PASSWORD: "a-strong-password",
    } as NodeJS.ProcessEnv;
    expect(collectProductionEnvProblems(env)).toEqual([]);
    expect(() => assertProductionEnv(env)).not.toThrow();
  });

  it("assertProductionEnv throws with an actionable FATAL message", () => {
    const env = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
    expect(() => assertProductionEnv(env)).toThrow(/FATAL/);
    expect(() => assertProductionEnv(env)).toThrow(/SESSION_SECRET/);
    expect(() => assertProductionEnv(env)).toThrow(/ADMIN_PASSWORD/);
  });
});
