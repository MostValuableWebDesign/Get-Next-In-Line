import React, { useState } from 'react';
import { Link, useParams } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGetTenant,
  getGetTenantQueryKey,
  useListEngagementRules,
  getListEngagementRulesQueryKey,
  useCreateEngagementRule,
  useUpdateEngagementRule,
  useDeleteEngagementRule,
  useListClientProfiles,
  getListClientProfilesQueryKey,
  useCreateClientProfile,
  useUpdateClientProfile,
  useDeleteClientProfile,
  useListConciergeMessageLogs,
  getListConciergeMessageLogsQueryKey,
  type EngagementRule,
  type ConciergeClientProfile,
} from '@workspace/api-client-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, Bot, Pencil, Plus, Trash2, Users, ScrollText } from 'lucide-react';

const RULE_TYPES = [
  { value: 'reminder', label: 'Appointment Reminder' },
  { value: 'rebooking_nudge', label: 'Rebooking Nudge' },
  { value: 'upsell', label: 'Upsell Suggestions' },
] as const;

const RULE_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  RULE_TYPES.map((r) => [r.value, r.label]),
);

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  sent: 'default',
  simulated: 'secondary',
  pending: 'outline',
  failed: 'destructive',
  skipped: 'destructive',
};

/**
 * Tenant-scoped Concierge management screen: engagement rule editing,
 * client-profile CRUD, and the message dispatch log with status and
 * error reasons.
 */
