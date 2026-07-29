import {
  listTenants,
  useListTenants,
  getListTenantsQueryKey,
  type Tenant,
} from '@workspace/api-client-react';

const BATCH = 500; // server-side maximum page size

/**
 * Fetch every tenant by walking the paginated /tenants endpoint until a short
 * page. Tenant pickers/selectors must use this (not a bare first page) so no
 * tenant becomes unselectable once the platform grows past one page.
 */
export async function fetchAllTenants(): Promise<Tenant[]> {
  const all: Tenant[] = [];
  for (;;) {
    const page = await listTenants({ limit: BATCH, offset: all.length });
    all.push(...page);
    if (page.length < BATCH) return all;
  }
}

/**
 * Query hook for the complete tenant list. Keeps the generated hook's default
 * unparameterized query key (same as `getListTenantsQueryKey()`) so existing
 * `invalidateQueries({ queryKey: getListTenantsQueryKey() })` calls refresh it,
 * but swaps the fetcher for the paginate-through-everything one.
 */
export function useAllTenants(options?: { enabled?: boolean }) {
  return useListTenants(undefined, {
    query: {
      queryKey: getListTenantsQueryKey(),
      queryFn: fetchAllTenants,
      ...(options?.enabled !== undefined ? { enabled: options.enabled } : {}),
    },
  });
}
