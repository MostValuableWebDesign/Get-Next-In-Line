import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db, tenantsTable, type Tenant } from "@workspace/db";

/**
 * Explicit tenant-context contract for tenant-scoped routes.
 *
 * Tenant scope travels in the `x-tenant-id` header:
 *   - a positive integer selects that tenant's rows;
 *   - the literal value "legacy" deliberately selects the legacy
 *     (NULL-tenant, single-tenant era) scope.
 *
 * A missing or malformed header is an error — routes must never silently
 * fall back to the legacy rows, so isolation doesn't depend on every caller
 * remembering to send the header.
 */

export const TENANT_HEADER = "x-tenant-id";

/** Sentinel header value that deliberately selects the legacy NULL scope. */
export const LEGACY_TENANT_HEADER_VALUE = "legacy";

export const TENANT_HEADER_REQUIRED_MESSAGE =
  'x-tenant-id header is required (use "legacy" for the legacy scope)';

export class TenantContextError extends Error {
  override name = "TenantContextError";
}

export class AppBusinessConfigurationError extends Error {
  override name = "AppBusinessConfigurationError";
}

type AppBusiness = Pick<Tenant, "id" | "brandName" | "status">;
type AppBusinessResolver = () => Promise<AppBusiness>;

let appBusinessResolverOverride: AppBusinessResolver | null = null;

export function resolveSingleActiveBusiness(rows: AppBusiness[]): AppBusiness {
  if (rows.length === 0) {
    throw new AppBusinessConfigurationError(
      "GNIL requires exactly one active business, but none is configured",
    );
  }
  if (rows.length > 1) {
    throw new AppBusinessConfigurationError(
      "GNIL requires exactly one active business, but multiple active businesses are configured",
    );
  }
  return rows[0];
}

/** Resolve the one active operational business configured for this deployment. */
export async function requireAppBusiness(): Promise<AppBusiness> {
  if (appBusinessResolverOverride) return appBusinessResolverOverride();
  const rows = await db
    .select({
      id: tenantsTable.id,
      brandName: tenantsTable.brandName,
      status: tenantsTable.status,
    })
    .from(tenantsTable)
    .where(eq(tenantsTable.status, "active"))
    .limit(2);
  return resolveSingleActiveBusiness(rows);
}

/** Test-only injection; production always resolves from active tenant records. */
export function __configureAppBusinessResolverForTests(
  resolver: AppBusinessResolver | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("App business resolver overrides are test-only");
  }
  appBusinessResolverOverride = resolver;
}

function isAutomaticBusinessPath(req: Request): boolean {
  if (req.path === "/operations/integrations/gusto/callback") return false;
  if (req.path.startsWith("/operations")) return true;
  if (!req.path.startsWith("/sos")) return false;
  return !req.path.startsWith("/sos/twilio/");
}

/**
 * Establish the deployment's automatic business context before authorization.
 * Existing route code still consumes x-tenant-id internally; clients no longer
 * provide or select it.
 */
export async function applyAppBusinessContext(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  if (!isAutomaticBusinessPath(req)) {
    next();
    return;
  }

  // Keep legacy integration tests isolated while they are migrated away from
  // explicit headers. Runtime environments always ignore client selection.
  if (process.env.NODE_ENV === "test" && req.header(TENANT_HEADER)) {
    next();
    return;
  }

  const business = await requireAppBusiness();
  req.headers[TENANT_HEADER] = String(business.id);
  next();
}

/**
 * Parse the tenant scope out of a request, throwing a TenantContextError
 * (mapped to a 400 by the app-level error handler) when the header is
 * missing or malformed. Returns the tenant id, or null for the explicit
 * legacy scope.
 */
export function requireTenantScope(req: Request): number | null {
  const raw = req.header(TENANT_HEADER)?.trim();
  if (!raw) throw new TenantContextError(TENANT_HEADER_REQUIRED_MESSAGE);
  if (raw.toLowerCase() === LEGACY_TENANT_HEADER_VALUE) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new TenantContextError(
      `Invalid x-tenant-id header ${JSON.stringify(raw)} — expected a positive integer or "legacy"`,
    );
  }
  return n;
}
