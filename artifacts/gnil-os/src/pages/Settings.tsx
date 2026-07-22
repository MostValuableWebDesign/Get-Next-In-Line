import React, { useEffect, useRef } from 'react';
import {
  useGetSosSettings,
  useUpdateSosSettings,
  getGetSosSettingsQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Activity, Bot, Building2, MessageSquare } from 'lucide-react';

/**
 * Unified tenant configuration screen.
 *
 * Consolidates the business profile and every module's options (SOS
 * operations, AI receptionist, SMS delivery) into one place. Each section
 * saves independently via a partial PATCH to the existing settings API, so
 * saving one section never clobbers unsaved edits in another.
 */
export default function Settings() {
  const { data: settings, isLoading } = useGetSosSettings();
  const updateSettings = useUpdateSosSettings();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [profile, setProfile] = React.useState({
    businessName: '',
    industryType: '',
    resourceLabel: '',
  });
  const [aiReceptionistEnabled, setAiReceptionistEnabled] = React.useState(false);
  const [waitlistAutoFillEnabled, setWaitlistAutoFillEnabled] = React.useState(false);
  const [smsFromNumber, setSmsFromNumber] = React.useState('');

  const initialized = useRef(false);

  useEffect(() => {
    if (settings && !initialized.current) {
      setProfile({
        businessName: settings.businessName,
        industryType: settings.industryType,
        resourceLabel: settings.resourceLabel,
      });
      setAiReceptionistEnabled(settings.aiReceptionistEnabled);
      setWaitlistAutoFillEnabled(settings.waitlistAutoFillEnabled);
      setSmsFromNumber(settings.smsFromNumber || '');
      initialized.current = true;
    }
  }, [settings]);

  // Scroll to the section referenced by the URL hash (e.g. /settings#sms)
  // once data has loaded and the sections exist in the DOM.
  useEffect(() => {
    if (isLoading) return;
    const hash = window.location.hash.replace('#', '');
    if (!hash) return;
    const el = document.getElementById(hash);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [isLoading]);

  const saveSection = (
    sectionLabel: string,
    data: Partial<{
      businessName: string;
      industryType: string;
      resourceLabel: string;
      aiReceptionistEnabled: boolean;
      waitlistAutoFillEnabled: boolean;
      smsFromNumber: string;
    }>,
  ) => {
    updateSettings.mutate(
      { data },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetSosSettingsQueryKey() });
          toast({ title: `${sectionLabel} saved` });
        },
        onError: () => {
          toast({
            title: `Couldn't save ${sectionLabel.toLowerCase()}`,
            description: 'Please try again.',
            variant: 'destructive',
          });
        },
      },
    );
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

  return (
    <div className="max-w-3xl mx-auto space-y-6" data-testid="page-settings">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Configuration</h1>
        <p className="text-muted-foreground text-sm mt-1">
          One place to configure your business profile, modules, and integrations.
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
              disabled={updateSettings.isPending}
              data-testid="button-save-profile"
            >
              Save Profile
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── AI Receptionist module ───────────────────────────────────── */}
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
          <div className="flex justify-end">
            <Button
              onClick={() => saveSection('AI Receptionist', { aiReceptionistEnabled })}
              disabled={updateSettings.isPending}
              data-testid="button-save-ai-receptionist"
            >
              Save AI Receptionist
            </Button>
          </div>
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
              disabled={updateSettings.isPending}
              data-testid="button-save-sos-operations"
            >
              Save SOS Operations
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
          <div className="flex justify-end">
            <Button
              onClick={() => saveSection('SMS settings', { smsFromNumber })}
              disabled={updateSettings.isPending}
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
