import { useEffect, useRef } from 'react';
import { useLocation, useSearch } from 'wouter';
import { setTenantHeaderGetter } from '@workspace/api-client-react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';

/**
 * SOS tenant (business) scoping.
 *
 * SOS operational endpoints (/api/sos/*) scope their data per business via an
 * `x-tenant-id` request header — with no header the API serves the legacy
 * combined view (NULL-tenant rows only). The selected business travels in the
 * URL as `?tenant=<id>` on the /sos pages, so links, refreshes, and
 * Configuration cross-links all carry the scope.
 *
 * A module-level variable holds the currently effective tenant id; the API
 * client's tenant-header getter reads it and attaches `x-tenant-id` to every
 * /api/sos/* request. Call sites that already pass an explicit x-tenant-id
 * header (e.g. Tenant Detail's Communications tab) are left untouched —
 * explicit headers win.
 */

let currentSosTenantId: number | null = null;

setTenantHeaderGetter((url) => {
  if (currentSosTenantId == null) return null;
  // Only SOS operational endpoints and the merchant-facing co-op endpoints
  // understand this header; everything else must stay unscoped.
  return url.includes('/api/sos/') || url.includes('/api/coop/')
    ? String(currentSosTenantId)
    : null;
});

/** Parse a positive-integer tenant id out of a ?tenant= search param. */
export function parseTenantParam(search: string): number | null {
  const raw = new URLSearchParams(search).get('tenant');
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The tenant id currently applied to /api/sos/* requests (for tests). */
export function getCurrentSosTenantId(): number | null {
  return currentSosTenantId;
}

function dropSosQueries(queryClient: QueryClient) {
  // SOS/co-op query keys start with the request URL; drop them all so data
  // cached under the previous scope can never bleed into the new one.
  queryClient.removeQueries({
    predicate: (q) =>
      typeof q.queryKey[0] === 'string' &&
      (q.queryKey[0].includes('/api/sos/') || q.queryKey[0].includes('/api/coop/')),
  });
}

/**
 * Keeps the module-level SOS tenant scope in sync with the current URL.
 * Mounted once inside the router, above every page: on /sos pages the scope
 * follows ?tenant=<id>; everywhere else it resets to the legacy (combined)
 * view. Whenever the effective scope changes, cached SOS queries are dropped
 * and refetched under the new header.
 */
export function SosTenantSync() {
  const [location] = useLocation();
  const search = useSearch();
  const queryClient = useQueryClient();

  const next = location.startsWith('/sos') ? parseTenantParam(search) : null;

  // Update synchronously during render so queries mounted by sibling pages
  // in this same render pass already fetch under the right scope.
  const prev = useRef(currentSosTenantId);
  currentSosTenantId = next;

  useEffect(() => {
    if (prev.current !== next) {
      prev.current = next;
      dropSosQueries(queryClient);
    }
  }, [next, queryClient]);

  return null;
}
