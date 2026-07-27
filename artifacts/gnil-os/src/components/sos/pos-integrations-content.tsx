import { useState } from 'react';
import {
  useListPosIntegrations, getListPosIntegrationsQueryKey,
  useEnablePosIntegration, useDisablePosIntegration,
  useListPosEvents, getListPosEventsQueryKey,
  useSimulatePosEvent,
  type PosIntegration, type PosInboundEvent,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Cable, Copy, Eye, EyeOff, FlaskConical, Plug, PlugZap, RefreshCw } from 'lucide-react';

/**
 * External POS connectors — merchant hub tab.
 *
 * Each business can enable webhook listeners for its external POS/booking
 * system (Square, Clover, Boulevard, Vagaro): the card shows the endpoint
 * URL + signing secret to paste into the vendor's webhook settings, the
 * connection status, and an inspectable inbound event log. A dev simulator
 * posts vendor-shaped payloads through the full pipeline.
 */
export function PosIntegrationsContent({ tenantId }: { tenantId: number | null }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  // Tenant scoping: the SOS tenant header getter (sos-tenant.tsx) attaches
  // x-tenant-id to /api/pos/* requests automatically; the tenantId prop keys
  // the queries so scope switches never reuse another business's cache.
  const { data: integrations, isLoading } = useListPosIntegrations({
    query: { queryKey: [...getListPosIntegrationsQueryKey(), tenantId] },
  });
  const { data: events, isLoading: isLoadingEvents } = useListPosEvents(undefined, {
    query: { queryKey: [...getListPosEventsQueryKey(undefined), tenantId], refetchInterval: 15000 },
  });
  const enable = useEnablePosIntegration();
  const disable = useDisablePosIntegration();

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getListPosIntegrationsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListPosEventsQueryKey(undefined) });
  };

  const onToggle = (integ: PosIntegration) => {
    const mut = integ.status === 'active' ? disable : enable;
    mut.mutate(
      { vendor: integ.vendor },
      {
        onSuccess: () => {
          refresh();
          toast({
            title:
              integ.status === 'active'
                ? `${integ.vendorLabel} connector disabled`
                : `${integ.vendorLabel} connector enabled`,
            description:
              integ.status === 'active'
                ? 'Its webhook endpoint no longer accepts deliveries.'
                : 'Paste the webhook URL and signing secret into the vendor settings.',
          });
        },
        onError: (err) =>
          toast({ title: 'Update failed', description: String(err), variant: 'destructive' }),
      },
    );
  };

  return (
    <div className="space-y-6" data-testid="pos-integrations-content">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Cable className="h-5 w-5" /> POS Connectors
        </h2>
        <p className="text-sm text-muted-foreground">
          Connect your storefront's POS or booking system. Check-ins, completed services, and perk
          redemptions recorded there flow in automatically — no double entry.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {isLoading &&
          [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-44 w-full" />)}
        {integrations?.map((integ) => (
          <VendorCard key={integ.vendor} integ={integ} onToggle={() => onToggle(integ)} busy={enable.isPending || disable.isPending} />
        ))}
      </div>

      <SimulatorCard onDone={refresh} integrations={integrations ?? []} />

      <Card data-testid="card-pos-event-log">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Inbound Event Log</CardTitle>
            <CardDescription>
              Every verified delivery is recorded — including unrecognized or malformed events.
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={refresh} data-testid="button-refresh-pos-events">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent>
          {isLoadingEvents && <Skeleton className="h-24 w-full" />}
          {!isLoadingEvents && (events?.length ?? 0) === 0 && (
            <p className="text-sm text-muted-foreground" data-testid="text-pos-events-empty">
              No POS events received yet.
            </p>
          )}
          <div className="space-y-2">
            {events?.map((e) => (
              <EventRow key={e.id} e={e} />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'processed') return 'default';
  if (status === 'error' || status === 'invalid') return 'destructive';
  if (status === 'unrecognized') return 'outline';
  return 'secondary';
}

function EventRow({ e }: { e: PosInboundEvent }) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm"
      data-testid={`row-pos-event-${e.id}`}
    >
      <Badge variant="secondary" className="capitalize">{e.vendor}</Badge>
      <span className="font-medium">{e.eventKind.replace(/_/g, ' ')}</span>
      <Badge variant={statusVariant(e.status)} data-testid={`badge-pos-event-status-${e.id}`}>
        {e.status}
      </Badge>
      <span className="text-muted-foreground truncate flex-1 min-w-[10rem]">
        {e.detail ?? e.externalEventId}
      </span>
      <span className="text-xs text-muted-foreground">
        {new Date(e.createdAt).toLocaleString()}
      </span>
    </div>
  );
}

function VendorCard({
  integ,
  onToggle,
  busy,
}: {
  integ: PosIntegration;
  onToggle: () => void;
  busy: boolean;
}) {
  const { toast } = useToast();
  const [showSecret, setShowSecret] = useState(false);
  const copy = (label: string, value: string) => {
    navigator.clipboard?.writeText(value);
    toast({ title: `${label} copied` });
  };
  const active = integ.status === 'active';
  return (
    <Card data-testid={`card-pos-${integ.vendor}`}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          {active ? <PlugZap className="h-4 w-4 text-green-600" /> : <Plug className="h-4 w-4" />}
          {integ.vendorLabel}
        </CardTitle>
        <Badge
          variant={active ? 'default' : integ.status === 'disabled' ? 'destructive' : 'secondary'}
          data-testid={`badge-pos-status-${integ.vendor}`}
        >
          {integ.status === 'not_configured' ? 'not connected' : integ.status}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        {integ.webhookUrl && (
          <div className="space-y-1">
            <Label className="text-xs">Webhook endpoint</Label>
            <div className="flex items-center gap-1">
              <Input readOnly value={integ.webhookUrl} className="text-xs" data-testid={`input-pos-webhook-url-${integ.vendor}`} />
              <Button variant="ghost" size="icon" onClick={() => copy('Webhook URL', integ.webhookUrl!)} data-testid={`button-copy-webhook-${integ.vendor}`}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
        {integ.signingSecret && (
          <div className="space-y-1">
            <Label className="text-xs">Signing secret ({integ.signatureHeader})</Label>
            <div className="flex items-center gap-1">
              <Input
                readOnly
                type={showSecret ? 'text' : 'password'}
                value={integ.signingSecret}
                className="text-xs"
                data-testid={`input-pos-secret-${integ.vendor}`}
              />
              <Button variant="ghost" size="icon" onClick={() => setShowSecret((s) => !s)} data-testid={`button-toggle-secret-${integ.vendor}`}>
                {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
              <Button variant="ghost" size="icon" onClick={() => copy('Signing secret', integ.signingSecret!)}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {integ.lastEventAt
              ? `Last event ${new Date(integ.lastEventAt).toLocaleString()}`
              : 'No events yet'}
          </span>
          <Button
            size="sm"
            variant={active ? 'outline' : 'default'}
            disabled={busy}
            onClick={onToggle}
            data-testid={`button-pos-toggle-${integ.vendor}`}
          >
            {active ? 'Disable' : integ.status === 'disabled' ? 'Re-enable' : 'Enable'}
          </Button>
        </div>
        {integ.lastError && (
          <p className="text-xs text-destructive" data-testid={`text-pos-error-${integ.vendor}`}>
            {integ.lastError}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

const SIM_KINDS = [
  { value: 'check_in', label: 'Customer check-in' },
  { value: 'service_completed', label: 'Service completed' },
  { value: 'perk_redeemed', label: 'Perk redeemed' },
] as const;

function SimulatorCard({
  onDone,
  integrations,
}: {
  onDone: () => void;
  integrations: PosIntegration[];
}) {
  const { toast } = useToast();
  const simulate = useSimulatePosEvent();
  const [vendor, setVendor] = useState('square');
  const [kind, setKind] = useState<string>('service_completed');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [service, setService] = useState('');
  const [staff, setStaff] = useState('');
  const [amount, setAmount] = useState('');
  const [perkToken, setPerkToken] = useState('');

  const activeVendors = integrations.filter((i) => i.status === 'active');

  const run = () => {
    simulate.mutate(
      {
        data: {
          vendor: vendor as 'square' | 'clover' | 'boulevard' | 'vagaro',
          kind: kind as 'check_in' | 'service_completed' | 'perk_redeemed',
          customerName: name || null,
          customerPhone: phone || null,
          serviceType: service || null,
          staffName: staff || null,
          paymentAmount: amount ? Number(amount) : null,
          perkToken: perkToken || null,
        },
      },
      {
        onSuccess: (res) => {
          onDone();
          toast({ title: `Simulated ${vendor} event: ${res.status}`, description: res.detail ?? undefined });
        },
        onError: (err) =>
          toast({ title: 'Simulation failed', description: String(err), variant: 'destructive' }),
      },
    );
  };

  return (
    <Card data-testid="card-pos-simulator">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <FlaskConical className="h-4 w-4" /> Webhook Simulator (dev)
        </CardTitle>
        <CardDescription>
          Posts a vendor-shaped, correctly signed payload through the full pipeline — no real
          vendor account needed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Select value={vendor} onValueChange={setVendor}>
            <SelectTrigger data-testid="select-sim-vendor"><SelectValue /></SelectTrigger>
            <SelectContent>
              {['square', 'clover', 'boulevard', 'vagaro'].map((v) => (
                <SelectItem key={v} value={v} className="capitalize">{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger data-testid="select-sim-kind"><SelectValue /></SelectTrigger>
            <SelectContent>
              {SIM_KINDS.map((k) => (
                <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input placeholder="Customer name" value={name} onChange={(e) => setName(e.target.value)} data-testid="input-sim-name" />
          <Input placeholder="Customer phone" value={phone} onChange={(e) => setPhone(e.target.value)} data-testid="input-sim-phone" />
          {kind !== 'perk_redeemed' && (
            <>
              <Input placeholder="Service (e.g. Haircut)" value={service} onChange={(e) => setService(e.target.value)} data-testid="input-sim-service" />
              <Input placeholder="Staff name" value={staff} onChange={(e) => setStaff(e.target.value)} data-testid="input-sim-staff" />
              <Input placeholder="Amount (e.g. 45.00)" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="input-sim-amount" />
            </>
          )}
          {kind === 'perk_redeemed' && (
            <Input placeholder="Perk pass token (WPASS-…)" value={perkToken} onChange={(e) => setPerkToken(e.target.value)} data-testid="input-sim-perk-token" />
          )}
        </div>
        <Button
          onClick={run}
          disabled={simulate.isPending || !activeVendors.some((i) => i.vendor === vendor)}
          data-testid="button-run-simulation"
        >
          {simulate.isPending ? 'Sending…' : 'Send simulated webhook'}
        </Button>
        {!activeVendors.some((i) => i.vendor === vendor) && (
          <p className="text-xs text-muted-foreground">Enable this connector first.</p>
        )}
      </CardContent>
    </Card>
  );
}
