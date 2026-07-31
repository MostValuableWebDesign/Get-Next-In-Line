import React, { useEffect, useRef, useState } from 'react';
import {
  useGetSosSettings,
  useUpdateSosSettings,
  getGetSosSettingsQueryKey,
  useGetSosTwilioWebhookStatus,
  getGetSosTwilioWebhookStatusQueryKey,
  useConfigureSosTwilioWebhook,
  useSendSosTestSms,
  type SosTestSmsResult,
  useGetTenantSettings,
  useUpdateTenantSettings,
  getGetTenantSettingsQueryKey,
  useGetTenant,
  getGetTenantQueryKey,
  useGetCoopTaxonomy,
  getGetCoopTaxonomyQueryKey,
  useListTenantReviews,
  useCreateTenantReview,
  useUpdateTenantReview,
  useDeleteTenantReview,
  getListTenantReviewsQueryKey,
  type SosSettings,
  type SosSettingsUpdate,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'wouter';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Activity, ArrowLeft, Bot, Building2, ExternalLink, MapPin, MessageSquare, Search, ShieldCheck, Star, Trash2 } from 'lucide-react';
import { ConnectorRegistrySection } from '@/pages/ConnectorRegistry';
import { TenantCoopPartnershipsSection } from '@/pages/CoopPartnerships';

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
export default function Settings({ embedded = false }: { embedded?: boolean }) {
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

  // Live Twilio console check: is the number's "A message comes in" webhook
  // actually pointed at this app? Scoped like the settings record itself.
  const webhookScope = isTenantScoped ? String(tenantId) : 'legacy';
  const webhookQuery = useGetSosTwilioWebhookStatus({
    query: {
      queryKey: [...getGetSosTwilioWebhookStatusQueryKey(), { scope: webhookScope }],
    },
    request: { headers: { 'x-tenant-id': webhookScope } },
  });
  const webhook = webhookQuery.data;
  const configureWebhook = useConfigureSosTwilioWebhook({
    request: { headers: { 'x-tenant-id': webhookScope } },
  });
  // Track which webhook a pending fix targets so only that button spins.
  const [fixingTarget, setFixingTarget] = useState<'sms' | 'voice' | null>(null);
  const runWebhookFix = (target: 'sms' | 'voice') => {
    setFixingTarget(target);
    configureWebhook.mutate(
      { data: { target } },
      {
        onSuccess: (result) => {
          // Push the fresh post-fix check into the cache so the status
          // indicator updates immediately, then refetch to stay honest with
          // the server.
          queryClient.setQueryData(
            [...getGetSosTwilioWebhookStatusQueryKey(), { scope: webhookScope }],
            result.check,
          );
          queryClient.invalidateQueries({
            queryKey: getGetSosTwilioWebhookStatusQueryKey(),
          });
          if (result.fixed) {
            toast({
              title: 'Webhook configured',
              description:
                target === 'voice'
                  ? 'Twilio now routes incoming calls to this app.'
                  : 'Twilio now points at this app.',
            });
          } else {
            toast({
              title: "Couldn't fix the webhook",
              description: result.errorMessage ?? 'Twilio rejected the update.',
              variant: 'destructive',
            });
          }
        },
        onError: (err) => {
          toast({
            title: "Couldn't fix the webhook",
            description: err instanceof Error ? err.message : 'Request failed.',
            variant: 'destructive',
          });
        },
        onSettled: () => setFixingTarget(null),
      },
    );
  };

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
  const [waitlistAutoFillEnabled, setWaitlistAutoFillEnabled] = React.useState(false);
  const [openTime, setOpenTime] = React.useState('09:00');
  const [closeTime, setCloseTime] = React.useState('17:00');
  const [smsFromNumber, setSmsFromNumber] = React.useState('');
  const [testSmsRecipient, setTestSmsRecipient] = React.useState('');
  const [testSmsResult, setTestSmsResult] = React.useState<SosTestSmsResult | null>(null);
  const testSms = useSendSosTestSms({
    request: { headers: { 'x-tenant-id': isTenantScoped ? String(tenantId) : 'legacy' } },
  });
  const [noShowShieldEnabled, setNoShowShieldEnabled] = React.useState(false);
  const [noShowDepositAmount, setNoShowDepositAmount] = React.useState('25');
  const [noShowCancellationWindowHours, setNoShowCancellationWindowHours] = React.useState('24');
  const [noShowFee, setNoShowFee] = React.useState('25');
  const [seo, setSeo] = React.useState({
    seoDescription: '',
    publicPhone: '',
    streetAddress: '',
    addressLocality: '',
    addressRegion: '',
    postalCode: '',
    latitude: '',
    longitude: '',
    businessCategory: '',
  });
  const [coop, setCoop] = React.useState({
    coopSubCategory: '',
    coopRadiusMiles: 4,
  });
  const [coopMargin, setCoopMargin] = useState('');
  const [coopWindow, setCoopWindow] = useState('30');
  const [branding, setBranding] = React.useState({
    brandLogoUrl: '',
    brandPrimaryColor: '#1e3a5f',
    brandSecondaryColor: '#f4a259',
  });

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
      setWaitlistAutoFillEnabled(settings.waitlistAutoFillEnabled);
      setOpenTime(settings.openTime);
      setCloseTime(settings.closeTime);
      setSmsFromNumber(settings.smsFromNumber || '');
      setTestSmsRecipient((prev) => prev || settings.smsTestRecipient || '');
      setNoShowShieldEnabled(settings.noShowShieldEnabled);
      setNoShowDepositAmount(String(settings.noShowDepositAmount));
      setNoShowCancellationWindowHours(String(settings.noShowCancellationWindowHours));
      setNoShowFee(String(settings.noShowFee));
      setSeo({
        seoDescription: settings.seoDescription ?? '',
        publicPhone: settings.publicPhone ?? '',
        streetAddress: settings.streetAddress ?? '',
        addressLocality: settings.addressLocality ?? '',
        addressRegion: settings.addressRegion ?? '',
        postalCode: settings.postalCode ?? '',
        latitude: settings.latitude ?? '',
        longitude: settings.longitude ?? '',
        businessCategory: settings.businessCategory ?? '',
      });
      setCoop({
        coopSubCategory: settings.coopSubCategory ?? '',
        coopRadiusMiles: settings.coopRadiusMiles ?? 4,
      });
      setCoopMargin(
        settings.coopReciprocityMarginPercent == null ? '' : String(settings.coopReciprocityMarginPercent),
      );
      setCoopWindow(String(settings.coopReciprocityWindowDays ?? 30));
      setBranding({
        brandLogoUrl: settings.brandLogoUrl ?? '',
        brandPrimaryColor: settings.brandPrimaryColor || '#1e3a5f',
        brandSecondaryColor: settings.brandSecondaryColor || '#f4a259',
      });
      initialized.current = true;
    }
  }, [settings]);

  const [, navigate] = useLocation();

  // Scroll to the section referenced by the URL hash (e.g. /settings#sms)
  // once data has loaded and the sections exist in the DOM. The global AI
  // Receptionist section moved to the AI Receptionist tab in Business
  // Bookings, so old /settings#ai-receptionist deep links redirect there.
  useEffect(() => {
    if (isLoading) return;
    const hash = window.location.hash.replace('#', '');
    if (!hash) return;
    if (hash === 'ai-receptionist' && !isTenantScoped) {
      navigate('/sos/bookings?tab=ai-receptionist', { replace: true });
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
      openTime: string;
      closeTime: string;
      noShowShieldEnabled: boolean;
      noShowDepositAmount: number;
      noShowCancellationWindowHours: number;
      noShowFee: number;
      seoDescription: string;
      publicPhone: string;
      streetAddress: string;
      addressLocality: string;
      addressRegion: string;
      postalCode: string;
      latitude: string;
      longitude: string;
      businessCategory: string;
      coopSubCategory: string;
      coopRadiusMiles: number;
      coopRadiusOverrideMiles: number | null;
      coopReciprocityMarginPercent: number | null;
      coopReciprocityWindowDays: number;
      brandLogoUrl: string;
      brandPrimaryColor: string;
      brandSecondaryColor: string;
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
    const onError = (err: unknown) => {
      // Surface the server's specific rejection reason (e.g. an SMS From
      // number the Twilio account doesn't own) instead of a generic retry.
      const serverMessage = (err as { data?: { message?: string } | null })?.data?.message;
      toast({
        title: `Couldn't save ${sectionLabel.toLowerCase()}`,
        description: serverMessage || 'Please try again.',
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
    <div className={embedded ? "space-y-6" : "max-w-3xl mx-auto space-y-6"} data-testid="page-settings">
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
        <h1 className={embedded ? "text-xl font-semibold tracking-tight" : "text-3xl font-bold tracking-tight"}>Configuration</h1>
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
          AI Receptionist settings are edited only in the AI Receptionist
          console (global: Business Bookings → AI Receptionist tab;
          per-tenant: Tenant Detail → AI Receptionist tab). No duplicated
          status here — just a compact jump link so the two can't drift. */}
      <Card id="ai-receptionist" className="scroll-mt-6" data-testid="section-ai-receptionist-link">
        <CardContent className="p-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Bot className="w-5 h-5 text-primary shrink-0" />
            <div className="min-w-0">
              <div className="font-semibold">AI Receptionist</div>
              <p className="text-sm text-muted-foreground">
                Call handling, service names, call logs, and SMS broadcasts are managed in the AI
                Receptionist console.
              </p>
            </div>
          </div>
          <Button asChild variant="outline" className="shrink-0" data-testid="link-manage-ai-receptionist">
            <Link
              href={
                isTenantScoped
                  ? // Carry the tenant context into the SOS console so the
                    // call/SMS logs and banners there show this business only.
                    `/sos/bookings?tab=ai-receptionist&tenant=${tenantId}`
                  : '/sos/bookings?tab=ai-receptionist'
              }
            >
              <ExternalLink className="w-4 h-4 mr-2" /> Open Console
            </Link>
          </Button>
        </CardContent>
      </Card>

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

      {/* ── Online Booking (public page + embeddable widget) ────────── */}
      {isTenantScoped && (
        <OnlineBookingCard
          slug={tenant?.subdomain ?? null}
          openTime={openTime}
          closeTime={closeTime}
          setOpenTime={setOpenTime}
          setCloseTime={setCloseTime}
          onSave={() => saveSection('Online Booking', { openTime, closeTime })}
          isPending={isPending}
        />
      )}

      {/* ── Local SEO & Landing Page (tenant-scoped only) ───────────── */}
      {isTenantScoped && (
        <LocalSeoCard
          slug={tenant?.subdomain ?? null}
          seo={seo}
          setSeo={setSeo}
          onSave={() => saveSection('Local SEO profile', seo)}
          isPending={isPending}
        />
      )}

      {/* ── Marketing Branding (tenant-scoped only) ─────────────────── */}
      {isTenantScoped && (
        <BrandingCard
          branding={branding}
          setBranding={setBranding}
          onSave={() => saveSection('Marketing branding', branding)}
          isPending={isPending}
        />
      )}

      {/* ── Co-Op Network (tenant-scoped only) ──────────────────────── */}
      {isTenantScoped && (
        <CoopNetworkCard
          coop={coop}
          setCoop={setCoop}
          onSave={() => saveSection('Co-Op Network', coop)}
          isPending={isPending}
        />
      )}

      {/* ── Co-Op Search Radius (tenant-scoped only) ────────────────── */}
      {isTenantScoped && settings && (
        <CoopRadiusCard
          settings={settings}
          onSave={(overrideMiles) =>
            saveSection('Co-Op search radius', { coopRadiusOverrideMiles: overrideMiles })
          }
          isPending={isPending}
        />
      )}

      {/* ── Customer Reviews (tenant-scoped only) ───────────────────── */}
      {isTenantScoped && <ReviewsCard tenantId={tenantId!} />}

      {/* ── Merchant co-op partnerships (tenant-scoped only) ────────── */}
      {isTenantScoped && <TenantCoopPartnershipsSection tenantId={tenantId!} />}

      {/* ── Co-Op reciprocity threshold (tenant-scoped only) ────────── */}
      {isTenantScoped && (
        <Card id="coop-reciprocity" className="scroll-mt-6" data-testid="section-coop-reciprocity">
          <CardHeader>
            <CardTitle>Co-Op Reciprocity Threshold</CardTitle>
            <CardDescription>
              Flag lopsided partnerships in the Co-Op hub when the gap between traffic you send and
              receive exceeds this margin over the evaluation window. Leave the margin blank to turn
              flagging off.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="coop-margin">Disparity margin (%)</Label>
                <Input
                  id="coop-margin"
                  type="number"
                  min={1}
                  max={100}
                  placeholder="e.g. 50 — blank disables flagging"
                  value={coopMargin}
                  onChange={e => setCoopMargin(e.target.value)}
                  data-testid="input-coop-margin"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="coop-window">Evaluation window (days)</Label>
                <Input
                  id="coop-window"
                  type="number"
                  min={1}
                  max={365}
                  value={coopWindow}
                  onChange={e => setCoopWindow(e.target.value)}
                  data-testid="input-coop-window"
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button
                disabled={isPending}
                onClick={() =>
                  saveSection('Co-Op reciprocity', {
                    coopReciprocityMarginPercent:
                      coopMargin.trim() === '' ? null : Number(coopMargin),
                    coopReciprocityWindowDays: Number(coopWindow) || 30,
                  })
                }
                data-testid="button-save-coop-reciprocity"
              >
                Save Co-Op Reciprocity
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

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
                  <span className="font-medium" data-testid="text-active-from-number">
                    {settings?.smsActiveFromNumber}
                  </span>
                  {settings?.smsActiveFromNumberSource === 'settings'
                    ? ' (your saved override)'
                    : settings?.smsActiveFromNumberSource
                      ? ' (the connected Twilio number)'
                      : ''}
                  . The Twilio console check below verifies Twilio accepts this number.
                </>
              ) : (
                'Simulated mode — messages are logged but not actually sent. Connect Twilio and set a From number to go live.'
              )}
            </p>
            {settings?.smsMode === 'live' && settings?.smsDeliveryStatusMode && (
              <p className="text-sm text-muted-foreground mt-2" data-testid="text-delivery-status-mode">
                {settings.smsDeliveryStatusMode === 'polling'
                  ? 'Delivery tracking: this environment uses the Replit Twilio connector, which withholds the auth token, so Twilio delivery callbacks can\u2019t be signature-verified. Message statuses (delivered / failed) are confirmed directly with Twilio instead \u2014 they may take a minute or two to update in message history.'
                  : settings.smsDeliveryStatusMode === 'callbacks'
                    ? 'Delivery tracking: Twilio reports delivered / failed statuses via signed callbacks in near real time.'
                    : null}
              </p>
            )}
            {settings?.smsIgnoredFromNumber && (
              <p className="text-sm text-destructive mt-2" data-testid="text-ignored-from-number">
                The saved override {settings.smsIgnoredFromNumber} is a placeholder or invalid
                number and is being ignored. Clear or replace it below.
              </p>
            )}
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

            {/* Live Twilio console check — is the number actually pointed here? */}
            <div
              className="mt-2 pt-3 border-t space-y-1"
              data-testid="twilio-webhook-check"
            >
              <div className="flex items-center justify-between">
                <Label className="text-sm">Twilio console check</Label>
                <div className="flex items-center gap-2">
                  {!webhookQuery.isLoading && webhook?.status === 'misconfigured' && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={configureWebhook.isPending}
                      data-testid="button-fix-webhook"
                      onClick={() => runWebhookFix('sms')}
                    >
                      {configureWebhook.isPending && fixingTarget === 'sms' ? 'Fixing…' : 'Fix now'}
                    </Button>
                  )}
                  {webhookQuery.isLoading ? (
                    <Badge variant="secondary" data-testid="badge-webhook-check">
                      Checking…
                    </Badge>
                  ) : (
                    <Badge
                      variant={webhook?.status === 'configured' ? 'default' : 'secondary'}
                      data-testid="badge-webhook-check"
                    >
                      {webhook?.status === 'configured' ? 'Configured' : 'Not configured'}
                    </Badge>
                  )}
                </div>
              </div>
              {!webhookQuery.isLoading && (
                <p className="text-xs text-muted-foreground" data-testid="text-webhook-check-detail">
                  {webhook?.status === 'configured' ? (
                    <>
                      Twilio number <span className="font-medium">{webhook.phoneNumber}</span> is
                      pointed at this app's inbound webhook. Replies and reply-to-claim will
                      arrive here.
                    </>
                  ) : webhook?.status === 'misconfigured' ? (
                    <>
                      Twilio number <span className="font-medium">{webhook.phoneNumber}</span>{' '}
                      currently points at{' '}
                      <span className="font-mono break-all">
                        {webhook.configuredUrl ?? 'no URL'}
                      </span>
                      . Inbound texts will not reach this app — click Fix now to point the
                      number at this app automatically, or paste the URL above into the
                      number's "A message comes in" field in the Twilio console.
                    </>
                  ) : webhook?.status === 'number_not_found' ? (
                    <>
                      Number <span className="font-medium">{webhook.phoneNumber}</span> was not
                      found in the connected Twilio account, so its webhook can't be verified.
                    </>
                  ) : webhook?.status === 'no_number' ? (
                    'No SMS number is set, so there is no Twilio number to verify yet.'
                  ) : webhook?.status === 'no_credentials' ? (
                    'Twilio credentials are not connected, so the console configuration can\'t be verified.'
                  ) : webhook?.status === 'no_public_url' ? (
                    'This environment has no public URL yet, so there is nothing for Twilio to point at.'
                  ) : (
                    <>
                      Couldn't reach Twilio to verify the webhook
                      {webhook?.errorMessage ? `: ${webhook.errorMessage}` : '.'}
                    </>
                  )}
                </p>
              )}
            </div>

            {/* Same live check for the voice ("A call comes in") webhook — the
                AI receptionist's inbound call entry point. */}
            <div
              className="mt-2 pt-3 border-t space-y-1"
              data-testid="twilio-voice-webhook-check"
            >
              <div className="flex items-center justify-between">
                <Label className="text-sm">Voice webhook check (AI receptionist)</Label>
                <div className="flex items-center gap-2">
                  {!webhookQuery.isLoading && webhook?.voiceStatus === 'misconfigured' && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={configureWebhook.isPending}
                      data-testid="button-fix-voice-webhook"
                      onClick={() => runWebhookFix('voice')}
                    >
                      {configureWebhook.isPending && fixingTarget === 'voice' ? 'Fixing…' : 'Fix now'}
                    </Button>
                  )}
                  {webhookQuery.isLoading ? (
                    <Badge variant="secondary" data-testid="badge-voice-webhook-check">
                      Checking…
                    </Badge>
                  ) : (
                    <Badge
                      variant={webhook?.voiceStatus === 'configured' ? 'default' : 'secondary'}
                      data-testid="badge-voice-webhook-check"
                    >
                      {webhook?.voiceStatus === 'configured' ? 'Configured' : 'Not configured'}
                    </Badge>
                  )}
                </div>
              </div>
              {!webhookQuery.isLoading && (
                <p className="text-xs text-muted-foreground" data-testid="text-voice-webhook-check-detail">
                  {webhook?.voiceStatus === 'configured' ? (
                    <>
                      Twilio number <span className="font-medium">{webhook.phoneNumber}</span> routes
                      incoming calls to this app's AI receptionist.
                    </>
                  ) : webhook?.voiceStatus === 'misconfigured' ? (
                    <>
                      Twilio number <span className="font-medium">{webhook.phoneNumber}</span>'s "A
                      call comes in" webhook currently points at{' '}
                      <span className="font-mono break-all">
                        {webhook.configuredVoiceUrl ?? 'no URL'}
                      </span>
                      . Incoming calls will not reach the AI receptionist — click Fix now to point
                      the number at this app automatically, or set the number's "A call comes in"
                      field to{' '}
                      <span className="font-mono break-all">{webhook.expectedVoiceUrl}</span> in the
                      Twilio console.
                    </>
                  ) : webhook?.voiceStatus === 'number_not_found' ? (
                    <>
                      Number <span className="font-medium">{webhook.phoneNumber}</span> was not
                      found in the connected Twilio account, so its voice webhook can't be verified.
                    </>
                  ) : webhook?.voiceStatus === 'no_number' ? (
                    'No SMS number is set, so there is no Twilio number to verify yet.'
                  ) : webhook?.voiceStatus === 'no_credentials' ? (
                    'Twilio credentials are not connected, so the console configuration can\'t be verified.'
                  ) : webhook?.voiceStatus === 'no_public_url' ? (
                    'This environment has no public URL yet, so there is nothing for Twilio to point at.'
                  ) : (
                    <>
                      Couldn't reach Twilio to verify the voice webhook
                      {webhook?.errorMessage ? `: ${webhook.errorMessage}` : '.'}
                    </>
                  )}
                </p>
              )}
            </div>
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
              This number is used for all outgoing AI and waitlist texts. It must be a real number
              owned by your connected Twilio account — leave it blank to use the connected Twilio
              number automatically.
            </p>
          </div>
          <div className="p-4 border rounded-lg space-y-3" data-testid="section-test-sms">
            <div>
              <Label className="text-base">Send a Test Text</Label>
              <p className="text-sm text-muted-foreground mt-0.5">
                Verify the SMS pipeline end to end — currently{' '}
                <span className="font-medium">
                  {settings?.smsMode === 'live' ? 'Live (Twilio)' : 'Simulated'}
                </span>
                . The test send is recorded in message history.
              </p>
            </div>
            <div className="flex gap-2">
              <Input
                value={testSmsRecipient}
                onChange={(e) => setTestSmsRecipient(e.target.value)}
                placeholder={settings?.smsTestRecipient || '+1 (555) 000-0000'}
                className="max-w-xs"
                data-testid="input-test-sms-recipient"
              />
              <Button
                variant="secondary"
                disabled={testSms.isPending}
                onClick={() => {
                  setTestSmsResult(null);
                  testSms.mutate(
                    { data: { toNumber: testSmsRecipient || null } },
                    {
                      onSuccess: (result) => {
                        setTestSmsResult(result);
                        toast({
                          title:
                            result.message.deliveryStatus === 'failed'
                              ? 'Test text failed'
                              : result.smsMode === 'live'
                                ? 'Test text sent via Twilio'
                                : 'Test text simulated (no Twilio credentials)',
                          description:
                            result.message.errorMessage ??
                            `To ${result.message.toNumber}`,
                          variant:
                            result.message.deliveryStatus === 'failed'
                              ? 'destructive'
                              : undefined,
                        });
                      },
                      onError: () =>
                        toast({
                          title: "Couldn't send test text",
                          description: 'Please check the number and try again.',
                          variant: 'destructive',
                        }),
                    },
                  );
                }}
                data-testid="button-send-test-sms"
              >
                {testSms.isPending ? 'Sending…' : 'Send test text'}
              </Button>
            </div>
            {testSmsResult && (
              <div className="text-sm" data-testid="text-test-sms-result">
                <Badge
                  variant={
                    testSmsResult.message.deliveryStatus === 'failed'
                      ? 'destructive'
                      : testSmsResult.smsMode === 'live'
                        ? 'default'
                        : 'secondary'
                  }
                  data-testid="badge-test-sms-outcome"
                >
                  {testSmsResult.smsMode === 'live' ? 'Live' : 'Simulated'} ·{' '}
                  {testSmsResult.message.deliveryStatus}
                </Badge>{' '}
                <span className="text-muted-foreground">
                  to {testSmsResult.message.toNumber}
                  {testSmsResult.message.providerSid
                    ? ` — Twilio SID ${testSmsResult.message.providerSid}`
                    : ''}
                  {testSmsResult.message.errorMessage
                    ? ` — ${testSmsResult.message.errorCode ?? 'error'}: ${testSmsResult.message.errorMessage}`
                    : ''}
                </span>
              </div>
            )}
          </div>

          <div className="flex justify-between items-center gap-3">
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="text-muted-foreground -ml-2"
              data-testid="link-sms-history"
            >
              <Link href="/sos/bookings?tab=ai-receptionist">
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

      {/* ── Connector Registry (admin-only, global config only) ─────────
          Folded in from the former standalone /connectors page; deep links
          land here via /settings#connectors. */}
      {!isTenantScoped && (
        <div id="connectors" className="scroll-mt-6 pt-4" data-testid="section-connectors">
          <ConnectorRegistrySection />
        </div>
      )}
    </div>
  );
}

type SeoProfile = {
  seoDescription: string;
  publicPhone: string;
  streetAddress: string;
  addressLocality: string;
  addressRegion: string;
  postalCode: string;
  latitude: string;
  longitude: string;
  businessCategory: string;
};

/**
 * Local SEO & Landing Page section (tenant-scoped only): the business profile
 * fields that feed the public landing page's metadata and Schema.org
 * LocalBusiness JSON-LD, plus a link to view the live landing page.
 */
function LocalSeoCard({
  slug, seo, setSeo, onSave, isPending,
}: {
  slug: string | null;
  seo: SeoProfile;
  setSeo: React.Dispatch<React.SetStateAction<SeoProfile>>;
  onSave: () => void;
  isPending: boolean;
}) {
  const landingUrl = slug ? `${window.location.origin}/api/public/landing/${slug}` : null;
  const set = (key: keyof SeoProfile) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setSeo((s) => ({ ...s, [key]: e.target.value }));

  return (
    <Card id="local-seo" className="scroll-mt-6" data-testid="section-local-seo">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Search className="w-5 h-5 text-primary" /> Local SEO & Landing Page
        </CardTitle>
        <CardDescription>
          A public, search-engine-friendly page with your address, hours, services, and reviews —
          built to rank in local search and the map pack.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2">
          <Label>Business description</Label>
          <textarea
            value={seo.seoDescription}
            onChange={set('seoDescription')}
            rows={3}
            placeholder="Tell customers (and search engines) what makes your business great."
            className="rounded-md border bg-background p-2 text-sm"
            data-testid="input-seo-description"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="grid gap-2">
            <Label>Public phone</Label>
            <Input value={seo.publicPhone} onChange={set('publicPhone')} placeholder="+1 (555) 000-0000" data-testid="input-seo-phone" />
          </div>
          <div className="grid gap-2">
            <Label>Business category</Label>
            <Input value={seo.businessCategory} onChange={set('businessCategory')} placeholder="e.g. HairSalon, AutoRepair, Dentist" data-testid="input-seo-category" />
          </div>
        </div>
        <div className="grid gap-2">
          <Label>Street address</Label>
          <Input value={seo.streetAddress} onChange={set('streetAddress')} placeholder="123 Main St" data-testid="input-seo-street" />
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div className="grid gap-2">
            <Label>City</Label>
            <Input value={seo.addressLocality} onChange={set('addressLocality')} data-testid="input-seo-city" />
          </div>
          <div className="grid gap-2">
            <Label>State / region</Label>
            <Input value={seo.addressRegion} onChange={set('addressRegion')} data-testid="input-seo-region" />
          </div>
          <div className="grid gap-2">
            <Label>Postal code</Label>
            <Input value={seo.postalCode} onChange={set('postalCode')} data-testid="input-seo-postal" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="grid gap-2">
            <Label>Latitude</Label>
            <Input value={seo.latitude} onChange={set('latitude')} placeholder="e.g. 40.7128" data-testid="input-seo-lat" />
          </div>
          <div className="grid gap-2">
            <Label>Longitude</Label>
            <Input value={seo.longitude} onChange={set('longitude')} placeholder="e.g. -74.0060" data-testid="input-seo-lng" />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Coordinates power the map-pack "geo" markup. Leave blank to omit them.
        </p>
        <div className="flex justify-between items-center gap-3">
          {landingUrl ? (
            <Button asChild variant="ghost" size="sm" className="text-muted-foreground -ml-2" data-testid="link-view-landing-page">
              <a href={landingUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="w-4 h-4 mr-2" /> View landing page
              </a>
            </Button>
          ) : <span />}
          <Button onClick={onSave} disabled={isPending} data-testid="button-save-local-seo">
            Save SEO Profile
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

const DENSITY_LABELS: Record<string, string> = {
  dense_urban: 'Dense Urban',
  suburban: 'Suburban',
  rural: 'Rural',
};

/**
 * Co-Op Search Radius section (tenant-scoped only). Shows the auto-detected
 * density classification and radius, with a slider override the merchant can
 * set (persists, never clobbered by re-detection) or revert to automatic.
 */
function CoopRadiusCard({
  settings, onSave, isPending,
}: {
  settings: SosSettings;
  onSave: (overrideMiles: number | null) => void;
  isPending: boolean;
}) {
  const hasOverride = settings.coopRadiusOverrideMiles != null;
  const [sliderMiles, setSliderMiles] = React.useState<number>(settings.coopRadiusEffectiveMiles);
  React.useEffect(() => {
    setSliderMiles(settings.coopRadiusEffectiveMiles);
  }, [settings.coopRadiusEffectiveMiles]);

  const densityLabel = DENSITY_LABELS[settings.densityClassification] ?? 'Suburban';
  const dirty = sliderMiles !== (settings.coopRadiusOverrideMiles ?? settings.coopRadiusAutoMiles);

  return (
    <Card id="coop-radius" className="scroll-mt-6" data-testid="section-coop-radius">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <MapPin className="w-5 h-5 text-primary" /> Co-Op Search Radius
          </CardTitle>
          <Badge variant={hasOverride ? 'secondary' : 'default'} data-testid="badge-coop-radius-mode">
            {hasOverride ? 'Manual override' : 'Automatic'}
          </Badge>
        </div>
        <CardDescription>
          How far the Co-Op Partner Hub looks for nearby businesses to partner with.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="p-4 border rounded-lg space-y-1">
          <div className="text-sm">
            Detected area type:{' '}
            <span className="font-medium" data-testid="text-density-classification">{densityLabel}</span>
          </div>
          <p className="text-sm text-muted-foreground" data-testid="text-coop-radius-auto">
            Auto-assigned radius: {settings.coopRadiusAutoMiles} miles — set automatically from the
            commercial density around your address, and refreshed whenever your address changes.
          </p>
        </div>
        <div className="grid gap-3">
          <div className="flex items-center justify-between">
            <Label>Search radius</Label>
            <span className="text-sm font-medium" data-testid="text-coop-radius-value">
              {sliderMiles} miles
            </span>
          </div>
          <Slider
            min={0.5}
            max={25}
            step={0.5}
            value={[sliderMiles]}
            onValueChange={(v) => setSliderMiles(v[0])}
            data-testid="slider-coop-radius"
          />
          <p className="text-xs text-muted-foreground">
            Moving the slider sets a manual override; automatic re-detection never changes it.
          </p>
        </div>
        <div className="flex justify-between items-center gap-3">
          {hasOverride ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground -ml-2"
              onClick={() => onSave(null)}
              disabled={isPending}
              data-testid="button-coop-radius-revert"
            >
              Revert to automatic ({settings.coopRadiusAutoMiles} mi)
            </Button>
          ) : <span />}
          <Button
            onClick={() => onSave(sliderMiles)}
            disabled={isPending || !dirty}
            data-testid="button-save-coop-radius"
          >
            Save Radius
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Marketing Branding section (tenant-scoped only): logo upload (stored as a
 * client-resized data URL) and brand colors used by the Co-Op Marketing Hub
 * asset generator. Sensible defaults apply when unset.
 */
function BrandingCard({
  branding, setBranding, onSave, isPending,
}: {
  branding: { brandLogoUrl: string; brandPrimaryColor: string; brandSecondaryColor: string };
  setBranding: React.Dispatch<React.SetStateAction<{
    brandLogoUrl: string; brandPrimaryColor: string; brandSecondaryColor: string;
  }>>;
  onSave: () => void;
  isPending: boolean;
}) {
  const onLogoFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        // Resize client-side so the stored data URL stays small.
        const max = 256;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
        setBranding(b => ({ ...b, brandLogoUrl: canvas.toDataURL('image/png') }));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  };

  return (
    <Card id="branding" className="scroll-mt-6" data-testid="section-branding">
      <CardHeader>
        <CardTitle>Marketing Branding</CardTitle>
        <CardDescription>
          Your logo and brand colors power the co-branded assets in the Co-Op Marketing Hub.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-4">
          {branding.brandLogoUrl ? (
            <img
              src={branding.brandLogoUrl}
              alt="Business logo"
              className="w-16 h-16 rounded-md border object-contain bg-white"
              data-testid="img-brand-logo"
            />
          ) : (
            <div
              className="w-16 h-16 rounded-md border border-dashed flex items-center justify-center text-xs text-muted-foreground"
              data-testid="placeholder-brand-logo"
            >
              No logo
            </div>
          )}
          <div className="space-y-1">
            <Input
              type="file"
              accept="image/*"
              className="max-w-xs"
              onChange={e => onLogoFile(e.target.files?.[0])}
              data-testid="input-brand-logo"
            />
            {branding.brandLogoUrl && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground -ml-2"
                onClick={() => setBranding(b => ({ ...b, brandLogoUrl: '' }))}
                data-testid="button-clear-brand-logo"
              >
                Remove logo
              </Button>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 max-w-sm">
          <div className="grid gap-1.5">
            <Label htmlFor="brand-primary">Primary color</Label>
            <Input
              id="brand-primary"
              type="color"
              value={branding.brandPrimaryColor}
              onChange={e => setBranding(b => ({ ...b, brandPrimaryColor: e.target.value }))}
              data-testid="input-brand-primary"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="brand-secondary">Secondary color</Label>
            <Input
              id="brand-secondary"
              type="color"
              value={branding.brandSecondaryColor}
              onChange={e => setBranding(b => ({ ...b, brandSecondaryColor: e.target.value }))}
              data-testid="input-brand-secondary"
            />
          </div>
        </div>
        <div className="flex justify-end">
          <Button onClick={onSave} disabled={isPending} data-testid="button-save-branding">
            Save Branding
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Co-Op Network section (tenant-scoped only): the business's Level 2
 * sub-category (the category firewall key — same-sub-category competitors
 * never see each other) and the 1–15 mile local discovery radius slider.
 */
function CoopNetworkCard({
  coop, setCoop, onSave, isPending,
}: {
  coop: { coopSubCategory: string; coopRadiusMiles: number };
  setCoop: React.Dispatch<React.SetStateAction<{ coopSubCategory: string; coopRadiusMiles: number }>>;
  onSave: () => void;
  isPending: boolean;
}) {
  const { data: taxonomy } = useGetCoopTaxonomy({
    query: { queryKey: getGetCoopTaxonomyQueryKey() },
  });
  const isCurated = (taxonomy ?? []).some((i) =>
    i.subCategories.some((s) => s.slug === coop.coopSubCategory),
  );
  return (
    <Card id="coop-network" className="scroll-mt-6" data-testid="section-coop-network">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Building2 className="w-5 h-5 text-primary" /> Co-Op Network
        </CardTitle>
        <CardDescription>
          Your sub-category keeps direct competitors out of your co-op network, and the search
          radius scopes local partner discovery to nearby businesses.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-2">
          <Label>Business sub-category</Label>
          <select
            value={isCurated ? coop.coopSubCategory : ''}
            onChange={(e) => setCoop((c) => ({ ...c, coopSubCategory: e.target.value }))}
            className="rounded-md border bg-background p-2 text-sm"
            data-testid="select-coop-subcategory"
          >
            <option value="">Auto-detect from business category</option>
            {(taxonomy ?? []).map((industry) => (
              <optgroup key={industry.slug} label={industry.label}>
                {industry.subCategories.map((s) => (
                  <option key={s.slug} value={s.slug}>{s.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            Businesses in your exact sub-category never appear in your directory or feeds (and you
            never appear in theirs). Same-industry, different-niche partners stay available.
          </p>
        </div>
        <div className="grid gap-2">
          <div className="flex items-center justify-between">
            <Label>Co-Op search radius</Label>
            <span className="text-sm font-medium" data-testid="text-coop-radius-value">
              {coop.coopRadiusMiles} {coop.coopRadiusMiles === 1 ? 'mile' : 'miles'}
            </span>
          </div>
          <Slider
            min={1}
            max={15}
            step={1}
            value={[coop.coopRadiusMiles]}
            onValueChange={([v]) => setCoop((c) => ({ ...c, coopRadiusMiles: v }))}
            data-testid="slider-coop-radius"
          />
          <p className="text-xs text-muted-foreground">
            Local discovery uses your saved coordinates when available, falling back to
            city matching otherwise.
          </p>
        </div>
        <div className="flex justify-end">
          <Button onClick={onSave} disabled={isPending} data-testid="button-save-coop-network">
            Save Co-Op Settings
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Customer Reviews section (tenant-scoped only): add reviews, toggle which
 * ones appear on the public landing page, and delete mistakes.
 */
function ReviewsCard({ tenantId }: { tenantId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: reviews, isLoading } = useListTenantReviews(tenantId, {
    query: { queryKey: getListTenantReviewsQueryKey(tenantId) },
  });
  const createReview = useCreateTenantReview();
  const updateReview = useUpdateTenantReview();
  const deleteReview = useDeleteTenantReview();

  const [authorName, setAuthorName] = React.useState('');
  const [rating, setRating] = React.useState('5');
  const [body, setBody] = React.useState('');

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: getListTenantReviewsQueryKey(tenantId) });

  const onAdd = () => {
    const r = Math.max(1, Math.min(5, Math.round(parseFloat(rating) || 5)));
    if (!authorName.trim()) {
      toast({ title: 'Author name is required', variant: 'destructive' });
      return;
    }
    createReview.mutate(
      { id: tenantId, data: { authorName: authorName.trim(), rating: r, body: body.trim() } },
      {
        onSuccess: () => {
          setAuthorName('');
          setRating('5');
          setBody('');
          refresh();
          toast({ title: 'Review added' });
        },
        onError: () => toast({ title: "Couldn't add review", variant: 'destructive' }),
      },
    );
  };

  return (
    <Card id="reviews" className="scroll-mt-6" data-testid="section-reviews">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Star className="w-5 h-5 text-primary" /> Customer Reviews
        </CardTitle>
        <CardDescription>
          Reviews shown on your public landing page. Toggle visibility to control which ones appear.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="p-4 border rounded-lg space-y-3" data-testid="form-add-review">
          <div className="grid grid-cols-3 gap-4">
            <div className="grid gap-2 col-span-2">
              <Label>Customer name</Label>
              <Input value={authorName} onChange={(e) => setAuthorName(e.target.value)} data-testid="input-review-author" />
            </div>
            <div className="grid gap-2">
              <Label>Rating (1–5)</Label>
              <Input type="number" min="1" max="5" step="1" value={rating} onChange={(e) => setRating(e.target.value)} data-testid="input-review-rating" />
            </div>
          </div>
          <div className="grid gap-2">
            <Label>Review text</Label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={2}
              className="rounded-md border bg-background p-2 text-sm"
              data-testid="input-review-body"
            />
          </div>
          <div className="flex justify-end">
            <Button onClick={onAdd} disabled={createReview.isPending} data-testid="button-add-review">
              Add Review
            </Button>
          </div>
        </div>

        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : !reviews || reviews.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-reviews">
            No reviews yet. Add your first customer review above.
          </p>
        ) : (
          <div className="space-y-2">
            {reviews.map((r) => (
              <div key={r.id} className="flex items-start justify-between gap-3 p-3 border rounded-lg" data-testid={`row-review-${r.id}`}>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{r.authorName}</span>
                    <span className="text-amber-500 text-sm tracking-widest">
                      {'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}
                    </span>
                  </div>
                  {r.body && <p className="text-sm text-muted-foreground mt-0.5">{r.body}</p>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">{r.isVisible ? 'Public' : 'Hidden'}</span>
                    <Switch
                      checked={r.isVisible}
                      onCheckedChange={(checked) =>
                        updateReview.mutate(
                          { id: tenantId, reviewId: r.id, data: { isVisible: checked } },
                          { onSuccess: refresh, onError: () => toast({ title: "Couldn't update review", variant: 'destructive' }) },
                        )
                      }
                      data-testid={`switch-review-visible-${r.id}`}
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    onClick={() =>
                      deleteReview.mutate(
                        { id: tenantId, reviewId: r.id },
                        { onSuccess: refresh, onError: () => toast({ title: "Couldn't delete review", variant: 'destructive' }) },
                      )
                    }
                    data-testid={`button-delete-review-${r.id}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Online Booking section (tenant-scoped only): business hours that drive the
 * public page's offered slots, the business's public booking link, and the
 * copy-paste iframe embed snippet for WordPress/Wix/Squarespace/Shopify.
 */
function OnlineBookingCard({
  slug, openTime, closeTime, setOpenTime, setCloseTime, onSave, isPending,
}: {
  slug: string | null;
  openTime: string;
  closeTime: string;
  setOpenTime: (v: string) => void;
  setCloseTime: (v: string) => void;
  onSave: () => void;
  isPending: boolean;
}) {
  const { toast } = useToast();
  const base = `${window.location.origin}${import.meta.env.BASE_URL}`;
  const publicUrl = slug ? `${base}book/${slug}` : null;
  const embedSnippet = publicUrl
    ? `<iframe src="${publicUrl}?embed=1" title="Book an appointment" style="width:100%;max-width:480px;height:640px;border:0;border-radius:12px;" loading="lazy"></iframe>`
    : null;

  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: `${label} copied` });
    } catch {
      toast({ title: `Couldn't copy ${label.toLowerCase()}`, variant: 'destructive' });
    }
  };

  return (
    <Card id="online-booking" className="scroll-mt-6" data-testid="section-online-booking">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ExternalLink className="w-5 h-5 text-primary" /> Online Booking
        </CardTitle>
        <CardDescription>
          Customers book directly — no login — from your public page or a widget embedded on your own website.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="open-time">Opens at</Label>
            <Input
              id="open-time"
              type="time"
              value={openTime}
              onChange={(e) => setOpenTime(e.target.value)}
              data-testid="input-open-time"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="close-time">Closes at</Label>
            <Input
              id="close-time"
              type="time"
              value={closeTime}
              onChange={(e) => setCloseTime(e.target.value)}
              data-testid="input-close-time"
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground -mt-2">
          Only time slots inside these hours (and not already booked) are offered to customers.
        </p>

        {publicUrl ? (
          <>
            <div className="space-y-2">
              <Label>Public booking link</Label>
              <div className="flex gap-2">
                <Input readOnly value={publicUrl} className="font-mono text-xs" data-testid="input-public-booking-url" />
                <Button variant="outline" onClick={() => copy('Link', publicUrl)} data-testid="button-copy-booking-url">
                  Copy
                </Button>
                <Button asChild variant="outline" data-testid="link-open-booking-page">
                  <a href={publicUrl} target="_blank" rel="noreferrer">Open</a>
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Embed widget</Label>
              <p className="text-xs text-muted-foreground">
                Paste this snippet into WordPress, Wix, Squarespace, Shopify, or any site that accepts custom HTML.
              </p>
              <div className="flex gap-2 items-start">
                <textarea
                  readOnly
                  value={embedSnippet ?? ''}
                  rows={3}
                  className="flex-1 rounded-md border bg-muted/40 p-2 font-mono text-xs resize-none"
                  data-testid="textarea-embed-snippet"
                />
                <Button variant="outline" onClick={() => embedSnippet && copy('Embed snippet', embedSnippet)} data-testid="button-copy-embed-snippet">
                  Copy
                </Button>
              </div>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Loading your booking link…</p>
        )}

        <div className="flex justify-end">
          <Button onClick={onSave} disabled={isPending} data-testid="button-save-online-booking">
            Save Online Booking
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
