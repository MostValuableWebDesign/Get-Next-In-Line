import { useEffect, useRef, useState } from 'react';

/**
 * Load-more pagination over a react-query-backed first page plus imperatively
 * fetched extra pages (offset pagination).
 *
 * Correctness invariants:
 * - Whenever the first page refreshes (mutation invalidation, scope/filter
 *   change, tenant switch), all appended pages are dropped — offsets computed
 *   against an old first page are no longer aligned, so concatenating them
 *   could duplicate, drop, or mix rows.
 * - In-flight load-more responses from before a reset are discarded
 *   (generation guard), so a slow response can never append stale rows.
 */
export function usePagedList<T>(
  firstPage: T[] | undefined,
  pageSize: number,
  fetchPage: (offset: number) => Promise<T[]>,
) {
  const [extra, setExtra] = useState<T[]>([]);
  const [endReached, setEndReached] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const generationRef = useRef(0);

  // react-query preserves the data reference when a refetch returns identical
  // data (structural sharing), so this only resets when content changed or
  // the query key (scope) changed.
  useEffect(() => {
    generationRef.current++;
    // Avoid redundant state updates (and render loops if a caller ever passes
    // a referentially unstable first page with nothing appended).
    setExtra((prev) => (prev.length === 0 ? prev : []));
    setEndReached((prev) => (prev ? false : prev));
  }, [firstPage]);

  const items = firstPage ? [...firstPage, ...extra] : firstPage;
  const hasMore = !endReached && (firstPage?.length ?? 0) === pageSize;

  const loadMore = async () => {
    if (loadingMore || !items) return;
    const generation = generationRef.current;
    setLoadingMore(true);
    try {
      const next = await fetchPage(items.length);
      if (generationRef.current !== generation) return; // reset happened mid-flight
      setExtra((prev) => [...prev, ...next]);
      if (next.length < pageSize) setEndReached(true);
    } finally {
      setLoadingMore(false);
    }
  };

  return { items, hasMore, loadingMore, loadMore };
}
