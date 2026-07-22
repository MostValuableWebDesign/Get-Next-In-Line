import { useHealthCheck, getHealthCheckQueryKey } from '@workspace/api-client-react';

/**
 * Shared connection-state hook backed by the API health check.
 * Polls so drops are detected while the app is idle; React Query dedupes
 * the request across every component using this hook.
 */
export function useOnlineStatus() {
  const { data: health, isError, isFetched } = useHealthCheck({
    query: {
      queryKey: getHealthCheckQueryKey(),
      refetchInterval: 15000,
      refetchIntervalInBackground: true,
    },
  });

  return {
    isOnline: !isError && health?.status === 'ok',
    /** True once the health check produced a result (avoids startup flicker). */
    settled: isFetched || isError,
  };
}

/**
 * Convenience: true only when we know for sure the API is unreachable.
 * Used to disable mutating actions without flashing during initial load.
 */
export function useIsOffline() {
  const { isOnline, settled } = useOnlineStatus();
  return settled && !isOnline;
}
