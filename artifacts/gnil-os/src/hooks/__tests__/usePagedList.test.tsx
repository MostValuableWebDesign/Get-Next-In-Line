import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePagedList } from '../usePagedList';

// The load-more pagination contract: extra pages append; ANY first-page
// refresh (mutation invalidation, scope/filter change) drops the appended
// pages so offset misalignment can never duplicate or mix rows; stale
// in-flight responses from before a reset are discarded.

const PAGE = 3;

describe('usePagedList', () => {
  it('passes through undefined while the first page loads', () => {
    const { result } = renderHook(() => usePagedList<number>(undefined, PAGE, async () => []));
    expect(result.current.items).toBeUndefined();
    expect(result.current.hasMore).toBe(false);
  });

  it('offers load-more only when the first page is full, and appends the next page', async () => {
    const fetchPage = vi.fn(async (offset: number) => (offset === 3 ? [4, 5, 6] : [7]));
    const { result } = renderHook(({ first }) => usePagedList<number>(first, PAGE, fetchPage), {
      initialProps: { first: [1, 2, 3] },
    });
    expect(result.current.hasMore).toBe(true);

    await act(() => result.current.loadMore());
    expect(result.current.items).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.current.hasMore).toBe(true);

    // Short page → end reached, button goes away.
    await act(() => result.current.loadMore());
    expect(result.current.items).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.current.hasMore).toBe(false);
    expect(fetchPage).toHaveBeenCalledWith(3);
    expect(fetchPage).toHaveBeenCalledWith(6);
  });

  it('hides load-more for a short first page (small dataset unchanged)', () => {
    const { result } = renderHook(() => usePagedList<number>([1, 2], PAGE, async () => []));
    expect(result.current.hasMore).toBe(false);
    expect(result.current.items).toEqual([1, 2]);
  });

  it('drops appended pages when the first page refreshes (mutation / scope change)', async () => {
    const { result, rerender } = renderHook(
      ({ first }) => usePagedList<number>(first, PAGE, async () => [4, 5, 6]),
      { initialProps: { first: [1, 2, 3] } },
    );
    await act(() => result.current.loadMore());
    expect(result.current.items).toEqual([1, 2, 3, 4, 5, 6]);

    // New first-page reference (e.g. a row was deleted) → extras reset.
    rerender({ first: [1, 3, 4] });
    await waitFor(() => expect(result.current.items).toEqual([1, 3, 4]));
    expect(result.current.hasMore).toBe(true);
  });

  it('discards an in-flight load-more that started before a reset', async () => {
    let resolveFetch!: (v: number[]) => void;
    const fetchPage = vi.fn(
      () => new Promise<number[]>((resolve) => { resolveFetch = resolve; }),
    );
    const { result, rerender } = renderHook(
      ({ first }) => usePagedList<number>(first, PAGE, fetchPage),
      { initialProps: { first: [1, 2, 3] } },
    );

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.loadMore();
      await Promise.resolve(); // let loadMore reach the awaited fetch
    });
    expect(fetchPage).toHaveBeenCalledTimes(1);

    // First page refreshes while the extra-page request is still in flight.
    rerender({ first: [10, 20, 30] });
    await act(async () => {
      resolveFetch([4, 5, 6]); // stale response for the OLD first page
      await pending;
    });

    expect(result.current.items).toEqual([10, 20, 30]); // stale rows discarded
  });
});
