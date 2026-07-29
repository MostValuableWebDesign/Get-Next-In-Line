import { useAllTenants } from '@/hooks/useAllTenants';
import { useState } from 'react';
import {
  useListEmergencyBroadcasts, getListEmergencyBroadcastsQueryKey,
  useCreateEmergencyBroadcast,
  useResolveEmergencyBroadcast,
  useSubmitEmergencyCheckin,
  getGetActiveEmergencyBroadcastsQueryKey,
  useListTenants, getListTenantsQueryKey,
  type EmergencyBroadcast,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { CheckCircle2, CircleDot, Megaphone, Radio, ShieldCheck, Store } from 'lucide-react';

/**
 * Co-Op Emergency & Crisis Network Broadcast console.
 *
 * Shared between two surfaces:
 *  - Merchant (tenantId != null, header attached automatically on /sos pages):
 *    a local leader broadcasts to their accepted co-op partner network.
 *  - Admin Command Center (tenantId == null, unscoped): platform-wide or
 *    selected-tenant broadcasts.
 * Both see delivery progress, the live check-in roster, and can resolve
 * their own broadcasts.
 */

export const ALERT_TYPES = [
  { value: 'weather_closure', label: 'Severe weather closure' },
  { value: 'power_outage', label: 'Power outage' },
  { value: 'safety_alert', label: 'Safety alert' },
  { value: 'schedule_change', label: 'Sudden schedule change' },
  { value: 'other', label: 'Other' },
] as const;

export const SEVERITIES = [
  { value: 'info', label: 'Info' },
  { value: 'warning', label: 'Warning' },
  { value: 'critical', label: 'Critical' },
] as const;

export const CHECKIN_LABELS: Record<string, string> = {
  open: 'Open',
  temporarily_closed: 'Temporarily Closed',
  safe: 'Safe',
};

export const alertTypeLabel = (v: string) => ALERT_TYPES.find(t => t.value === v)?.label ?? v;

const POLL_MS = 10000;

function severityBadge(severity: string) {
  const cls =
    severity === 'critical'
      ? 'bg-destructive text-destructive-foreground'
      : severity === 'warning'
        ? 'bg-amber-500 text-white'
        : 'bg-sky-500 text-white';
  return <Badge className={cls} data-testid={`badge-severity-${severity}`}>{severity.toUpperCase()}</Badge>;
}

export function checkinBadge(status: string | null) {
  if (status == null) {
    return <Badge variant="outline" className="text-muted-foreground">Awaiting check-in</Badge>;
  }
  const cls =
    status === 'open'
      ? 'bg-emerald-600 text-white'
      : status === 'safe'
        ? 'bg-sky-600 text-white'
        : 'bg-red-600 text-white';
  return <Badge className={cls}>{CHECKIN_LABELS[status] ?? status}</Badge>;
}

export function EmergencyBroadcastContent({ tenantId }: { tenantId: number | null }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const isAdmin = tenantId == null;

  const { data: broadcasts, isLoading } = useListEmergencyBroadcasts({
    query: { queryKey: getListEmergencyBroadcastsQueryKey(), refetchInterval: POLL_MS },
  });

  const [composeOpen, setComposeOpen] = useState(false);
  const active = (broadcasts ?? []).filter(b => b.status === 'active');
  const resolved = (broadcasts ?? []).filter(b => b.status === 'resolved');

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListEmergencyBroadcastsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetActiveEmergencyBroadcastsQueryKey() });
  };

  const resolveBroadcast = useResolveEmergencyBroadcast({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: 'Broadcast resolved', description: 'Check-in banners and landing statuses are cleared.' });
      },
      onError: () => toast({ title: 'Could not resolve broadcast', variant: 'destructive' }),
    },
  });

  return (
    <div className="space-y-6" data-testid="emergency-broadcast-console">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <Radio className="w-5 h-5 text-destructive" /> Emergency Network Broadcasts
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            {isAdmin
              ? 'Push a critical community alert to the whole platform or selected businesses. Each target\u2019s subscribers get an SMS and the owner is prompted to check in.'
              : 'Push a critical alert to your co-op partner network. Every partner\u2019s subscribers get an SMS and each business is prompted to check in as Open, Temporarily Closed, or Safe.'}
          </p>
        </div>
        <Button onClick={() => setComposeOpen(true)} data-testid="button-compose-broadcast">
          <Megaphone className="w-4 h-4 mr-2" /> Send Emergency Broadcast
        </Button>
      </div>

      <ComposeDialog
        open={composeOpen}
        onOpenChange={setComposeOpen}
        isAdmin={isAdmin}
        onCreated={invalidate}
      />

      {isLoading ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : (broadcasts ?? []).length === 0 ? (
        <Card className="border-dashed shadow-none">
          <CardContent className="p-10 text-center text-muted-foreground" data-testid="text-no-broadcasts">
            No emergency broadcasts yet.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {[...active, ...resolved].map(b => (
            <BroadcastCard
              key={b.id}
              broadcast={b}
              canResolve={b.status === 'active' && (isAdmin || b.senderTenantId === tenantId)}
              onResolve={() => resolveBroadcast.mutate({ id: b.id })}
              resolving={resolveBroadcast.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BroadcastCard({
  broadcast: b,
  canResolve,
  onResolve,
  resolving,
}: {
  broadcast: EmergencyBroadcast;
  canResolve: boolean;
  onResolve: () => void;
  resolving: boolean;
}) {
  return (
    <Card className={b.status === 'active' ? 'border-destructive/40' : ''} data-testid={`card-broadcast-${b.id}`}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-base">
              {severityBadge(b.severity)}
              <span data-testid={`text-broadcast-headline-${b.id}`}>{b.headline}</span>
            </CardTitle>
            <CardDescription>
              {alertTypeLabel(b.alertType)} · from {b.senderName} ·{' '}
              {new Date(b.createdAt).toLocaleString()}
              {b.status === 'resolved' && (
                <Badge variant="outline" className="ml-2">Resolved</Badge>
              )}
            </CardDescription>
          </div>
          {canResolve && (
            <Button
              variant="outline"
              size="sm"
              disabled={resolving}
              onClick={onResolve}
              data-testid={`button-resolve-broadcast-${b.id}`}
            >
              <ShieldCheck className="w-4 h-4 mr-2" /> Resolve
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">{b.message}</p>
        <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
          <span className="flex items-center gap-1" data-testid={`text-broadcast-targets-${b.id}`}>
            <Store className="w-4 h-4" /> {b.targetCount} businesses alerted
          </span>
          <span className="flex items-center gap-1" data-testid={`text-broadcast-checkins-${b.id}`}>
            <CircleDot className="w-4 h-4" /> {b.checkedInCount}/{b.targetCount} checked in
          </span>
          <span className="flex items-center gap-1" data-testid={`text-broadcast-sms-${b.id}`}>
            <CheckCircle2 className="w-4 h-4" /> {b.smsSentCount} subscriber texts sent
          </span>
        </div>
        {b.roster.length > 0 && (
          <div className="border rounded-lg divide-y" data-testid={`roster-broadcast-${b.id}`}>
            {b.roster.map(r => (
              <div key={r.tenantId} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="truncate">{r.tenantName}</span>
                <span className="flex items-center gap-2 shrink-0">
                  {r.note && <span className="text-xs text-muted-foreground truncate max-w-[16rem]">{r.note}</span>}
                  {checkinBadge(r.status)}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ComposeDialog({
  open,
  onOpenChange,
  isAdmin,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  isAdmin: boolean;
  onCreated: () => void;
}) {
  const { toast } = useToast();
  const [severity, setSeverity] = useState('warning');
  const [alertType, setAlertType] = useState('weather_closure');
  const [headline, setHeadline] = useState('');
  const [message, setMessage] = useState('');
  const [adminScope, setAdminScope] = useState<'platform' | 'selected'>('platform');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // Admin selected-scope target picker only.
  const { data: tenants } = useAllTenants({ enabled: isAdmin && open });

  const create = useCreateEmergencyBroadcast({
    mutation: {
      onSuccess: () => {
        onCreated();
        onOpenChange(false);
        setHeadline('');
        setMessage('');
        setSelectedIds(new Set());
        toast({
          title: 'Emergency broadcast sent',
          description: 'Subscriber texts are going out and partners are being prompted to check in.',
        });
      },
      onError: (err: unknown) => {
        const msg =
          (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          'Could not send the broadcast.';
        toast({ title: 'Broadcast failed', description: msg, variant: 'destructive' });
      },
    },
  });

  const submit = () => {
    if (!headline.trim() || !message.trim()) {
      toast({ title: 'Headline and message are required', variant: 'destructive' });
      return;
    }
    create.mutate({
      data: {
        severity: severity as 'info' | 'warning' | 'critical',
        alertType: alertType as 'weather_closure' | 'power_outage' | 'safety_alert' | 'schedule_change' | 'other',
        headline: headline.trim(),
        message: message.trim(),
        ...(isAdmin
          ? adminScope === 'selected'
            ? { scope: 'selected' as const, targetTenantIds: [...selectedIds] }
            : { scope: 'platform' as const }
          : {}),
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Send Emergency Broadcast</DialogTitle>
          <DialogDescription>
            {isAdmin
              ? 'This alert reaches every targeted business and their subscribers immediately.'
              : 'This alert reaches every accepted co-op partner and their subscribers immediately.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Severity</Label>
              <Select value={severity} onValueChange={setSeverity}>
                <SelectTrigger data-testid="select-broadcast-severity"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SEVERITIES.map(s => (
                    <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={alertType} onValueChange={setAlertType}>
                <SelectTrigger data-testid="select-broadcast-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ALERT_TYPES.map(t => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {isAdmin && (
            <div className="space-y-1.5">
              <Label>Targeting</Label>
              <Select value={adminScope} onValueChange={(v) => setAdminScope(v as 'platform' | 'selected')}>
                <SelectTrigger data-testid="select-broadcast-scope"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="platform">Whole platform</SelectItem>
                  <SelectItem value="selected">Selected businesses</SelectItem>
                </SelectContent>
              </Select>
              {adminScope === 'selected' && (
                <div className="border rounded-lg max-h-40 overflow-auto divide-y mt-2" data-testid="list-target-tenants">
                  {(tenants ?? []).map(t => (
                    <label key={t.id} className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(t.id)}
                        onChange={(e) => {
                          setSelectedIds(prev => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(t.id); else next.delete(t.id);
                            return next;
                          });
                        }}
                        data-testid={`checkbox-target-${t.id}`}
                      />
                      {t.brandName}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Headline</Label>
            <Input
              value={headline}
              maxLength={120}
              onChange={e => setHeadline(e.target.value)}
              placeholder="e.g. Flash flood warning — plaza closing early"
              data-testid="input-broadcast-headline"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Message</Label>
            <Textarea
              value={message}
              maxLength={1000}
              onChange={e => setMessage(e.target.value)}
              placeholder="What happened, what customers should expect, and when you'll post updates."
              data-testid="input-broadcast-message"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={submit}
            disabled={create.isPending || (isAdmin && adminScope === 'selected' && selectedIds.size === 0)}
            data-testid="button-send-broadcast"
          >
            <Megaphone className="w-4 h-4 mr-2" />
            {create.isPending ? 'Sending…' : 'Send Broadcast'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
