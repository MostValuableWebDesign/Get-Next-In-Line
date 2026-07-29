import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  listEngagementRules,
  listClientProfiles,
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
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { usePagedList } from '@/hooks/usePagedList';

const RULE_TYPES = [
  { value: 'reminder', label: 'Appointment Reminder' },
  { value: 'rebooking_nudge', label: 'Rebooking Nudge' },
  { value: 'upsell', label: 'Upsell Suggestions' },
] as const;

const RULE_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  RULE_TYPES.map((r) => [r.value, r.label]),
);

/*
 * Concierge management tabs, hosted on the Tenant Detail page
 * (/tenants/:id?tab=rules|clients): engagement rule editing and
 * client-profile CRUD. The former standalone /tenants/:id/concierge route
 * redirects there. The message dispatch log moved to the unified
 * Communications tab (communications-tab.tsx).
 */

// ── Engagement rules ──────────────────────────────────────────────────────────

// Form state mirrors the server-side zod config shapes
// (reminderRuleConfigSchema / rebookingRuleConfigSchema / upsellRuleConfigSchema)
// but keeps numeric fields as strings so partially-typed input isn't clobbered.

const DEFAULT_REMINDER_TEMPLATE =
  'Hi {{name}}, this is a reminder about your upcoming appointment on {{when}}. See you soon!';
const DEFAULT_REBOOKING_TEMPLATE =
  "Hi {{name}}, it's been a while since your last visit — reply to this text to book your next appointment!";

interface AddOnRow {
  name: string;
  price: string; // '' = no price
  description: string; // '' = no description
  compatibleServices: string; // comma-separated; '' = every service
}

interface RuleFormState {
  ruleType: string;
  isActive: boolean;
  leadHours: string;
  reminderTemplate: string;
  cooldownDays: string;
  rebookingTemplate: string;
  addOns: AddOnRow[];
}

const EMPTY_ADD_ON: AddOnRow = { name: '', price: '', description: '', compatibleServices: '' };

function defaultRuleForm(ruleType: string): RuleFormState {
  return {
    ruleType,
    isActive: true,
    leadHours: '24',
    reminderTemplate: DEFAULT_REMINDER_TEMPLATE,
    cooldownDays: '7',
    rebookingTemplate: DEFAULT_REBOOKING_TEMPLATE,
    addOns: [{ ...EMPTY_ADD_ON }],
  };
}

/** Populate the typed form from an existing rule's stored config. */
function formFromRule(rule: EngagementRule): RuleFormState {
  const cfg = (rule.config ?? {}) as Record<string, unknown>;
  const base = defaultRuleForm(rule.ruleType);
  base.isActive = rule.isActive;
  if (rule.ruleType === 'reminder') {
    if (typeof cfg.leadHours === 'number') base.leadHours = String(cfg.leadHours);
    if (typeof cfg.template === 'string') base.reminderTemplate = cfg.template;
  } else if (rule.ruleType === 'rebooking_nudge') {
    if (typeof cfg.cooldownDays === 'number') base.cooldownDays = String(cfg.cooldownDays);
    if (typeof cfg.template === 'string') base.rebookingTemplate = cfg.template;
  } else {
    const addOns = Array.isArray(cfg.addOns) ? cfg.addOns : [];
    base.addOns = addOns.length
      ? addOns.map((a) => {
          const row = (a ?? {}) as Record<string, unknown>;
          return {
            name: typeof row.name === 'string' ? row.name : '',
            price: typeof row.price === 'number' ? String(row.price) : '',
            description: typeof row.description === 'string' ? row.description : '',
            compatibleServices: Array.isArray(row.compatibleServices)
              ? (row.compatibleServices as unknown[]).filter((s): s is string => typeof s === 'string').join(', ')
              : '',
          };
        })
      : [{ ...EMPTY_ADD_ON }];
  }
  return base;
}

/**
 * Validate the typed form and serialize it to the config payload the server
 * expects. Mirrors the server-side zod schemas so bad input is caught before
 * the request is sent. Returns { config } or { error }.
 */
