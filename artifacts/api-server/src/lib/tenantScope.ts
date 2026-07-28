import type { Request } from "express";

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
