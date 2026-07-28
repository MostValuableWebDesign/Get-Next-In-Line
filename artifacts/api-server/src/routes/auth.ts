import { Router, type IRouter } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { sessionRole } from "../middlewares/roles";
import {
  loginBruteForceGuard,
  recordLoginFailure,
  clearLoginFailures,
} from "../middlewares/rateLimit";

const router: IRouter = Router();

/**
 * POST /api/auth/login
 * Body: { password: string } — platform-operator login (ADMIN_PASSWORD);
 *   the session is the seeded "operator" platform-admin user.
 * Body: { loginToken: string } — programmatic per-user login for seeded
 *   users (no user-management UI yet); the session carries that user's
 *   identity and tenant memberships govern what it may access.
 */
router.post("/auth/login", loginBruteForceGuard, async (req, res): Promise<void> => {
  const { password, loginToken } = req.body as {
    password?: string;
    loginToken?: string;
  };

  const finishLogin = (
    userId: number | null,
    isPlatformAdmin: boolean,
    role?: string,
  ) => {
    clearLoginFailures(req);
    req.session.authenticated = true;
    if (userId != null) req.session.userId = userId;
    req.session.isPlatformAdmin = isPlatformAdmin;
    if (role) req.session.role = role;
    req.session.save((err) => {
      if (err) {
        res.status(500).json({ error: "Session error" });
        return;
      }
      res.json({ ok: true });
    });
  };

  if (typeof loginToken === "string" && loginToken.length > 0) {
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.loginToken, loginToken));
    if (!user) {
      recordLoginFailure(req);
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    finishLogin(user.id, user.isPlatformAdmin, user.isPlatformAdmin ? "super_admin" : user.role);
    return;
  }

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    res.status(500).json({
      error: "Server misconfigured",
      message: "ADMIN_PASSWORD environment variable is not set",
    });
    return;
  }

  if (!password || password !== adminPassword) {
    // Uniform response — do not reveal whether it's the password or username
    recordLoginFailure(req);
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  // Password login is the platform operator: a platform admin with no
  // per-user row (deliberately DB-free so login works even when the users
  // table is unavailable, and legacy sessions behave identically).
  finishLogin(null, true, "super_admin");
});

/**
 * POST /api/auth/logout
 * Destroys the current session.
 */
router.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("gnil.sid");
    res.json({ ok: true });
  });
});

/**
 * GET /api/auth/me
 * Returns 200 (with the session's governance role) when authenticated,
 * 401 otherwise. Used by the frontend to check auth state and gate UI.
 */
router.get("/auth/me", requireAuth, (req, res) => {
  res.json({ authenticated: true, role: sessionRole(req) });
});

export default router;
