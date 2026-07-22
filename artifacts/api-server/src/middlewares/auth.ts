import { Request, Response, NextFunction } from "express";

// Extend express-session with our custom fields
declare module "express-session" {
  interface SessionData {
    authenticated: boolean;
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
