import React, { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'wouter';
import {
  useListSosCalls, useListSosMessages, useSimulateSosCall, useSendSosMessage,
  useGetSosSettings, useUpdateSosSettings, getGetSosSettingsQueryKey,
  useGetTenantSettings, useUpdateTenantSettings, getGetTenantSettingsQueryKey,
  useGetTenant, getGetTenantQueryKey,
  getListSosCallsQueryKey, getListSosMessagesQueryKey,
  useListSosServices, getListSosServicesQueryKey,
  type SosCustomer,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, Bot, MessageSquare, Phone, Play, Send } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { MessageHistoryTable, type MessageHistoryItem } from '@/components/message-history';
import { SmsConversations } from '@/components/sms-conversations';
import { CustomerPicker } from '@/components/sos/customer-picker';

/**
 * Unified AI Receptionist view.
 *
 * One place for everything receptionist-related: configuration (enable
 * toggle + service names), the inbound-call simulator, the live call log,
 * and the SMS broadcast history with the manual-send control. Replaces the
 * old split between the Configuration page (setup) and the Marketing &
 * Comms page (live logs).
 *
 * Rendered in two contexts:
 *  - /sos/ai-receptionist — the legacy/global settings record, plus the
 *    call log, simulator, and SMS history
 *  - /tenants/:id/ai-receptionist — that tenant's own receptionist
 *    settings (configuration only; call/SMS logs are business-wide views)
 *
 * This page is the single editing home for AI Receptionist settings — the
 * Configuration page only shows read-only status linking here.
 */
export function AiReceptionistPage({
  embedded = false,
  tenantId: tenantIdProp = null,
}: {
  embedded?: boolean;
  /** Business scope from the SOS business selector (?tenant=) — when set,
   *  settings load from that tenant's record and the call/SMS logs are
   *  scoped to it via the x-tenant-id header. */
  tenantId?: number | null;
}) {
  const params = useParams<{ id?: string }>();
  const routeTenantId = params.id != null ? Number(params.id) : null;
  const tenantId = tenantIdProp ?? routeTenantId;
  const isTenantScoped = tenantId != null && Number.isInteger(tenantId);
  // Logs render on the global console and on the business-scoped console
  // (where the x-tenant-id header filters them); the Tenant Detail embed
  // links to its Communications tab instead of duplicating them.
  const showLogs = !isTenantScoped || tenantIdProp != null;

  const globalQuery = useGetSosSettings({
    query: { queryKey: getGetSosSettingsQueryKey(), enabled: !isTenantScoped },
  });
  const tenantQuery = useGetTenantSettings(tenantId ?? 0, {
    query: {
      queryKey: getGetTenantSettingsQueryKey(tenantId ?? 0),
      enabled: isTenantScoped,
    },
  });
  const { data: tenant } = useGetTenant(tenantId ?? 0, {
    query: { queryKey: getGetTenantQueryKey(tenantId ?? 0), enabled: isTenantScoped },
  });
  const settings = isTenantScoped ? tenantQuery.data : globalQuery.data;

  const updateGlobal = useUpdateSosSettings();
  const updateTenant = useUpdateTenantSettings();
  const update = isTenantScoped
    ? { isPending: updateTenant.isPending }
    : { isPending: updateGlobal.isPending };
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [aiReceptionistEnabled, setAiReceptionistEnabled] = useState(false);
  const initialized = useRef(false);

  // Re-initialize local form state when switching between settings records
  // (global ↔ tenant, or one tenant to another) so stale values from the
  // previous scope are never saved into the new one.
  useEffect(() => {
    initialized.current = false;
  }, [tenantId]);

  useEffect(() => {
    if (settings && !initialized.current) {
      setAiReceptionistEnabled(settings.aiReceptionistEnabled);
      initialized.current = true;
    }
  }, [settings]);

  const save = (data: { aiReceptionistEnabled: boolean }) => {
    const onSuccess = () => {
      queryClient.invalidateQueries({
        queryKey: isTenantScoped
          ? getGetTenantSettingsQueryKey(tenantId!)
          : getGetSosSettingsQueryKey(),
      });
      toast({ title: 'AI Receptionist settings saved' });
    };
    const onError = () => {
      toast({
        title: "Couldn't save AI Receptionist settings",
        description: 'Please try again.',
        variant: 'destructive',
      });
    };
    if (isTenantScoped) {
      updateTenant.mutate({ id: tenantId!, data }, { onSuccess, onError });
    } else {
      updateGlobal.mutate({ data }, { onSuccess, onError });
    }
  };

  // Inline enable from the disabled-state banner — no cross-page hop.
  const enableNow = () => {
    setAiReceptionistEnabled(true);
    save({ aiReceptionistEnabled: true });
  };

  return (
    <div className={embedded ? "space-y-6" : "p-8 max-w-6xl mx-auto space-y-6"} data-testid="page-ai-receptionist">
      {isTenantScoped && !embedded && (
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="gap-2 -ml-2 text-muted-foreground"
          data-testid="link-back-tenant"
        >
          <Link href={`/tenants/${tenantId}`}>
            <ArrowLeft className="w-4 h-4" /> Back to {tenant?.brandName ?? 'Tenant'}
          </Link>
        </Button>
      )}
      <div>
        <h1 className={embedded ? "text-xl font-semibold tracking-tight" : "text-3xl font-bold tracking-tight"}>AI Receptionist</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {isTenantScoped ? (
            <>
              Receptionist settings for{' '}
              <span className="font-medium" data-testid="text-ai-receptionist-tenant">
                {tenant?.brandName ?? `tenant #${tenantId}`}
              </span>{' '}
              only — changes here never affect other businesses.
            </>
          ) : (
            'Configure, test, and monitor the AI Receptionist — settings, call logs, and SMS broadcasts, all in one place.'
          )}
        </p>
      </div>

      {settings && !settings.aiReceptionistEnabled && (
        <div
          className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-700 dark:text-amber-400"
          data-testid="banner-ai-disabled"
        >
          <span>The AI Receptionist is currently disabled — new calls won't be answered.</span>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={enableNow}
            disabled={update.isPending}
            data-testid="button-enable-ai"
          >
            Enable now
          </Button>
        </div>
      )}

      {/* ── Configuration ─────────────────────────────────────────────── */}
      <Card id="ai-receptionist" className="scroll-mt-6" data-testid="section-ai-receptionist">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2">
              <Bot className="w-5 h-5 text-primary" /> Configuration
            </CardTitle>
            <Badge
              variant={settings?.aiReceptionistEnabled ? 'default' : 'secondary'}
              data-testid="badge-ai-receptionist"
            >
              {settings?.aiReceptionistEnabled ? 'Enabled' : 'Disabled'}
            </Badge>
          </div>
          <CardDescription>Autonomous call handling for your business.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between p-4 border rounded-lg">
            <div className="space-y-0.5">
              <Label className="text-base">AI Receptionist</Label>
              <p className="text-sm text-muted-foreground">
                Automatically answer calls, take messages, and book appointments.
              </p>
            </div>
            <Switch
              checked={aiReceptionistEnabled}
              onCheckedChange={setAiReceptionistEnabled}
              data-testid="switch-ai-receptionist"
            />
          </div>
          <ServiceVocabularyCard
            tenantId={tenantId}
            legacyServiceNames={settings?.serviceNames}
          />
          <div className="flex justify-end">
            <Button
              onClick={() => save({ aiReceptionistEnabled })}
              disabled={update.isPending}
              data-testid="button-save-ai-receptionist"
            >
              Save AI Receptionist
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Per-tenant, the call and SMS logs live on the unified
          Communications tab — link there instead of duplicating them. */}
      {isTenantScoped && !showLogs && (
        <div
          className="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 px-4 py-2.5 text-sm text-muted-foreground"
          data-testid="banner-comms-link"
        >
          <span>Looking for call logs and SMS history? They're in the Communications tab.</span>
          <Button asChild variant="outline" size="sm" className="shrink-0" data-testid="link-communications-tab">
            <Link href={`/tenants/${tenantId}?tab=communications`}>
              <MessageSquare className="w-4 h-4 mr-1.5" /> View Communications
            </Link>
          </Button>
        </div>
      )}

      {/* Call logs, the simulator, and SMS history — business-wide on the
          global page, scoped by x-tenant-id when a business is selected. */}
      {showLogs && (
        <>
      {/* ── Call log ──────────────────────────────────────────────────── */}
      <div className="space-y-4" data-testid="section-call-logs">
        <div className="flex justify-between items-center">
          <h2 className="text-xl font-semibold">Call Logs</h2>
          <SimulateCallDialog />
        </div>
        <CallLogList />
      </div>

      {/* ── SMS broadcast history ─────────────────────────────────────── */}
      <div className="space-y-4" data-testid="section-sms-history">
        {settings && settings.smsMode !== 'live' && (
          <div
            className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-700 dark:text-amber-400"
            data-testid="banner-sms-simulated"
          >
            <span>SMS is in simulated mode — messages are logged but not actually sent.</span>
            <Button asChild variant="outline" size="sm" className="shrink-0">
              <Link href={isTenantScoped ? `/tenants/${tenantId}?tab=settings` : '/settings#sms'}>
                Go live in Configuration
              </Link>
            </Button>
          </div>
        )}
        <div className="flex justify-between items-center">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <MessageSquare className="w-5 h-5 text-primary" /> Conversations
          </h2>
          <SendSmsDialog />
        </div>
        <SmsConversations />
        <h2 className="text-xl font-semibold">SMS Broadcast History</h2>
        <MessageLogList />
      </div>
        </>
      )}
    </div>
  );
}