function buildRuleConfig(
  form: RuleFormState,
): { config: Record<string, unknown>; error?: never } | { error: string; config?: never } {
  if (form.ruleType === 'reminder') {
    const leadHours = Number(form.leadHours);
    if (!Number.isInteger(leadHours) || leadHours <= 0) {
      return { error: 'Lead hours must be a positive whole number.' };
    }
    const template = form.reminderTemplate.trim();
    if (!template) return { error: 'Message template is required.' };
    return { config: { leadHours, template } };
  }
  if (form.ruleType === 'rebooking_nudge') {
    const cooldownDays = Number(form.cooldownDays);
    if (!Number.isInteger(cooldownDays) || cooldownDays <= 0) {
      return { error: 'Cooldown days must be a positive whole number.' };
    }
    const template = form.rebookingTemplate.trim();
    if (!template) return { error: 'Message template is required.' };
    return { config: { cooldownDays, template } };
  }
  // upsell — drop fully-empty rows, require a name on the rest
  const rows = form.addOns.filter(
    (r) => r.name.trim() || r.price.trim() || r.description.trim() || r.compatibleServices.trim(),
  );
  const addOns: Array<Record<string, unknown>> = [];
  for (const [i, row] of rows.entries()) {
    if (!row.name.trim()) {
      return { error: `Add-on ${i + 1} needs a name.` };
    }
    let price: number | null = null;
    if (row.price.trim() !== '') {
      price = Number(row.price);
      if (!Number.isFinite(price) || price < 0) {
        return { error: `Add-on "${row.name.trim()}" has an invalid price.` };
      }
    }
    const compatibleServices = row.compatibleServices
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    addOns.push({
      name: row.name.trim(),
      price,
      description: row.description.trim() || null,
      compatibleServices,
    });
  }
  return { config: { addOns } };
}

/** Human summary of a rule's stored config, for the list row. */
function summarizeRuleConfig(rule: EngagementRule): string {
  const cfg = (rule.config ?? {}) as Record<string, unknown>;
  if (rule.ruleType === 'reminder') {
    return `${cfg.leadHours ?? 24}h before appointment — "${String(cfg.template ?? '')}"`;
  }
  if (rule.ruleType === 'rebooking_nudge') {
    return `${cfg.cooldownDays ?? 7}-day cooldown — "${String(cfg.template ?? '')}"`;
  }
  const addOns = Array.isArray(cfg.addOns) ? cfg.addOns : [];
  if (addOns.length === 0) return 'No add-ons configured';
  return addOns
    .map((a) => {
      const row = (a ?? {}) as Record<string, unknown>;
      const price = typeof row.price === 'number' ? ` ($${row.price})` : '';
      return `${String(row.name ?? '')}${price}`;
    })
    .join(', ');
}

const PAGE_SIZE = 50;

