import React, { useEffect, useRef } from 'react';
import {
  useGetSosSettings,
  useUpdateSosSettings,
  getGetSosSettingsQueryKey,
  useGetTenantSettings,
  useUpdateTenantSettings,
  getGetTenantSettingsQueryKey,
  useGetTenant,
  getGetTenantQueryKey,
  type SosSettings,
  type SosSettingsUpdate,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'wouter';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Activity, ArrowLeft, Bot, Building2, ExternalLink, MessageSquare, ShieldCheck } from 'lucide-react';

/**
 * Unified configuration screen.
 *
 * Consolidates the business profile and every module's options (SOS
 * operations, AI receptionist, SMS delivery) into one place. Each section
 * saves independently via a partial PATCH, so saving one section never
 * clobbers unsaved edits in another.
 *
 * Rendered in two contexts:
 *  - `/settings` — the legacy/global configuration record
 *  - `/tenants/:id/settings` — that tenant's own settings record
 */
export default function Settings() {
  const params = useParams<{ id?: string }>();
  const tenantId = params.id != null ? Number(params.id) : null;
  const isTenantScoped = tenantId != null && Number.isInteger(tenantId);

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

  const settings: SosSettings | undefined = isTenantScoped
    ? tenantQuery.data
    : globalQuery.data;
  const isLoading = isTenantScoped ? tenantQuery.isLoading : globalQuery.isLoading;
  const loadError = isTenantScoped ? tenantQuery.error : globalQuery.error;

  const updateGlobal = useUpdateSosSettings();
  const updateTenant = useUpdateTenantSettings();
  const isPending = updateGlobal.isPending || updateTenant.isPending;

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [profile, setProfile] = React.useState({
    businessName: '',
    industryType: '',
    resourceLabel: '',
  });
  const [aiReceptionistEnabled, setAiReceptionistEnabled] = React.useState(false);
  const [serviceNames, setServiceNames] = React.useState('');
  const [waitlistAutoFillEnabled, setWaitlistAutoFillEnabled] = React.useState(false);
  const [smsFromNumber, setSmsFromNumber] = React.useState('');
  const [noShowShieldEnabled, setNoShowShieldEnabled] = React.useState(false);
  const [noShowDepositAmount, setNoShowDepositAmount] = React.useState('25');
  const [noShowCancellationWindowHours, setNoShowCancellationWindowHours] = React.useState('24');
  const [noShowFee, setNoShowFee] = React.useState('25');

  const initialized = useRef(false);

  // Re-initialize local form state when switching between settings records.
  useEffect(() => {
    initialized.current = false;
  }, [tenantId]);

  useEffect(() => {
    if (settings && !initialized.current) {
      setProfile({
        businessName: settings.businessName,
        industryType: settings.industryType,
        resourceLabel: settings.resourceLabel,
      });
      setAiReceptionistEnabled(settings.aiReceptionistEnabled);
      setServiceNames(settings.serviceNames || '');
      setWaitlistAutoFillEnabled(settings.waitlistAutoFillEnabled);
      setSmsFromNumber(settings.smsFromNumber || '');
      setNoShowShieldEnabled(settings.noShowShieldEnabled);
      setNoShowDepositAmount(String(settings.noShowDepositAmount));
      setNoShowCancellationWindowHours(String(settings.noShowCancellationWindowHours));
      setNoShowFee(String(settings.noShowFee));
      initialized.current = true;
    }
  }, [settings]);

  const [, navigate] = useLocation();

  // Scroll to the section referenced by the URL hash (e.g. /settings#sms)
  // once data has loaded and the sections exist in the DOM. The global AI
  // Receptionist section moved to the unified AI Receptionist view, so old
  // /settings#ai-receptionist deep links redirect there instead.
  useEffect(() => {
    if (isLoading) return;
    const hash = window.location.hash.replace('#', '');
    if (!hash) return;
    if (hash === 'ai-receptionist' && !isTenantScoped) {
      navigate('/sos/ai-receptionist', { replace: true });
      return;
    }
    const el = document.getElementById(hash);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [isLoading, isTenantScoped, navigate]);

  const saveSection = (
    sectionLabel: string,
    data: Partial<{
      businessName: string;
      industryType: string;
      resourceLabel: string;
      serviceNames: string;
      aiReceptionistEnabled: boolean;
      waitlistAutoFillEnabled: boolean;
      smsFromNumber: string;
      noShowShieldEnabled: boolean;
      noShowDepositAmount: number;
      noShowCancellationWindowHours: number;
      noShowFee: number;
    }>,
  ) => {
    const onSuccess = () => {
      queryClient.invalidateQueries({
        queryKey:
          tenantId == null
            ? getGetSosSettingsQueryKey()
            : getGetTenantSettingsQueryKey(tenantId),
      });
      toast({ title: `${sectionLabel} saved` });
    };
    const onError = () => {
      toast({
        title: `Couldn't save ${sectionLabel.toLowerCase()}`,
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

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-[280px] w-full rounded-xl" />
        <Skeleton className="h-[280px] w-full rounded-xl" />
      </div>
    );
  }

  if (isTenantScoped && (loadError || !settings)) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight">Tenant not found</h1>
        <p className="text-muted-foreground">
          This tenant does not exist or is no longer available.
        </p>
        <Button asChild variant="outline">
          <Link href="/tenants">Back to Tenant Operations</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6" data-testid="page-settings">
      {isTenantScoped && (
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
        <h1 className="text-3xl font-bold tracking-tight">Configuration</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {isTenantScoped ? (
            <>
              Settings for{' '}
              <span className="font-medium" data-testid="text-settings-tenant">
                {tenant?.brandName ?? `tenant #${tenantId}`}
              </span>{' '}
              only — changes here never affect other businesses.
            </>
          ) : (
            'One place to configure your business profile, modules, and integrations.'
          )}
        </p>
      </div>

      {/* ── Business profile ─────────────────────────────────────────── */}
      <Card id="profile" className="scroll-mt-6" data-testid="section-profile">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="w-5 h-5 text-primary" /> Business Profile
          </CardTitle>
          <CardDescription>General information about your location.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label>Business Name</Label>
            <Input
              value={profile.businessName}
              onChange={(e) => setProfile((f) => ({ ...f, businessName: e.target.value }))}
              data-testid="input-business-name"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>Industry Type</Label>
              <Input
                value={profile.industryType}
                onChange={(e) => setProfile((f) => ({ ...f, industryType: e.target.value }))}
                placeholder="e.g. Clinic, Restaurant, Auto Shop"
                data-testid="input-industry-type"
              />
            </div>
            <div className="grid gap-2">
              <Label>Resource Label</Label>
              <Input
                value={profile.resourceLabel}
                onChange={(e) => setProfile((f) => ({ ...f, resourceLabel: e.target.value }))}
                placeholder="e.g. Station, Table, Room"
                data-testid="input-resource-label"
              />
            </div>
          </div>
          <div className="flex justify-end pt-2">
            <Button
              onClick={() => saveSection('Business profile', profile)}
              disabled={isPending}
              data-testid="button-save-profile"
            >
              Save Profile
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── AI Receptionist module ───────────────────────────────────────
          Global setup moved to the unified AI Receptionist view; this card
          only remains for tenant-scoped settings, which that view doesn't
          cover. */}
      {isTenantScoped ? (
      <Card id="ai-receptionist" className="scroll-mt-6" data-testid="section-ai-receptionist">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2">
              <Bot className="w-5 h-5 text-primary" /> AI Receptionist
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
          <div className="grid gap-2">
            <Label>Service Names</Label>
            <Input
              value={serviceNames}
              onChange={(e) => setServiceNames(e.target.value)}
              placeholder="e.g. haircut, color, blowout"
              data-testid="input-service-names"
            />
            <p className="text-sm text-muted-foreground">
              Comma-separated list of your services. The receptionist uses these to
              recognize what callers are asking for.
            </p>
          </div>
          <div className="flex justify-between items-center gap-3">
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="text-muted-foreground -ml-2"
              data-testid="link-ai-call-logs"
            >
              <Link href="/sos/ai-receptionist">
                <ExternalLink className="w-4 h-4 mr-2" /> View AI call logs
              </Link>
            </Button>
            <Button
              onClick={() => saveSection('AI Receptionist', { aiReceptionistEnabled, serviceNames })}
              disabled={isPending}
              data-testid="button-save-ai-receptionist"
            >
              Save AI Receptionist
            </Button>
          </div>
        </CardContent>
      </Card>
      ) : null}

      {/* ── SOS Operations module ────────────────────────────────────── */}
      <Card id="sos-operations" className="scroll-mt-6" data-testid="section-sos-operations">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2">
              <Activity className="w-5 h-5 text-primary" /> SOS Operations
            </CardTitle>
            <Badge
              variant={settings?.waitlistAutoFillEnabled ? 'default' : 'secondary'}
              data-testid="badge-waitlist-autofill"
            >
              {settings?.waitlistAutoFillEnabled ? 'Auto-fill On' : 'Auto-fill Off'}
            </Badge>
          </div>
          <CardDescription>Waitlist and scheduling automation options.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between p-4 border rounded-lg">
            <div className="space-y-0.5">
              <Label className="text-base">Smart Waitlist Auto-fill</Label>
              <p className="text-sm text-muted-foreground">
                Automatically text the waitlist when a booked appointment cancels.
              </p>
            </div>
            <Switch
              checked={waitlistAutoFillEnabled}
              onCheckedChange={setWaitlistAutoFillEnabled}
              data-testid="switch-waitlist-autofill"
            />
          </div>
          <div className="flex justify-end">
            <Button
              onClick={() => saveSection('SOS Operations', { waitlistAutoFillEnabled })}
              disabled={isPending}
              data-testid="button-save-sos-operations"
            >
              Save SOS Operations
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── No-Show Shield & Deposits ───────────────────────────────── */}
      <Card id="no-show-shield" className="scroll-mt-6" data-testid="section-no-show-shield">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-primary" /> No-Show Shield & Deposits
            </CardTitle>
            <Badge
              variant={settings?.noShowShieldEnabled && settings?.noShowShieldProvisioned ? 'default' : 'secondary'}
              data-testid="badge-no-show-shield"
            >
              {settings?.noShowShieldEnabled && settings?.noShowShieldProvisioned
                ? 'Active'
                : settings?.noShowShieldEnabled
                  ? 'Enabled — awaiting provisioning'
                  : 'Off'}
            </Badge>
          </div>
          <CardDescription>
            Card-on-file deposit holds that release on timely cancellations and capture a fee on
            late cancellations or no-shows.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!settings?.noShowShieldProvisioned && (
            <div className="p-3 border rounded-lg bg-muted/40 text-sm text-muted-foreground" data-testid="text-no-show-shield-not-provisioned">
              The No-Show Shield & Deposits module isn't provisioned yet. You can configure the
              policy now, but it won't enforce on bookings until the module is provisioned.
            </div>
          )}
          <div className="flex items-center justify-between p-4 border rounded-lg">
            <div className="space-y-0.5">
              <Label className="text-base">Enforce deposit policy</Label>
              <p className="text-sm text-muted-foreground">
                Every new booking records a policy agreement and places a deposit hold automatically.
              </p>
            </div>
            <Switch
              checked={noShowShieldEnabled}
              onCheckedChange={setNoShowShieldEnabled}
              data-testid="switch-no-show-shield"
            />
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div className="grid gap-2">
              <Label>Deposit amount ($)</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={noShowDepositAmount}
                onChange={(e) => setNoShowDepositAmount(e.target.value)}
                data-testid="input-no-show-deposit"
              />
            </div>
            <div className="grid gap-2">
              <Label>Cancellation window (hours)</Label>
              <Input
                type="number"
                min="0"
                step="1"
                value={noShowCancellationWindowHours}
                onChange={(e) => setNoShowCancellationWindowHours(e.target.value)}
                data-testid="input-no-show-window"
              />
            </div>
            <div className="grid gap-2">
              <Label>No-show / late-cancel fee ($)</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={noShowFee}
                onChange={(e) => setNoShowFee(e.target.value)}
                data-testid="input-no-show-fee"
              />
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            Cancelling at least the window's hours before the start time releases the hold in
            full; cancelling later — or missing the appointment — captures the fee from the held
            deposit. Terms are locked in at booking time.
          </p>
          <div className="flex justify-end">
            <Button
              onClick={() =>
                saveSection('No-Show Shield', {
                  noShowShieldEnabled,
                  noShowDepositAmount: Math.max(0, parseFloat(noShowDepositAmount) || 0),
                  noShowCancellationWindowHours: Math.max(0, Math.round(parseFloat(noShowCancellationWindowHours) || 0)),
                  noShowFee: Math.max(0, parseFloat(noShowFee) || 0),
                })
              }
              disabled={isPending}
              data-testid="button-save-no-show-shield"
            >
              Save No-Show Shield
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── SMS & Messaging ──────────────────────────────────────────── */}
      <Card id="sms" className="scroll-mt-6" data-testid="section-sms">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="w-5 h-5 text-primary" /> SMS & Messaging
            </CardTitle>
            <Badge variant={settings?.smsMode === 'live' ? 'default' : 'secondary'} data-testid="badge-sms-mode">
              {settings?.smsMode === 'live' ? 'Live' : 'Simulated'}
            </Badge>
          </div>
          <CardDescription>Outbound text delivery and inbound reply-to-claim.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="p-4 border rounded-lg">
            <Label className="text-base">SMS Delivery</Label>
            <p className="text-sm text-muted-foreground mt-0.5">
              {settings?.smsMode === 'live' ? (
                <>
                  Real texts are being sent via Twilio from{' '}
                  <span className="font-medium">{settings?.smsActiveFromNumber}</span>.
                </>
              ) : (
                'Simulated mode — messages are logged but not actually sent. Connect Twilio and set a From number to go live.'
              )}
            </p>
          </div>

          <div className="p-4 border rounded-lg space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-base">Inbound SMS (reply-to-claim)</Label>
              <Badge variant={settings?.smsInboundReady ? 'default' : 'secondary'} data-testid="badge-inbound-sms">
                {settings?.smsInboundReady ? 'Ready' : 'Not configured'}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Customers can reply YES to claim an open slot, and STOP/START to manage texts. In your
              Twilio console, set your number's "A message comes in" webhook to this URL (HTTP POST):
            </p>
            {settings?.smsInboundWebhookUrl ? (
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={settings.smsInboundWebhookUrl}
                  className="font-mono text-xs"
                  data-testid="input-inbound-webhook-url"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    navigator.clipboard.writeText(settings.smsInboundWebhookUrl!);
                    toast({ title: 'Webhook URL copied' });
                  }}
                >
                  Copy
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No public URL available for this environment yet.</p>
            )}
            {!settings?.smsInboundReady && (
              <p className="text-xs text-muted-foreground">
                Connect Twilio (auth token) so inbound webhook requests can be verified.
              </p>
            )}
          </div>

          <div className="grid gap-2">
            <Label>Outbound SMS Number</Label>
            <Input
              value={smsFromNumber}
              onChange={(e) => setSmsFromNumber(e.target.value)}
              placeholder="+1 (555) 000-0000"
              data-testid="input-sms-from-number"
            />
            <p className="text-xs text-muted-foreground">
              This number is used for all outgoing AI and waitlist texts.
            </p>
          </div>
          <div className="flex justify-between items-center gap-3">
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="text-muted-foreground -ml-2"
              data-testid="link-sms-history"
            >
              <Link href="/sos/ai-receptionist">
                <ExternalLink className="w-4 h-4 mr-2" /> View SMS broadcast history
              </Link>
            </Button>
            <Button
              onClick={() => saveSection('SMS settings', { smsFromNumber })}
              disabled={isPending}
              data-testid="button-save-sms"
            >
              Save SMS Settings
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
