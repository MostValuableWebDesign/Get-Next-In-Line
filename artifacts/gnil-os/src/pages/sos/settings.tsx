import React, { useEffect, useRef } from 'react';
import { useGetSosSettings, useUpdateSosSettings, getGetSosSettingsQueryKey } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';

export function SettingsPage() {
  const { data: settings, isLoading } = useGetSosSettings();
  const updateSettings = useUpdateSosSettings();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [form, setForm] = React.useState({
    businessName: '',
    industryType: '',
    resourceLabel: '',
    aiReceptionistEnabled: false,
    waitlistAutoFillEnabled: false,
    smsFromNumber: ''
  });

  const initialized = useRef(false);

  useEffect(() => {
    if (settings && !initialized.current) {
      setForm({
        businessName: settings.businessName,
        industryType: settings.industryType,
        resourceLabel: settings.resourceLabel,
        aiReceptionistEnabled: settings.aiReceptionistEnabled,
        waitlistAutoFillEnabled: settings.waitlistAutoFillEnabled,
        smsFromNumber: settings.smsFromNumber || ''
      });
      initialized.current = true;
    }
  }, [settings]);

  const handleSave = () => {
    updateSettings.mutate(
      { data: form },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetSosSettingsQueryKey() });
          toast({ title: 'Settings saved successfully' });
        }
      }
    );
  };

  if (isLoading) return <div className="p-8 max-w-2xl mx-auto space-y-6"><Skeleton className="h-10 w-48"/><Skeleton className="h-[400px] w-full"/></div>;

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground text-sm mt-1">Configure your workspace and AI automations.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Business Profile</CardTitle>
          <CardDescription>General information about your location.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label>Business Name</Label>
            <Input 
              value={form.businessName} 
              onChange={e => setForm(f => ({...f, businessName: e.target.value}))} 
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>Industry Type</Label>
              <Input 
                value={form.industryType} 
                onChange={e => setForm(f => ({...f, industryType: e.target.value}))} 
                placeholder="e.g. Salon, Restaurant"
              />
            </div>
            <div className="grid gap-2">
              <Label>Resource Label</Label>
              <Input 
                value={form.resourceLabel} 
                onChange={e => setForm(f => ({...f, resourceLabel: e.target.value}))} 
                placeholder="e.g. Chair, Table, Bay"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>AI & Automation</CardTitle>
          <CardDescription>Control the autonomous features of SOS.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between p-4 border rounded-lg">
            <div className="space-y-0.5">
              <Label className="text-base">AI Receptionist</Label>
              <p className="text-sm text-muted-foreground">Automatically answer calls, take messages, and book appointments.</p>
            </div>
            <Switch 
              checked={form.aiReceptionistEnabled}
              onCheckedChange={c => setForm(f => ({...f, aiReceptionistEnabled: c}))}
            />
          </div>
          
          <div className="flex items-center justify-between p-4 border rounded-lg">
            <div className="space-y-0.5">
              <Label className="text-base">Smart Waitlist Auto-fill</Label>
              <p className="text-sm text-muted-foreground">Automatically text the waitlist when a booked appointment cancels.</p>
            </div>
            <Switch 
              checked={form.waitlistAutoFillEnabled}
              onCheckedChange={c => setForm(f => ({...f, waitlistAutoFillEnabled: c}))}
            />
          </div>

          <div className="flex items-center justify-between p-4 border rounded-lg">
            <div className="space-y-0.5">
              <Label className="text-base">SMS Delivery</Label>
              <p className="text-sm text-muted-foreground">
                {settings?.smsMode === 'live'
                  ? <>Real texts are being sent via Twilio from <span className="font-medium">{settings?.smsActiveFromNumber}</span>.</>
                  : 'Simulated mode — messages are logged but not actually sent. Connect Twilio and set a From number to go live.'}
              </p>
            </div>
            <Badge variant={settings?.smsMode === 'live' ? 'default' : 'secondary'} data-testid="badge-sms-mode">
              {settings?.smsMode === 'live' ? 'Live' : 'Simulated'}
            </Badge>
          </div>

          <div className="grid gap-2 pt-2">
            <Label>Outbound SMS Number</Label>
            <Input 
              value={form.smsFromNumber} 
              onChange={e => setForm(f => ({...f, smsFromNumber: e.target.value}))} 
              placeholder="+1 (555) 000-0000"
            />
            <p className="text-xs text-muted-foreground">This number is used for all outgoing AI and waitlist texts.</p>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSave} size="lg">Save Changes</Button>
      </div>
    </div>
  );
}