export function RulesTab({ tenantId }: { tenantId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: firstPage, isLoading } = useListEngagementRules(tenantId, { limit: PAGE_SIZE }, {
    query: { queryKey: getListEngagementRulesQueryKey(tenantId) },
  });
  const {
    items: rules,
    hasMore: hasMoreRules,
    loadingMore: loadingMoreRules,
    loadMore: loadMoreRules,
  } = usePagedList<EngagementRule>(firstPage, PAGE_SIZE, (offset) =>
    listEngagementRules(tenantId, { limit: PAGE_SIZE, offset }),
  );
  const createRule = useCreateEngagementRule();
  const updateRule = useUpdateEngagementRule();
  const deleteRule = useDeleteEngagementRule();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<EngagementRule | null>(null);
  const [form, setForm] = useState<RuleFormState>(defaultRuleForm('reminder'));

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListEngagementRulesQueryKey(tenantId) });

  const openCreate = () => {
    setEditing(null);
    setForm(defaultRuleForm('reminder'));
    setDialogOpen(true);
  };

  const openEdit = (rule: EngagementRule) => {
    setEditing(rule);
    setForm(formFromRule(rule));
    setDialogOpen(true);
  };

  const setAddOn = (index: number, patch: Partial<AddOnRow>) =>
    setForm((f) => ({
      ...f,
      addOns: f.addOns.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    }));

  const submit = () => {
    const result = buildRuleConfig(form);
    if (result.error) {
      toast({ title: result.error, variant: 'destructive' });
      return;
    }
    const config = result.config;
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
                  <div className="text-xs text-muted-foreground truncate mt-0.5 max-w-xl" data-testid={`text-rule-summary-${rule.id}`}>
                    {summarizeRuleConfig(rule)}
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
        {hasMoreRules && (
          <div className="pt-3 flex justify-center">
            <Button
              variant="outline"
              size="sm"
              disabled={loadingMoreRules}
              onClick={loadMoreRules}
              data-testid="button-rules-load-more"
            >
              {loadingMoreRules ? 'Loading…' : 'Load more rules'}
            </Button>
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
                  onValueChange={(v) => setForm((f) => ({ ...defaultRuleForm(v), isActive: f.isActive }))}
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
            {form.ruleType === 'reminder' && (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="rule-lead-hours">Send reminder (hours before appointment)</Label>
                  <Input
                    id="rule-lead-hours"
                    type="number"
                    min={1}
                    step={1}
                    value={form.leadHours}
                    onChange={(e) => setForm((f) => ({ ...f, leadHours: e.target.value }))}
                    data-testid="input-rule-lead-hours"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="rule-reminder-template">Message template</Label>
                  <Textarea
                    id="rule-reminder-template"
                    rows={4}
                    value={form.reminderTemplate}
                    onChange={(e) => setForm((f) => ({ ...f, reminderTemplate: e.target.value }))}
                    data-testid="input-rule-reminder-template"
                  />
                  <p className="text-xs text-muted-foreground">
                    Supports {'{{name}}'} and {'{{when}}'} placeholders.
                  </p>
                </div>
              </>
            )}
            {form.ruleType === 'rebooking_nudge' && (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="rule-cooldown-days">Cooldown between nudges (days)</Label>
                  <Input
                    id="rule-cooldown-days"
                    type="number"
                    min={1}
                    step={1}
                    value={form.cooldownDays}
                    onChange={(e) => setForm((f) => ({ ...f, cooldownDays: e.target.value }))}
                    data-testid="input-rule-cooldown-days"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="rule-rebooking-template">Message template</Label>
                  <Textarea
                    id="rule-rebooking-template"
                    rows={4}
                    value={form.rebookingTemplate}
                    onChange={(e) => setForm((f) => ({ ...f, rebookingTemplate: e.target.value }))}
                    data-testid="input-rule-rebooking-template"
                  />
                  <p className="text-xs text-muted-foreground">
                    Supports {'{{name}}'} and {'{{days}}'} placeholders.
                  </p>
                </div>
              </>
            )}
            {form.ruleType === 'upsell' && (
              <div className="grid gap-2">
                <Label>Add-ons to suggest</Label>
                <div className="space-y-3" data-testid="list-addon-rows">
                  {form.addOns.map((row, i) => (
                    <div key={i} className="p-3 border rounded-lg space-y-2" data-testid={`row-addon-${i}`}>
                      <div className="flex items-start gap-2">
                        <div className="grid gap-2 flex-1">
                          <Input
                            value={row.name}
                            onChange={(e) => setAddOn(i, { name: e.target.value })}
                            placeholder="Add-on name (e.g. Deep Conditioning)"
                            aria-label={`Add-on ${i + 1} name`}
                            data-testid={`input-addon-name-${i}`}
                          />
                        </div>
                        <div className="w-28">
                          <Input
                            type="number"
                            min={0}
                            value={row.price}
                            onChange={(e) => setAddOn(i, { price: e.target.value })}
                            placeholder="Price"
                            aria-label={`Add-on ${i + 1} price`}
                            data-testid={`input-addon-price-${i}`}
                          />
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() =>
                            setForm((f) => ({
                              ...f,
                              addOns:
                                f.addOns.length > 1
                                  ? f.addOns.filter((_, j) => j !== i)
                                  : [{ ...EMPTY_ADD_ON }],
                            }))
                          }
                          aria-label={`Remove add-on ${i + 1}`}
                          data-testid={`button-remove-addon-${i}`}
                        >
                          <Trash2 className="w-4 h-4 text-destructive" />
                        </Button>
                      </div>
                      <Input
                        value={row.description}
                        onChange={(e) => setAddOn(i, { description: e.target.value })}
                        placeholder="Description shown with the suggestion (optional)"
                        aria-label={`Add-on ${i + 1} description`}
                        data-testid={`input-addon-description-${i}`}
                      />
                      <Input
                        value={row.compatibleServices}
                        onChange={(e) => setAddOn(i, { compatibleServices: e.target.value })}
                        placeholder="Compatible services, comma-separated (blank = all services)"
                        aria-label={`Add-on ${i + 1} compatible services`}
                        data-testid={`input-addon-services-${i}`}
                      />
                    </div>
                  ))}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  onClick={() => setForm((f) => ({ ...f, addOns: [...f.addOns, { ...EMPTY_ADD_ON }] }))}
                  data-testid="button-add-addon"
                >
                  <Plus className="w-4 h-4 mr-1" /> Add add-on
                </Button>
              </div>
            )}
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

export function ClientsTab({ tenantId }: { tenantId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: firstPage, isLoading } = useListClientProfiles(tenantId, { limit: PAGE_SIZE }, {
    query: { queryKey: getListClientProfilesQueryKey(tenantId) },
  });
  const {
    items: profiles,
    hasMore: hasMoreClients,
    loadingMore: loadingMoreClients,
    loadMore: loadMoreClients,
  } = usePagedList<ConciergeClientProfile>(firstPage, PAGE_SIZE, (offset) =>
    listClientProfiles(tenantId, { limit: PAGE_SIZE, offset }),
  );
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
        {hasMoreClients && (
          <div className="pt-3 flex justify-center">
            <Button
              variant="outline"
              size="sm"
              disabled={loadingMoreClients}
              onClick={loadMoreClients}
              data-testid="button-clients-load-more"
            >
              {loadingMoreClients ? 'Loading…' : 'Load more clients'}
            </Button>
          </div>
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
