import { useState } from 'react';
import {
  useGetCoopCapacity, getGetCoopCapacityQueryKey, useUpdateCoopCapacity,
  useListCoopSurgeRules, getListCoopSurgeRulesQueryKey,
  useCreateCoopSurgeRule, useUpdateCoopSurgeRule, useDeleteCoopSurgeRule,
  useListCoopSurgeActivations, getListCoopSurgeActivationsQueryKey,
  type CoopPartnership, type CoopSurgeRule, type CoopCapacityStatusStatus,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Activity, Flame, Gauge, History, Plus, Trash2, Zap } from 'lucide-react';

/**
 * Co-Op Dynamic Surge Pricing & Traffic Balancing — merchant hub section.
 *
 * - Capacity broadcasting: set a daily capacity threshold and/or flip the
 *   live status (busy / moderate / available); automatic status derives from
 *   live queue wait + bookings + resource occupancy when no override is set.
 * - Traffic-routing rules: "when my wait exceeds N minutes, boost the perk at
 *   Partner X from A% to B% for the next M minutes."
 * - Live boosts + recent activation history.
 */

export const CAPACITY_LABEL: Record<string, string> = {
  available: 'Open — plenty of availability',
  moderate: 'Moderate — some wait',
  busy: 'At capacity / long wait',
};

export function capacityBadgeClass(status: string | null | undefined): string {
  switch (status) {
    case 'busy':
      return 'text-red-600 border-red-300 dark:text-red-400';
    case 'moderate':
      return 'text-amber-600 border-amber-300 dark:text-amber-400';
    case 'available':
      return 'text-emerald-600 border-emerald-300 dark:text-emerald-400';
    default:
      return 'text-muted-foreground';
  }
}

export function CapacityStatusBadge({ status, id }: { status: string | null | undefined; id?: number }) {
  if (!status) return null;
  return (
    <Badge
      variant="outline"
      className={`${capacityBadgeClass(status)} gap-1`}
      data-testid={id != null ? `badge-capacity-status-${id}` : 'badge-capacity-status'}
    >
      <span className="relative flex h-2 w-2">
        <span className={`relative inline-flex rounded-full h-2 w-2 ${
          status === 'busy' ? 'bg-red-500' : status === 'moderate' ? 'bg-amber-500' : 'bg-emerald-500'
        }`} />
      </span>
      {status === 'busy' ? 'Busy' : status === 'moderate' ? 'Moderate' : 'Available'}
    </Badge>
  );
}

// ── Capacity controls card ───────────────────────────────────────────────────

function CapacityCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: cap, isLoading } = useGetCoopCapacity({
    query: { queryKey: getGetCoopCapacityQueryKey(), refetchInterval: 60_000 },
  });
  const [threshold, setThreshold] = useState<string | null>(null);

  const update = useUpdateCoopCapacity({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetCoopCapacityQueryKey() });
        toast({ title: 'Capacity settings updated' });
        setThreshold(null);
      },
      onError: () => toast({ title: 'Could not update capacity settings', variant: 'destructive' }),
    },
  });

  const flip = (manualStatus: CoopCapacityStatusStatus | null) =>
    update.mutate({ data: { manualStatus, overrideMinutes: manualStatus ? 240 : null } });

  const thresholdValue = threshold ?? (cap?.capacityThreshold != null ? String(cap.capacityThreshold) : '');

  return (
    <Card data-testid="card-coop-capacity">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Gauge className="w-4 h-4 text-primary" /> Live Capacity Status
        </CardTitle>
        <CardDescription>
          Broadcast how busy you are right now. Partners' customers see it on the network
          directory and your public booking page; your surge rules use it as a trigger.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading || !cap ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <>
            <div className="flex items-center gap-3 flex-wrap">
              <CapacityStatusBadge status={cap.status} />
              <span className="text-xs text-muted-foreground" data-testid="text-capacity-source">
                {cap.source === 'manual'
                  ? `Manual override${cap.overrideExpiresAt ? ` until ${new Date(cap.overrideExpiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}`
                  : `Automatic — live wait ${cap.waitMinutes} min, ${cap.appointmentsToday} booking${cap.appointmentsToday === 1 ? '' : 's'} today`}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {(['available', 'moderate', 'busy'] as const).map(s => (
                <Button
                  key={s}
                  size="sm"
                  variant={cap.manualStatus === s ? 'default' : 'outline'}
                  disabled={update.isPending}
                  onClick={() => flip(s)}
                  data-testid={`button-capacity-${s}`}
                >
                  {CAPACITY_LABEL[s]}
                </Button>
              ))}
              {cap.manualStatus && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={update.isPending}
                  onClick={() => flip(null)}
                  data-testid="button-capacity-auto"
                >
                  Back to automatic
                </Button>
              )}
            </div>
            <div className="flex items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="capacity-threshold" className="text-xs">
                  Daily capacity threshold (bookings)
                </Label>
                <Input
                  id="capacity-threshold"
                  type="number"
                  min={0}
                  className="h-9 w-40"
                  value={thresholdValue}
                  onChange={e => setThreshold(e.target.value)}
                  placeholder="e.g. 30"
                  data-testid="input-capacity-threshold"
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={update.isPending || threshold == null}
                onClick={() =>
                  update.mutate({
                    data: {
                      capacityThreshold:
                        threshold != null && threshold.trim() !== '' ? Number(threshold) : null,
                    },
                  })
                }
                data-testid="button-save-capacity-threshold"
              >
                Save
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Surge rules card ─────────────────────────────────────────────────────────

function ruleTriggerText(rule: CoopSurgeRule): string {
  const trigger =
    rule.triggerType === 'wait_minutes'
      ? `wait ≥ ${rule.waitThresholdMinutes ?? '?'} min`
      : 'at capacity';
  const window =
    rule.windowStartHour != null && rule.windowEndHour != null
      ? `, ${rule.windowStartHour}:00–${rule.windowEndHour}:00 only`
      : '';
  return `When ${trigger}: ${rule.baseDiscountPercent}% → ${rule.boostedDiscountPercent}% for ${rule.boostDurationMinutes} min${window}`;
}

function SurgeRulesCard({ tenantId, partnerships }: { tenantId: number; partnerships: CoopPartnership[] }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const { data: rules, isLoading } = useListCoopSurgeRules({
    query: { queryKey: getListCoopSurgeRulesQueryKey() },
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListCoopSurgeRulesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListCoopSurgeActivationsQueryKey() });
  };

  const patchRule = useUpdateCoopSurgeRule({
    mutation: {
      onSuccess: invalidate,
      onError: () => toast({ title: 'Could not update rule', variant: 'destructive' }),
    },
  });
  const deleteRule = useDeleteCoopSurgeRule({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: 'Rule deleted' });
      },
      onError: () => toast({ title: 'Could not delete rule', variant: 'destructive' }),
    },
  });

  // Only accepted, active partnerships can carry routing rules.
  const eligible = partnerships.filter(p => p.status === 'accepted' && p.isActive && !p.disputeSuspended && !p.bannedAt);

  return (
    <Card data-testid="card-surge-rules">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Zap className="w-4 h-4 text-primary" /> Traffic-Routing Rules
        </CardTitle>
        <CardDescription>
          When you hit peak times, automatically boost a partner's perk discount to route
          waiting customers their way — and revert when things calm down.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (rules ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-surge-rules-empty">
            No routing rules yet.
          </p>
        ) : (
          (rules ?? []).map(rule => (
            <div
              key={rule.id}
              className="border rounded-lg p-3 flex items-start justify-between gap-3"
              data-testid={`row-surge-rule-${rule.id}`}
            >
              <div className="min-w-0 space-y-0.5">
                <div className="text-sm font-medium flex items-center gap-2 flex-wrap">
                  Boost at {rule.partnerName}
                  {rule.liveBoostExpiresAt && (
                    <Badge variant="outline" className="text-orange-600 border-orange-300 gap-1" data-testid={`badge-rule-live-${rule.id}`}>
                      <Flame className="w-3 h-3" /> Live until{' '}
                      {new Date(rule.liveBoostExpiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">{ruleTriggerText(rule)}</div>
                <div className="text-xs text-muted-foreground italic truncate">Perk: {rule.perkTitle}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Switch
                  checked={rule.isActive}
                  disabled={patchRule.isPending}
                  onCheckedChange={v => patchRule.mutate({ id: rule.id, data: { isActive: v } })}
                  data-testid={`switch-surge-rule-${rule.id}`}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={deleteRule.isPending}
                  onClick={() => deleteRule.mutate({ id: rule.id })}
                  data-testid={`button-delete-surge-rule-${rule.id}`}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>
          ))
        )}
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={eligible.length === 0}
          onClick={() => setCreateOpen(true)}
          data-testid="button-add-surge-rule"
        >
          <Plus className="w-4 h-4" /> Add rule
        </Button>
        {eligible.length === 0 && (
          <p className="text-xs text-muted-foreground">
            You need an accepted, active partnership before you can add a routing rule.
          </p>
        )}
        {createOpen && (
          <CreateRuleDialog
            tenantId={tenantId}
            partnerships={eligible}
            onClose={() => setCreateOpen(false)}
            onCreated={() => {
              invalidate();
              setCreateOpen(false);
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

function CreateRuleDialog({
  tenantId, partnerships, onClose, onCreated,
}: {
  tenantId: number;
  partnerships: CoopPartnership[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { toast } = useToast();
  const [partnershipId, setPartnershipId] = useState<string>(partnerships[0] ? String(partnerships[0].id) : '');
  const [triggerType, setTriggerType] = useState<'wait_minutes' | 'at_capacity'>('wait_minutes');
  const [waitThreshold, setWaitThreshold] = useState('45');
  const [baseDiscount, setBaseDiscount] = useState('10');
  const [boostedDiscount, setBoostedDiscount] = useState('20');
  const [duration, setDuration] = useState('120');
  const [windowStart, setWindowStart] = useState('');
  const [windowEnd, setWindowEnd] = useState('');

  const create = useCreateCoopSurgeRule({
    mutation: {
      onSuccess: () => {
        toast({ title: 'Routing rule created' });
        onCreated();
      },
      onError: (err: unknown) => {
        const message =
          (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          'Could not create rule';
        toast({ title: message, variant: 'destructive' });
      },
    },
  });

  const partnerNameOf = (p: CoopPartnership) =>
    p.hostTenantId === tenantId ? p.partnerTenantName : p.hostTenantName;

  const submit = () => {
    create.mutate({
      data: {
        partnershipId: Number(partnershipId),
        triggerType,
        waitThresholdMinutes: triggerType === 'wait_minutes' ? Number(waitThreshold) : null,
        baseDiscountPercent: Number(baseDiscount),
        boostedDiscountPercent: Number(boostedDiscount),
        boostDurationMinutes: Number(duration),
        windowStartHour: windowStart.trim() === '' ? null : Number(windowStart),
        windowEndHour: windowEnd.trim() === '' ? null : Number(windowEnd),
      },
    });
  };

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent data-testid="dialog-create-surge-rule">
        <DialogHeader>
          <DialogTitle>New traffic-routing rule</DialogTitle>
          <DialogDescription>
            Boost a partner's perk discount automatically when you hit peak times.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Partner</Label>
            <Select value={partnershipId} onValueChange={setPartnershipId}>
              <SelectTrigger data-testid="select-surge-partnership">
                <SelectValue placeholder="Pick a partner" />
              </SelectTrigger>
              <SelectContent>
                {partnerships.map(p => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {partnerNameOf(p)} — {p.perkTitle}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Trigger</Label>
              <Select value={triggerType} onValueChange={v => setTriggerType(v as 'wait_minutes' | 'at_capacity')}>
                <SelectTrigger data-testid="select-surge-trigger">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="wait_minutes">Wait exceeds threshold</SelectItem>
                  <SelectItem value="at_capacity">At capacity (busy status)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {triggerType === 'wait_minutes' && (
              <div className="space-y-1">
                <Label className="text-xs">Wait threshold (min)</Label>
                <Input
                  type="number" min={5} value={waitThreshold}
                  onChange={e => setWaitThreshold(e.target.value)}
                  data-testid="input-surge-wait-threshold"
                />
              </div>
            )}
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Base discount %</Label>
              <Input type="number" min={0} max={100} value={baseDiscount} onChange={e => setBaseDiscount(e.target.value)} data-testid="input-surge-base-discount" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Boosted %</Label>
              <Input type="number" min={0} max={100} value={boostedDiscount} onChange={e => setBoostedDiscount(e.target.value)} data-testid="input-surge-boosted-discount" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Duration (min)</Label>
              <Input type="number" min={15} max={1440} value={duration} onChange={e => setDuration(e.target.value)} data-testid="input-surge-duration" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Only between hour (0–23, optional)</Label>
              <Input type="number" min={0} max={23} value={windowStart} onChange={e => setWindowStart(e.target.value)} placeholder="e.g. 13" data-testid="input-surge-window-start" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">and hour</Label>
              <Input type="number" min={0} max={23} value={windowEnd} onChange={e => setWindowEnd(e.target.value)} placeholder="e.g. 17" data-testid="input-surge-window-end" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={submit}
            disabled={create.isPending || partnershipId === ''}
            data-testid="button-create-surge-rule"
          >
            Create rule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Active boosts + history card ─────────────────────────────────────────────

const END_REASON_LABEL: Record<string, string> = {
  window_ended: 'window ended',
  normalized: 'wait normalized',
  rule_disabled: 'rule paused',
};

function SurgeActivationsCard() {
  const { data: activations, isLoading } = useListCoopSurgeActivations({
    query: { queryKey: getListCoopSurgeActivationsQueryKey(), refetchInterval: 60_000 },
  });
  const live = (activations ?? []).filter(a => a.isLive);
  const history = (activations ?? []).filter(a => !a.isLive);

  return (
    <Card data-testid="card-surge-activations">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="w-4 h-4 text-primary" /> Surge Boosts
        </CardTitle>
        <CardDescription>Currently boosted perks and recent activations.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <>
            {live.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-surge-no-live">
                No boosts are live right now.
              </p>
            ) : (
              <div className="space-y-2">
                {live.map(a => (
                  <div
                    key={a.id}
                    className="border border-orange-500/40 bg-orange-500/10 rounded-lg p-3 text-sm"
                    data-testid={`row-live-boost-${a.id}`}
                  >
                    <div className="font-medium flex items-center gap-1.5">
                      <Flame className="w-4 h-4 text-orange-600" /> {a.perkTitle} — with {a.partnerName}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {a.baseDiscountPercent}% → <span className="font-semibold text-orange-700 dark:text-orange-400">{a.boostedDiscountPercent}%</span>{' '}
                      until {new Date(a.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · {a.triggerReason}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {history.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                  <History className="w-3 h-3" /> Recent activity
                </div>
                {history.slice(0, 8).map(a => (
                  <div key={a.id} className="text-xs text-muted-foreground" data-testid={`row-boost-history-${a.id}`}>
                    {new Date(a.activatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} —{' '}
                    {a.perkTitle} boosted to {a.boostedDiscountPercent}%
                    {a.endReason ? ` (ended: ${END_REASON_LABEL[a.endReason] ?? a.endReason})` : ''}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Section export ───────────────────────────────────────────────────────────

export function CoopSurgeSection({
  tenantId, partnerships,
}: {
  tenantId: number;
  partnerships: CoopPartnership[];
}) {
  return (
    <div className="grid lg:grid-cols-2 gap-6 items-start" data-testid="section-coop-surge">
      <div className="space-y-6">
        <CapacityCard />
        <SurgeActivationsCard />
      </div>
      <SurgeRulesCard tenantId={tenantId} partnerships={partnerships} />
    </div>
  );
}
