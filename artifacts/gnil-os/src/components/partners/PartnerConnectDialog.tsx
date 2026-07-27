import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useConnectPartner,
  useCompletePartnerAuthorization,
  useDisconnectPartner,
  useGetPartnerConnectionStatus,
  getGetPartnerConnectionStatusQueryKey,
  getListPartnerConnectionsQueryKey,
} from '@workspace/api-client-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { CheckCircle2, History, Link2, Loader2, PlugZap, ShieldCheck, Unplug } from 'lucide-react';

const STATUS_LABEL: Record<string, string> = {
  not_connected: 'Not Connected',
  pending: 'Pending Authorization',
  active: 'Active',
  error: 'Connection Error',
};

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  not_connected: 'secondary',
  pending: 'outline',
  active: 'default',
  error: 'destructive',
};

export function PartnerStatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant={STATUS_VARIANT[status] ?? 'secondary'}
      className="uppercase text-[10px] tracking-wider"
      data-testid={`badge-connection-${status}`}
    >
      {STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

/**
 * Partner integration workflow dialog: connect → authorize → active.
 * Shows live connection state, last-sync info, and the audit history for the
 * partner, plus disconnect. The OAuth handshake runs against the app's
 * sandbox partner gateway (no live credentials).
 */
export function PartnerConnectDialog({
  open,
  onOpenChange,
  partnerId,
  partnerBrand,
  title,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  partnerId: string;
  partnerBrand: string;
  title: string;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [pendingState, setPendingState] = useState<string | null>(null);

  const { data: status, isLoading } = useGetPartnerConnectionStatus(partnerId, {
    query: { queryKey: getGetPartnerConnectionStatusQueryKey(partnerId), enabled: open },
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetPartnerConnectionStatusQueryKey(partnerId) });
    queryClient.invalidateQueries({ queryKey: getListPartnerConnectionsQueryKey() });
  };

  const connect = useConnectPartner();
  const authorize = useCompletePartnerAuthorization();
  const disconnect = useDisconnectPartner();

  const handleConnect = () => {
    connect.mutate(
      { partnerId },
      {
        onSuccess: (result) => {
          setPendingState(result.state);
          invalidate();
          toast({ title: 'Handshake started', description: `${partnerBrand} authorization is pending.` });
        },
        onError: () => toast({ title: 'Connection failed', description: 'Could not start the handshake. Please try again.', variant: 'destructive' }),
      },
    );
  };

  const handleAuthorize = () => {
    if (!pendingState) return;
    authorize.mutate(
      { partnerId, data: { state: pendingState, code: `auth_${Date.now()}` } },
      {
        onSuccess: () => {
          setPendingState(null);
          invalidate();
          toast({ title: 'Connected', description: `${partnerBrand} integration is now active.` });
        },
        onError: () => {
          invalidate();
          toast({ title: 'Authorization failed', description: 'The handshake could not be completed.', variant: 'destructive' });
        },
      },
    );
  };

  const handleDisconnect = () => {
    disconnect.mutate(
      { partnerId },
      {
        onSuccess: () => {
          setPendingState(null);
          invalidate();
          toast({ title: 'Disconnected', description: `${partnerBrand} credentials were removed.` });
        },
        onError: () => toast({ title: 'Disconnect failed', description: 'Please try again.', variant: 'destructive' }),
      },
    );
  };

  const connState = status?.status ?? 'not_connected';
  const busy = connect.isPending || authorize.isPending || disconnect.isPending;
  // A pending connection can be resumed even after reopening the dialog only
  // when we still hold the state token from this session; otherwise restart.
  const canAuthorize = connState === 'pending' && pendingState != null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="partner-connect-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PlugZap className="w-5 h-5 text-primary" /> {title}
          </DialogTitle>
          <DialogDescription>
            Powered by <span className="font-semibold text-foreground">{partnerBrand}</span> — secure
            partner-direct connection. Credentials are stored encrypted and never leave the server.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-3 py-2">
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-24 w-full rounded-lg" />
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/30">
              <span className="text-sm font-medium">Connection Status</span>
              <PartnerStatusBadge status={connState} />
            </div>

            {connState === 'active' && (
              <div className="p-3 border border-emerald-500/20 bg-emerald-500/5 rounded-lg space-y-1" data-testid="partner-sync-info">
                <div className="flex items-center gap-2 text-sm font-medium text-emerald-600">
                  <CheckCircle2 className="w-4 h-4" /> Integration active
                </div>
                <div className="text-xs text-muted-foreground">
                  Connected {status?.connectedAt ? new Date(status.connectedAt).toLocaleString() : '—'}
                  {' · '}Last sync {status?.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : '—'}
                </div>
              </div>
            )}

            {connState === 'error' && status?.lastError && (
              <div className="p-3 border border-destructive/30 bg-destructive/5 rounded-lg text-xs text-destructive" data-testid="partner-connection-error">
                {status.lastError}
              </div>
            )}

            {connState === 'pending' && !canAuthorize && (
              <p className="text-xs text-muted-foreground" data-testid="partner-pending-stale">
                A previous authorization was left unfinished. Restart the connection to continue.
              </p>
            )}

            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                <History className="w-3.5 h-3.5" /> Connection History
              </div>
              {!status?.events?.length ? (
                <p className="text-xs text-muted-foreground" data-testid="partner-no-history">
                  No connection events yet.
                </p>
              ) : (
                <div className="max-h-40 overflow-y-auto divide-y border rounded-lg" data-testid="partner-event-list">
                  {status.events.map((e) => (
                    <div key={e.id} className="px-3 py-2 text-xs flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium">{e.eventType.replace(/_/g, ' ')}</div>
                        {e.details && <div className="text-muted-foreground">{e.details}</div>}
                      </div>
                      <span className="text-muted-foreground whitespace-nowrap">
                        {new Date(e.createdAt).toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          {connState === 'active' ? (
            <Button
              variant="outline"
              className="gap-2"
              onClick={handleDisconnect}
              disabled={busy}
              data-testid="btn-partner-disconnect"
            >
              <Unplug className="w-4 h-4" /> Disconnect
            </Button>
          ) : canAuthorize ? (
            <Button className="gap-2" onClick={handleAuthorize} disabled={busy} data-testid="btn-partner-authorize">
              {authorize.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
              Authorize Connection
            </Button>
          ) : (
            <Button className="gap-2" onClick={handleConnect} disabled={busy || isLoading} data-testid="btn-partner-connect">
              {connect.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
              {connState === 'error' || connState === 'pending' ? 'Restart Connection' : 'Connect'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
