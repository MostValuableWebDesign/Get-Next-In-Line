import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectGusto, listSosCalls } from '@workspace/api-client-react';

afterEach(() => vi.unstubAllGlobals());

describe('single-business API requests', () => {
  it('does not inject x-tenant-id into normal SOS or Operations requests', async () => {
    const calls: Headers[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Headers(init?.headers));
      return new Response(
        JSON.stringify(calls.length === 1 ? [] : { authorizationUrl: 'https://example.test' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }));

    await listSosCalls();
    await connectGusto();

    expect(calls).toHaveLength(2);
    expect(calls.every((headers) => headers.get('x-tenant-id') === null)).toBe(true);
  });
});