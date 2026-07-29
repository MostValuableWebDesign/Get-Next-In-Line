import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Tenant } from '@workspace/api-client-react';

// Tenant pickers must see EVERY tenant, even once the platform outgrows a
// single server page — fetchAllTenants walks the paginated endpoint until a
// short page instead of silently truncating at the server default.

vi.mock('@workspace/api-client-react', () => ({
  listTenants: vi.fn(),
  useListTenants: vi.fn(),
  getListTenantsQueryKey: () => ['/tenants'],
}));

import { listTenants } from '@workspace/api-client-react';
import { fetchAllTenants } from '../useAllTenants';

const mockedList = vi.mocked(listTenants);
const tenant = (id: number) => ({ id, name: `Tenant ${id}` }) as unknown as Tenant;

describe('fetchAllTenants', () => {
  beforeEach(() => mockedList.mockReset());

  it('returns a single short page as-is (small dataset)', async () => {
    mockedList.mockResolvedValueOnce([tenant(1), tenant(2)]);
    const all = await fetchAllTenants();
    expect(all).toHaveLength(2);
    expect(mockedList).toHaveBeenCalledTimes(1);
    expect(mockedList).toHaveBeenCalledWith({ limit: 500, offset: 0 });
  });

  it('keeps paging past the server cap so no tenant is truncated', async () => {
    const first = Array.from({ length: 500 }, (_, i) => tenant(i + 1));
    const second = Array.from({ length: 500 }, (_, i) => tenant(i + 501));
    const third = [tenant(1001), tenant(1002)];
    mockedList
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(third);

    const all = await fetchAllTenants();

    expect(all).toHaveLength(1002);
    expect(all[0].id).toBe(1);
    expect(all[1001].id).toBe(1002);
    expect(mockedList).toHaveBeenNthCalledWith(2, { limit: 500, offset: 500 });
    expect(mockedList).toHaveBeenNthCalledWith(3, { limit: 500, offset: 1000 });
  });

  it('stops exactly on a full-page boundary', async () => {
    const first = Array.from({ length: 500 }, (_, i) => tenant(i + 1));
    mockedList.mockResolvedValueOnce(first).mockResolvedValueOnce([]);
    const all = await fetchAllTenants();
    expect(all).toHaveLength(500);
    expect(mockedList).toHaveBeenCalledTimes(2);
  });
});