/**
 * Read-only view of the receptionist's service vocabulary — the structured
 * Service Menu (with the legacy comma-separated setting as fallback for
 * scopes not yet backfilled). Editing happens on the Services tab of
 * Business Bookings; this card just shows what the receptionist recognizes.
 *
 * Works with any known tenant scope: when a tenant id is available (from the
 * ?tenant= URL param or from route/props, e.g. the Tenant Detail embed) the
 * catalog is fetched with an explicit x-tenant-id header, so the list is
 * correct even off the /sos pages where the automatic header getter would
 * fall back to the legacy scope.
 */
function ServiceVocabularyCard({
  tenantId,
  legacyServiceNames,
}: {
  tenantId: number | null;
  legacyServiceNames: string | null | undefined;
}) {
  const { data: catalog, isLoading } = useListSosServices({
    // Include the tenant in the query key so caches never mix scopes, and
    // pass the header explicitly — explicit headers win over the URL-derived
    // getter, which only knows about ?tenant= on /sos pages.
    query: { queryKey: [...getListSosServicesQueryKey(), { tenantId }] },
    request:
      tenantId != null ? { headers: { 'x-tenant-id': String(tenantId) } } : undefined,
  });
  const activeNames = (catalog ?? []).filter((s) => s.isActive).map((s) => s.name);
  const legacyNames = (legacyServiceNames ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const usingLegacy = catalog != null && catalog.length === 0;
  const names = usingLegacy ? legacyNames : activeNames;
  const servicesUrl = tenantId != null ? `/sos/bookings?tab=services&tenant=${tenantId}` : '/sos/bookings?tab=services';

  return (
    <div className="p-4 border rounded-lg space-y-2" data-testid="card-service-vocabulary">
      <div className="flex items-center justify-between gap-3">
        <Label className="text-base">Services the receptionist recognizes</Label>
        <Button asChild variant="outline" size="sm" data-testid="link-manage-service-menu">
          <Link href={servicesUrl}>Manage Service Menu</Link>
        </Button>
      </div>
      {isLoading ? (
        <div className="flex flex-wrap gap-1.5" data-testid="skeleton-service-vocabulary">
          <Skeleton className="h-6 w-20 rounded-full" />
          <Skeleton className="h-6 w-24 rounded-full" />
          <Skeleton className="h-6 w-16 rounded-full" />
        </div>
      ) : names.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="text-no-services">
          No services configured yet — add them to the Service Menu so callers can book by name.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5" data-testid="list-recognized-services">
            {names.map((name) => (
              <Badge key={name} variant="outline">{name}</Badge>
            ))}
          </div>
          {usingLegacy && (
            <p className="text-xs text-muted-foreground">
              Shown from the legacy service-names setting — add these to the Service Menu to set
              prices and durations.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function CallLogList() {
  const { data: calls } = useListSosCalls();

  return (
    <div className="space-y-3">
      {calls?.map(call => (
        <Card key={call.id} className="shadow-sm">
          <CardContent className="p-4 flex gap-4">
            <div className="w-12 h-12 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <Phone className="h-5 w-5" />
            </div>
            <div className="flex-1 space-y-1">
              <div className="flex justify-between">
                <span className="font-semibold">{call.callerName || call.fromNumber}</span>
                <Badge variant={call.outcome === 'booked' ? 'default' : 'secondary'} className="capitalize">
                  {call.outcome.replace('_', ' ')}
                </Badge>
              </div>
              <div className="text-sm font-medium">Intent: {call.intent}</div>
              {call.transcriptSummary && (
                <div className="text-sm text-muted-foreground bg-muted p-2 rounded mt-2">
                  <span className="font-semibold text-foreground/70">Summary: </span>
                  {call.transcriptSummary}
                </div>
              )}
              <div className="text-xs text-muted-foreground mt-2">
                {new Date(call.createdAt).toLocaleString()}
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
      {calls?.length === 0 && <div className="text-center py-12 text-muted-foreground">No calls logged.</div>}
    </div>
  );
}

function SimulateCallDialog() {
  const [open, setOpen] = useState(false);
  const [fromNumber, setFrom] = useState("+15550001111");
  const [callerName, setName] = useState("Jane Doe");
  const [inquiry, setInquiry] = useState("I'd like to book an appointment for tomorrow at 2pm.");
  const [result, setResult] = useState<any>(null);

  const simulate = useSimulateSosCall();
  const queryClient = useQueryClient();

  const handleRun = () => {
    simulate.mutate(
      { data: { fromNumber, callerName, inquiry } },
      {
        onSuccess: (res) => {
          queryClient.invalidateQueries({ queryKey: getListSosCallsQueryKey() });
          setResult(res);
        }
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if(!o) setResult(null); }}>
      <DialogTrigger asChild>
        <Button variant="outline"><Play className="w-4 h-4 mr-2"/> Simulate Inbound Call</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Simulate AI Call</DialogTitle>
          <DialogDescription>Test how the AI Receptionist handles specific inquiries.</DialogDescription>
        </DialogHeader>
        {!result ? (
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Caller Name</Label>
                <Input value={callerName} onChange={e => setName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Phone Number</Label>
                <Input value={fromNumber} onChange={e => setFrom(e.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Spoken Inquiry</Label>
              <Textarea rows={3} value={inquiry} onChange={e => setInquiry(e.target.value)} />
            </div>
            <Button className="w-full" onClick={handleRun} disabled={simulate.isPending}>
              {simulate.isPending ? 'Simulating...' : 'Run Simulation'}
            </Button>
          </div>
        ) : (
          <div className="space-y-4 py-4">
            <div className="bg-primary/5 border border-primary/20 p-4 rounded-lg space-y-3">
              <div className="flex justify-between items-center">
                <span className="font-semibold text-primary">Simulation Complete</span>
                <Badge>{result.outcome.replace('_', ' ')}</Badge>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Detected Intent</Label>
                <div className="text-sm font-medium">{result.intent}</div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">AI Transcript Summary</Label>
                <div className="text-sm italic text-foreground/80">{result.transcriptSummary}</div>
              </div>
            </div>
            <Button className="w-full" onClick={() => setOpen(false)}>Done</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MessageLogList() {
  // Poll while any outbound message is still awaiting a final delivery
  // status (Twilio confirms via status callback), so "sent" flips to
  // "delivered"/"failed" without a page reload.
  const { data: messages } = useListSosMessages(
    { limit: 50 },
    {
      query: {
        queryKey: getListSosMessagesQueryKey({ limit: 50 }),
        refetchInterval: (query) => {
          const rows = query.state.data;
          const hasNonFinal = rows?.some(
            (m) =>
              m.direction === 'outbound' &&
              (m.deliveryStatus === 'pending' || m.deliveryStatus === 'sent'),
          );
          return hasNonFinal ? 5000 : false;
        },
      },
    },
  );

  const items: MessageHistoryItem[] | undefined = messages?.map((msg) => ({
    id: msg.id,
    createdAt: msg.createdAt,
    contact: msg.customerName || msg.toNumber || null,
    body: msg.body,
    kind: msg.kind,
    status: msg.deliveryStatus,
    direction: msg.direction as 'inbound' | 'outbound',
    errorMessage: msg.errorMessage,
    errorCode: msg.errorCode,
  }));

  return <MessageHistoryTable items={items} showDirection testId="table-sms-history" />;
}

function SendSmsDialog() {
  const [open, setOpen] = useState(false);
  const [customer, setCustomer] = useState<SosCustomer | null>(null);
  const [body, setBody] = useState("");

  const send = useSendSosMessage();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleSend = () => {
    if (!customer) return;
    send.mutate(
      { data: { customerId: customer.id, body, kind: 'manual' } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSosMessagesQueryKey() });
          setOpen(false);
          toast({ title: 'Message queued for delivery' });
        }
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button><Send className="w-4 h-4 mr-2"/> Send Manual SMS</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send SMS Message</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>Customer</Label>
            <CustomerPicker value={customer} onChange={setCustomer} />
          </div>
          <div className="space-y-2">
            <Label>Message Content</Label>
            <Textarea rows={4} value={body} onChange={e => setBody(e.target.value)} placeholder="Type message..." />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSend} disabled={!body || !customer}>Send Message</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
