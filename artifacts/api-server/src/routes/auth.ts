import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

/**
 * POST /api/auth/login
 * Body: { password: string }
 * Validates the password against ADMIN_PASSWORD and creates a session.
 */
router.post("/auth/login", (req, res) => {
  const { password } = req.body as { password?: string };
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
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  req.session.authenticated = true;
  req.session.save((err) => {
    if (err) {
      res.status(500).json({ error: "Session error" });
      return;
    }
    res.json({ ok: true });
  });
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
 * Returns 200 when the session is authenticated, 401 otherwise.
 * Used by the frontend to check auth state on load.
 */
router.get("/auth/me", requireAuth, (_req, res) => {
  res.json({ authenticated: true });
});

export default router;
