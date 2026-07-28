import { Request, Response, NextFunction } from "express";

// Extend express-session with our custom fields
declare module "express-session" {
  interface SessionData {
    authenticated: boolean;
    // User identity behind the session. Absent on sessions created before
    // the user model existed — those are the password-authenticated platform
    // operator and are treated as platform admin.
    userId?: number;
    isPlatformAdmin?: boolean;
    // Network-governance role carried by the session (set at login).
    // Absent on legacy password sessions — those are the platform operator
    // and behave as super_admin.
    role?: string;
  }
}

/**
 * Middleware that blocks unauthenticated requests.
 * Apply after public routes (health, auth) have been mounted.
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.session?.authenticated === true) {
    next();
    return;
  }
  res.status(401).json({ error: "Unauthorized", message: "Authentication required" });
}
