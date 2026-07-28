import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CloudOff, RefreshCw, AlertTriangle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useOnlineStatus } from '@/hooks/use-online';
import { refreshPassKeys } from '@/lib/offline-pass';
import {
  listPendingRedemptions,
  listSyncIssues,
  dismissSyncIssue,
  syncPendingRedemptions,
  type SyncIssue,
} from '@/lib/offline-redemptions';

// ---------------------------------------------------------------------------
// Co-Op Offline Fallback Mode — sync orchestration + merchant-facing status.
//
// While online: keeps the offline verification keys cached and pushes any
// queued offline redemptions to the server (on app open and automatically the
// moment connectivity returns). Conflict/rejected outcomes are kept until the
// merchant dismisses them, so a pass redeemed at two offline devices is
// surfaced — with which redemption won — rather than silently dropped.
// ---------------------------------------------------------------------------

export function useOfflineCoopSync(tenantId: number) {
  const { isOnline, settled } = useOnlineStatus();
  const isOffline = settled && !isOnline;
  const queryClient = useQueryClient();
  const [pendingCount, setPendingCount] = useState(0);
  const [issues, setIssues] = useState<SyncIssue[]>([]);
  const [syncing, setSyncing] = useState(false);
  const syncingRef = useRef(false);
  const wasOnlineRef = useRef<boolean | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [pending, storedIssues] = await Promise.all([listPendingRedemptions(), listSyncIssues()]);
      setPendingCount(pending.filter(p => p.tenantId === tenantId).length);
      setIssues(storedIssues);
    } catch {
      // IndexedDB unavailable (private mode edge cases) — queue features degrade.
    }
  }, [tenantId]);

  const syncNow = useCallback(async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      const run = await syncPendingRedemptions(tenantId);
      if (run.accepted > 0) {
        queryClient.invalidateQueries({
          predicate: q => typeof q.queryKey[0] === 'string' && q.queryKey[0].includes('/api/coop/'),
        });
      }
    } catch {
      // Transport failure — the queue stays intact for the next attempt.
    } finally {
      syncingRef.current = false;
      setSyncing(false);
      await refresh();
    }
  }, [tenantId, queryClient, refresh]);

  // Load queue state on mount and keep keys fresh / auto-sync while online.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!settled) return;
    const cameBackOnline = isOnline && wasOnlineRef.current === false;
    const firstOnline = isOnline && wasOnlineRef.current === null;
    wasOnlineRef.current = isOnline;
    if (isOnline && (cameBackOnline || firstOnline)) {
      void refreshPassKeys();
      void syncNow();
    }
  }, [isOnline, settled, syncNow]);

  const dismissIssue = useCallback(async (clientRedemptionId: string) => {
    await dismissSyncIssue(clientRedemptionId);
    setIssues(prev => prev.filter(i => i.clientRedemptionId !== clientRedemptionId));
  }, []);

  return { isOffline, pendingCount, issues, syncing, syncNow, dismissIssue, refreshQueue: refresh };
}

export type OfflineCoopSync = ReturnType<typeof useOfflineCoopSync>;

/** Pending-sync banner + post-sync conflict review, shown in the Co-Op hub. */
export function OfflineSyncStatus({ sync }: { sync: OfflineCoopSync }) {
  const { isOffline, pendingCount, issues, syncing, syncNow, dismissIssue } = sync;
  if (pendingCount === 0 && issues.length === 0) return null;

  return (
    <div className="space-y-2" data-testid="offline-sync-status">
      {pendingCount > 0 && (
        <div
          className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm"
          role="status"
          data-testid="banner-pending-sync"
        >
          <CloudOff className="w-4 h-4 text-amber-600 shrink-0" />
          <span className="flex-1">
            <Badge variant="outline" className="mr-1.5 font-mono" data-testid="badge-pending-sync-count">
              {pendingCount}
            </Badge>
            offline redemption{pendingCount === 1 ? '' : 's'} waiting to sync
            {isOffline ? ' — will upload automatically when you reconnect.' : '.'}
          </span>
          {!isOffline && (
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void syncNow()} disabled={syncing} data-testid="button-sync-now">
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} /> Sync now
            </Button>
          )}
        </div>
      )}

      {issues.map(issue => (
        <div
          key={issue.clientRedemptionId}
          className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm"
          role="alert"
          data-testid={`issue-offline-sync-${issue.outcome}`}
        >
          <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
          <div className="flex-1 space-y-0.5">
            <div className="font-medium">
              {issue.outcome === 'conflict'
                ? 'Offline redemption lost to an earlier scan'
                : 'Offline redemption was rejected at sync'}
            </div>
            <div className="text-muted-foreground">
              {issue.perkTitle ? `${issue.perkTitle} — ` : ''}pass {issue.passCode}, scanned{' '}
              {new Date(issue.scannedAt).toLocaleString()}.
              {issue.outcome === 'conflict' && issue.winningRedeemedAt
                ? ` The winning redemption happened ${new Date(issue.winningRedeemedAt).toLocaleString()}.`
                : ''}
              {issue.reason ? ` ${issue.reason}` : ''} The entry was recorded for audit.
            </div>
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 shrink-0"
            onClick={() => void dismissIssue(issue.clientRedemptionId)}
            data-testid="button-dismiss-sync-issue"
          >
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      ))}
    </div>
  );
}