export default function Concierge() {
  const params = useParams<{ id: string }>();
  const tenantId = Number(params.id);
  const validId = Number.isInteger(tenantId);

  const { data: tenant, isLoading: isLoadingTenant, error } = useGetTenant(tenantId, {
    query: { queryKey: getGetTenantQueryKey(tenantId), enabled: validId },
  });

  if (isLoadingTenant) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-[400px] w-full rounded-xl" />
      </div>
    );
  }

  if (!validId || error || !tenant) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight">Tenant not found</h1>
        <p className="text-muted-foreground">This tenant does not exist or is no longer available.</p>
        <Button asChild variant="outline">
          <Link href="/tenants">Back to Tenant Operations</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="page-concierge">
      <Button asChild variant="ghost" size="sm" className="gap-2 -ml-2 text-muted-foreground" data-testid="link-back-tenant">
        <Link href={`/tenants/${tenantId}`}>
          <ArrowLeft className="w-4 h-4" /> Back to {tenant.brandName}
        </Link>
      </Button>
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Concierge</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Engagement rules, client profiles, and the automated message log for{' '}
          <span className="font-medium">{tenant.brandName}</span>.
        </p>
      </div>

      <Tabs defaultValue="rules">
        <TabsList data-testid="tabs-concierge">
          <TabsTrigger value="rules" data-testid="tab-rules">
            <Bot className="w-4 h-4 mr-1.5" /> Engagement Rules
          </TabsTrigger>
          <TabsTrigger value="clients" data-testid="tab-clients">
            <Users className="w-4 h-4 mr-1.5" /> Client Profiles
          </TabsTrigger>
          <TabsTrigger value="log" data-testid="tab-log">
            <ScrollText className="w-4 h-4 mr-1.5" /> Message Log
          </TabsTrigger>
        </TabsList>
        <TabsContent value="rules" className="mt-4">
          <RulesTab tenantId={tenantId} />
        </TabsContent>
        <TabsContent value="clients" className="mt-4">
          <ClientsTab tenantId={tenantId} />
        </TabsContent>
        <TabsContent value="log" className="mt-4">
          <MessageLogTab tenantId={tenantId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Engagement rules ──────────────────────────────────────────────────────────

interface RuleFormState {
  ruleType: string;
  isActive: boolean;
  configText: string;
}

function defaultConfigFor(ruleType: string): string {
  switch (ruleType) {
    case 'reminder':
      return JSON.stringify(
        { leadHours: 24, template: 'Hi {{name}}, this is a reminder about your upcoming appointment on {{when}}. See you soon!' },
        null,
        2,
      );
    case 'rebooking_nudge':
      return JSON.stringify(
        { cooldownDays: 7, template: "Hi {{name}}, it's been a while since your last visit — reply to this text to book your next appointment!" },
        null,
        2,
      );
    default:
      return JSON.stringify(
        { addOns: [{ name: 'Deep Conditioning', price: 25, compatibleServices: [] }] },
        null,
        2,
      );
  }
}

function RulesTab({ tenantId }: { tenantId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: rules, isLoading } = useListEngagementRules(tenantId, {
    query: { queryKey: getListEngagementRulesQueryKey(tenantId) },
  });
  const createRule = useCreateEngagementRule();
  const updateRule = useUpdateEngagementRule();
  const deleteRule = useDeleteEngagementRule();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<EngagementRule | null>(null);
  const [form, setForm] = useState<RuleFormState>({
    ruleType: 'reminder',
    isActive: true,
    configText: defaultConfigFor('reminder'),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListEngagementRulesQueryKey(tenantId) });

  const openCreate = () => {
    setEditing(null);
    setForm({ ruleType: 'reminder', isActive: true, configText: defaultConfigFor('reminder') });
    setDialogOpen(true);
  };

  const openEdit = (rule: EngagementRule) => {
    setEditing(rule);
    setForm({
      ruleType: rule.ruleType,
      isActive: rule.isActive,
      configText: JSON.stringify(rule.config ?? {}, null, 2),
    });
    setDialogOpen(true);
  };

  const submit = () => {
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(form.configText || '{}');
    } catch {
      toast({ title: 'Configuration must be valid JSON', variant: 'destructive' });
      return;
    }
    const onError = (err: unknown) => {
      const message = (err as { data?: { error?: string } })?.data?.error;
      toast({
        title: "Couldn't save rule",
        description: message ?? 'Check the configuration and try again.',
        variant: 'destructive',
      });
    };
    if (editing) {
      updateRule.mutate(
        { id: tenantId, ruleId: editing.id, data: { config, isActive: form.isActive } },
        { onSuccess: () => { invalidate(); setDialogOpen(false); toast({ title: 'Rule saved' }); }, onError },
      );
    } else {
      createRule.mutate(
        {
          id: tenantId,
          data: {
            ruleType: form.ruleType as 'reminder' | 'rebooking_nudge' | 'upsell',
            config,
            isActive: form.isActive,
          },
        },
        { onSuccess: () => { invalidate(); setDialogOpen(false); toast({ title: 'Rule created' }); }, onError },
      );
    }
  };

  const remove = (rule: EngagementRule) => {
    deleteRule.mutate(
      { id: tenantId, ruleId: rule.id },
      {
        onSuccess: () => { invalidate(); toast({ title: 'Rule deleted' }); },
        onError: () => toast({ title: "Couldn't delete rule", variant: 'destructive' }),
      },
    );
  };

  const toggleActive = (rule: EngagementRule, isActive: boolean) => {
    updateRule.mutate(
      { id: tenantId, ruleId: rule.id, data: { isActive } },
      {
        onSuccess: invalidate,
        onError: () => toast({ title: "Couldn't update rule", variant: 'destructive' }),
      },
    );
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-lg">Engagement Rules</CardTitle>
          <CardDescription>Automated reminders, rebooking nudges, and upsell suggestions.</CardDescription>
        </div>
        <Button size="sm" onClick={openCreate} data-testid="button-add-rule">
          <Plus className="w-4 h-4 mr-1" /> Add Rule
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-24 w-full rounded-lg" />
        ) : !rules || rules.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-rules">
            No engagement rules yet. Add one to start automating client outreach.
          </p>
        ) : (
          <div className="divide-y" data-testid="list-rules">
            {rules.map((rule) => (
              <div key={rule.id} className="py-3 flex items-center justify-between gap-4" data-testid={`row-rule-${rule.id}`}>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{RULE_TYPE_LABEL[rule.ruleType] ?? rule.ruleType}</span>
                    <Badge variant={rule.isActive ? 'default' : 'secondary'} className="text-[10px] uppercase">
                      {rule.isActive ? 'Active' : 'Paused'}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground font-mono truncate mt-0.5 max-w-xl">
                    {JSON.stringify(rule.config)}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Switch
                    checked={rule.isActive}
                    onCheckedChange={(v) => toggleActive(rule, v)}
                    data-testid={`switch-rule-active-${rule.id}`}
                  />
                  <Button variant="ghost" size="icon" onClick={() => openEdit(rule)} data-testid={`button-edit-rule-${rule.id}`}>
                    <Pencil className="w-4 h-4" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => remove(rule)} data-testid={`button-delete-rule-${rule.id}`}>
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Rule' : 'New Engagement Rule'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {!editing && (
              <div className="grid gap-2">
                <Label>Rule Type</Label>
                <Select
                  value={form.ruleType}
                  onValueChange={(v) => setForm((f) => ({ ...f, ruleType: v, configText: defaultConfigFor(v) }))}
                >
                  <SelectTrigger data-testid="select-rule-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RULE_TYPES.map((r) => (
                      <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="grid gap-2">
              <Label>Configuration (JSON)</Label>
              <Textarea
                rows={8}
                className="font-mono text-xs"
                value={form.configText}
                onChange={(e) => setForm((f) => ({ ...f, configText: e.target.value }))}
                data-testid="input-rule-config"
              />
              <p className="text-xs text-muted-foreground">
                Templates support {'{{name}}'}, {'{{when}}'} and {'{{days}}'} placeholders.
              </p>
            </div>
            <div className="flex items-center justify-between p-3 border rounded-lg">
              <Label>Active</Label>
              <Switch
                checked={form.isActive}
                onCheckedChange={(v) => setForm((f) => ({ ...f, isActive: v }))}
                data-testid="switch-rule-form-active"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button
              onClick={submit}
              disabled={createRule.isPending || updateRule.isPending}
              data-testid="button-save-rule"
            >
              {editing ? 'Save Rule' : 'Create Rule'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ── Client profiles ───────────────────────────────────────────────────────────

interface ProfileFormState {
  name: string;
  phone: string;
  email: string;
  preferredChannel: string;
  smsOptIn: boolean;
}

const EMPTY_PROFILE: ProfileFormState = {
  name: '',
  phone: '',
  email: '',
  preferredChannel: 'sms',
  smsOptIn: true,
};

function ClientsTab({ tenantId }: { tenantId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: profiles, isLoading } = useListClientProfiles(tenantId, {
    query: { queryKey: getListClientProfilesQueryKey(tenantId) },
  });
  const createProfile = useCreateClientProfile();
  const updateProfile = useUpdateClientProfile();
  const deleteProfile = useDeleteClientProfile();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ConciergeClientProfile | null>(null);
  const [form, setForm] = useState<ProfileFormState>(EMPTY_PROFILE);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListClientProfilesQueryKey(tenantId) });

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_PROFILE);
    setDialogOpen(true);
  };

  const openEdit = (p: ConciergeClientProfile) => {
    setEditing(p);
    setForm({
      name: p.name,
      phone: p.phone ?? '',
      email: p.email ?? '',
      preferredChannel: p.preferredChannel,
      smsOptIn: p.smsOptIn,
    });
    setDialogOpen(true);
  };

  const submit = () => {
    if (!form.name.trim()) {
      toast({ title: 'Name is required', variant: 'destructive' });
      return;
    }
    const data = {
      name: form.name.trim(),
      phone: form.phone.trim() || null,
      email: form.email.trim() || null,
      preferredChannel: form.preferredChannel as 'sms' | 'email' | 'voice',
      smsOptIn: form.smsOptIn,
    };
    const onError = () =>
      toast({ title: "Couldn't save client profile", variant: 'destructive' });
    if (editing) {
      updateProfile.mutate(
        { id: tenantId, profileId: editing.id, data },
        { onSuccess: () => { invalidate(); setDialogOpen(false); toast({ title: 'Client saved' }); }, onError },
      );
    } else {
      createProfile.mutate(
        { id: tenantId, data },
        { onSuccess: () => { invalidate(); setDialogOpen(false); toast({ title: 'Client created' }); }, onError },
      );
    }
  };

  const remove = (p: ConciergeClientProfile) => {
    deleteProfile.mutate(
      { id: tenantId, profileId: p.id },
      {
        onSuccess: () => { invalidate(); toast({ title: 'Client deleted' }); },
        onError: () => toast({ title: "Couldn't delete client", variant: 'destructive' }),
      },
    );
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-lg">Client Profiles</CardTitle>
          <CardDescription>Marketing profiles the concierge engages on this tenant's behalf.</CardDescription>
        </div>
        <Button size="sm" onClick={openCreate} data-testid="button-add-client">
          <Plus className="w-4 h-4 mr-1" /> Add Client
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-24 w-full rounded-lg" />
        ) : !profiles || profiles.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-clients">
            No client profiles yet.
          </p>
        ) : (
          <Table data-testid="table-clients">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>SMS Opt-in</TableHead>
                <TableHead>Last Visit</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {profiles.map((p) => (
                <TableRow key={p.id} data-testid={`row-client-${p.id}`}>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell className="font-mono text-xs">{p.phone ?? '—'}</TableCell>
                  <TableCell className="uppercase text-xs">{p.preferredChannel}</TableCell>
                  <TableCell>
                    <Badge variant={p.smsOptIn ? 'default' : 'secondary'} className="text-[10px]">
                      {p.smsOptIn ? 'Opted in' : 'Opted out'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {p.lastVisitAt ? new Date(p.lastVisitAt).toLocaleDateString() : '—'}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1 justify-end">
                      <Button variant="ghost" size="icon" onClick={() => openEdit(p)} data-testid={`button-edit-client-${p.id}`}>
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => remove(p)} data-testid={`button-delete-client-${p.id}`}>
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Client' : 'New Client Profile'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-2">
              <Label>Name</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                data-testid="input-client-name"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>Phone</Label>
                <Input
                  value={form.phone}
                  onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                  placeholder="+1 (555) 000-0000"
                  data-testid="input-client-phone"
                />
              </div>
              <div className="grid gap-2">
                <Label>Email</Label>
                <Input
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  data-testid="input-client-email"
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Preferred Channel</Label>
              <Select
                value={form.preferredChannel}
                onValueChange={(v) => setForm((f) => ({ ...f, preferredChannel: v }))}
              >
                <SelectTrigger data-testid="select-client-channel">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sms">SMS</SelectItem>
                  <SelectItem value="email">Email</SelectItem>
                  <SelectItem value="voice">Voice</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between p-3 border rounded-lg">
              <Label>SMS Opt-in</Label>
              <Switch
                checked={form.smsOptIn}
                onCheckedChange={(v) => setForm((f) => ({ ...f, smsOptIn: v }))}
                data-testid="switch-client-optin"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button
              onClick={submit}
              disabled={createProfile.isPending || updateProfile.isPending}
              data-testid="button-save-client"
            >
              {editing ? 'Save Client' : 'Create Client'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ── Message dispatch log ──────────────────────────────────────────────────────

function MessageLogTab({ tenantId }: { tenantId: number }) {
  const { data: logs, isLoading } = useListConciergeMessageLogs(tenantId, {
    query: { queryKey: getListConciergeMessageLogsQueryKey(tenantId) },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Message Dispatch Log</CardTitle>
        <CardDescription>
          Every automated and manual concierge message, with delivery status and error reasons.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-24 w-full rounded-lg" />
        ) : !logs || logs.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-logs">
            No messages have been dispatched for this tenant yet.
          </p>
        ) : (
          <Table data-testid="table-message-logs">
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((log) => (
                <TableRow key={log.id} data-testid={`row-log-${log.id}`}>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(log.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-sm">{log.clientName ?? '—'}</TableCell>
                  <TableCell className="text-xs uppercase">{log.jobType.replace(/_/g, ' ')}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[log.status] ?? 'outline'} className="text-[10px] uppercase" data-testid={`badge-log-status-${log.id}`}>
                      {log.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-md">
                    {log.status === 'failed' || log.status === 'skipped' ? (
                      <span className="text-xs text-destructive" data-testid={`text-log-error-${log.id}`}>
                        {log.errorMessage ?? log.errorCode ?? 'Unknown error'}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground truncate block">{log.body ?? '—'}</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
