import type { Request, Response, NextFunction } from "express";
import { NETWORK_ROLES, type NetworkRole } from "@workspace/db";
import { sessionIsPlatformAdmin } from "./tenantAccess";

// ---------------------------------------------------------------------------
// Hierarchical network-governance roles.
//
//   super_admin      — manages everything (legacy password sessions map here)
//   district_manager — manages an assigned subset of tenants
//   merchant         — manages exactly one tenant (their business)
//   staff            — read/operational access within one tenant
//
// WHICH tenants a district manager / merchant / staff user may touch is the
// existing user_tenant_memberships check (tenantAccess.ts). This module only
// decides WHAT a role may do on the surfaces that carry role enforcement:
// governance, tenant management, and co-op admin routes.
// ---------------------------------------------------------------------------

/** The session's effective role. Legacy password sessions (and any session
 *  flagged platform admin) are super_admin so nobody gets locked out. */
export function sessionRole(req: Request): NetworkRole {
  if (sessionIsPlatformAdmin(req)) return "super_admin";
  const role = req.session?.role;
  return (NETWORK_ROLES as readonly string[]).includes(role ?? "")
    ? (role as NetworkRole)
    : "staff";
}

/** Middleware factory: only the listed roles may pass. */
export function requireRole(...roles: NetworkRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = sessionRole(req);
    if (roles.includes(role)) {
      next();
      return;
    }
    res.status(403).json({
      error: "Forbidden",
      message: `This operation requires one of the following roles: ${roles.join(", ")}`,
    });
  };
}
