// ---------------------------------------------------------------------------
// Production boot-time environment validation.
//
// In production a misconfigured secret must abort startup with an actionable
// message instead of erroring at request time (forged sessions, dead admin
// login). In dev/test the existing insecure fallbacks keep working, so this
// is a no-op outside production.
// ---------------------------------------------------------------------------

export function collectProductionEnvProblems(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (env.NODE_ENV !== "production") return [];
  const problems: string[] = [];
  if (!env.SESSION_SECRET) {
    problems.push(
      "SESSION_SECRET is not set. It signs session cookies and derives the " +
        "encryption keys for stored connector/partner tokens — set it to a " +
        "long random string.",
    );
  }
  if (!env.ADMIN_PASSWORD) {
    problems.push(
      "ADMIN_PASSWORD is not set. The platform-operator login " +
        "(POST /api/auth/login with { password }) cannot authenticate " +
        "anyone without it — set it to a strong password.",
    );
  }
  return problems;
}

/**
 * Throws in production when critical env is missing; no-op otherwise.
 * Call before the server accepts any traffic.
 */
export function assertProductionEnv(env: NodeJS.ProcessEnv = process.env): void {
  const problems = collectProductionEnvProblems(env);
  if (problems.length > 0) {
    throw new Error(
      "FATAL: production environment is misconfigured — refusing to start:\n" +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
  }
}
