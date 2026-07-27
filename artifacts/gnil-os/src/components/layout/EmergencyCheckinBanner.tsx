import { useLocation, useSearch } from 'wouter';
import {
  useGetActiveEmergencyBroadcasts,
  getGetActiveEmergencyBroadcastsQueryKey,
  useSubmitEmergencyCheckin,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Siren } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { CHECKIN_LABELS, checkinBadge } from '@/components/sos/emergency-broadcast-content';

/**
 * Emergency check-in banner — Co-Op Emergency & Crisis Network Broadcast.
 *
 * Rendered in the app shell (alongside the connection banner). While an
 * emergency broadcast targeting the currently scoped business is active, a
 * prominent, non-dismissible banner prompts the owner to set their status —
 * Open / Temporarily Closed / Safe — with one tap, and shows neighboring
 * partners' latest check-ins. Polls so statuses roll in near-real-time and
 * the banner disappears as soon as the alert is resolved.
 */

const POLL_MS = 10000;

// Same rule as parseTenantParam in sos-tenant.tsx, inlined so this shell-level
// component doesn't pull in that module's header-getter side effect (which
// breaks tests that mock @workspace/api-client-react).
function parseTenantParam(search: string): number | null {
  const raw = new URLSearchParams(search).get('tenant');
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
const STATUSES = ['open', 'temporarily_closed', 'safe'] as const;

export function EmergencyCheckinBanner() {
  const [location] = useLocation();
  const search = useSearch();
  // Same scoping rule as the SOS tenant sync: only /sos pages carry a
  // business scope, and the API client attaches x-tenant-id automatically.
  const tenantId = location.startsWith('/sos') ? parseTenantParam(search) : null;
  if (tenantId == null) return null;
  return <BannerInner key={tenantId} tenantId={tenantId} />;
}

function BannerInner({ tenantId }: { tenantId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: alerts } = useGetActiveEmergencyBroadcasts({
    query: {
      queryKey: getGetActiveEmergencyBroadcastsQueryKey(),
      refetchInterval: POLL_MS,
    },
  });

  const checkin = useSubmitEmergencyCheckin({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetActiveEmergencyBroadcastsQueryKey() });
        toast({ title: 'Status posted', description: 'Your network and customers can see it now.' });
      },
      onError: () => toast({ title: 'Could not post your status', variant: 'destructive' }),
    },
  });

  const alert = (alerts ?? [])[0];
  if (!alert) return null;

  const neighbors = alert.roster.filter(r => r.tenantId !== tenantId);
  const checkedIn = neighbors.filter(r => r.status != null);

  return (
    <div
      role="alert"
      className="bg-red-600/10 border-b-2 border-red-600/60 px-4 py-3 text-sm shrink-0 space-y-2"
      data-testid="emergency-checkin-banner"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Siren className="size-5 text-red-600 shrink-0" />
        <span className="font-semibold" data-testid="text-emergency-headline">
          {alert.headline}
        </span>
        <span className="text-muted-foreground">— {alert.senderName}</span>
      </div>
      <div className="text-muted-foreground">{alert.message}</div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">How is your business right now?</span>
        {STATUSES.map(s => (
          <Button
            key={s}
            size="sm"
            variant={alert.myCheckinStatus === s ? 'default' : 'outline'}
            disabled={checkin.isPending}
            onClick={() => checkin.mutate({ id: alert.id, data: { status: s } })}
            data-testid={`button-checkin-${s}`}
          >
            {CHECKIN_LABELS[s]}
          </Button>
        ))}
        {alert.myCheckinStatus != null && (
          <span className="flex items-center gap-1 text-muted-foreground" data-testid="text-my-checkin">
            Your status: {checkinBadge(alert.myCheckinStatus)}
          </span>
        )}
      </div>
      {neighbors.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" data-testid="text-neighbor-statuses">
          <span>
            Network: {checkedIn.length}/{neighbors.length} checked in
          </span>
          {neighbors.slice(0, 6).map(r => (
            <span key={r.tenantId} className="flex items-center gap-1">
              {r.tenantName}: {checkinBadge(r.status)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
