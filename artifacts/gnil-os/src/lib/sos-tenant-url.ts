/**
 * Pure URL helpers for the SOS `?tenant=<id>` scope. Kept free of side
 * effects (no api-client imports) so layout components can use them without
 * pulling in the tenant-header wiring from sos-tenant.tsx.
 */

/** Parse a positive-integer tenant id out of a ?tenant= search param. */
export function parseTenantParam(search: string): number | null {
  const raw = new URLSearchParams(search).get('tenant');
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Build an in-app href that carries the active `?tenant=<id>` scope forward.
 * Use for every nav link between /sos pages — dropping the param would reset
 * the tenant scope and break tenant-required APIs (e.g. /api/coop/compliance).
 */
export function withSosTenant(path: string, search?: string): string {
  const src = search ?? (typeof window !== 'undefined' ? window.location.search : '');
  const tenant = parseTenantParam(src);
  if (tenant == null || !path.startsWith('/sos')) return path;
  return `${path}${path.includes('?') ? '&' : '?'}tenant=${tenant}`;
}
