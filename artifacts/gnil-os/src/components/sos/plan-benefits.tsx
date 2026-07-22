import React, { useState } from 'react';
import {
  useListSosPlans, useGetSosCustomerPlans, useSellSosPlan, useRenewSosCustomerPlan,
  useCancelSosCustomerPlan, getGetSosCustomerPlansQueryKey,
} from '@workspace/api-client-react';
import type { SosCustomerPlan } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { Crown, Package, Ticket, RefreshCw } from 'lucide-react';

export const PLAN_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  membership: Crown,
  package: Package,
  pass: Ticket,
};

export function planStatusBadgeClass(status: string): string {
  if (status === 'active') return 'text-emerald-700 border-emerald-200 bg-emerald-50';
  if (status === 'past_due') return 'text-amber-700 border-amber-200 bg-amber-50';
  return 'text-muted-foreground border-border bg-muted/50';
}

/** True when the enrollment can grant a benefit right now. */
export function isUsablePlan(p: SosCustomerPlan): boolean {
  if (p.status === 'cancelled') return false;
  if (p.planType === 'membership') return p.status === 'active';
  return (p.remainingCredits ?? 0) > 0;
}

export function planBenefitLabel(p: SosCustomerPlan): string {
  if (p.planType === 'membership') {
    return `${p.discountPercent ?? 0}% member discount`;
  }
  return `${p.remainingCredits ?? 0} credit${(p.remainingCredits ?? 0) === 1 ? '' : 's'} left`;
}

/**
 * Compact inline summary of a customer's active plans — used in booking
 * flows to surface membership status and remaining credits.
 */
export function CustomerPlanBadges({ customerId }: { customerId: number | null }) {
  const { data } = useGetSosCustomerPlans(customerId ?? 0, {
    query: {
      queryKey: getGetSosCustomerPlansQueryKey(customerId ?? 0),
      enabled: customerId != null && customerId > 0,
    },
  });
  if (customerId == null || !data) return null;
  const usable = data.plans.filter(isUsablePlan);
  if (usable.length === 0) {
    return <p className="text-xs text-muted-foreground">No active membership or credits for this customer.</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {usable.map(p => {
        const Icon = PLAN_ICONS[p.planType] ?? Crown;
        return (
          <Badge key={p.id} variant="outline" className="text-amber-700 border-amber-200 bg-amber-50 font-normal">
            <Icon className="w-3 h-3 mr-1" /> {p.planName} — {planBenefitLabel(p)}
          </Badge>
        );
      })}
    </div>
  );
}

/** Sell a plan (or renew an existing membership) for a customer. */
export function SellPlanDialog({
  customerId, customerName, open, onOpenChange,
}: {
  customerId: number;
  customerName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: catalog } = useListSosPlans();
  const { data: enrollments } = useGetSosCustomerPlans(customerId, {
    query: { queryKey: getGetSosCustomerPlansQueryKey(customerId), enabled: open },
  });
  const [planId, setPlanId] = useState('');
  const sell = useSellSosPlan();
  const renew = useRenewSosCustomerPlan();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const sellable = (catalog ?? []).filter(p => p.isActive);
  const renewable = (enrollments?.plans ?? []).filter(
    p => p.planType === 'membership' && p.status !== 'cancelled',
  );

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getGetSosCustomerPlansQueryKey(customerId) });
  };

  const handleSell = () => {
    sell.mutate(
      { data: { customerId, planId: parseInt(planId, 10) } },
      {
        onSuccess: (cp) => {
          refresh();
          toast({ title: 'Plan sold', description: `${cp.planName} added to ${customerName}.` });
          setPlanId('');
          onOpenChange(false);
        },
        onError: () => toast({ title: 'Could not sell plan', variant: 'destructive' }),
      },
    );
  };

  const handleRenew = (cp: SosCustomerPlan) => {
    renew.mutate(
      { id: cp.id },
      {
        onSuccess: (updated) => {
          refresh();
          toast({
            title: 'Membership renewed',
            description: `${updated.planName} renews ${updated.renewsAt ? new Date(updated.renewsAt).toLocaleDateString() : ''}.`,
          });
        },
        onError: () => toast({ title: 'Could not renew', variant: 'destructive' }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sell or Renew a Plan — {customerName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-5 py-2">
          <div className="space-y-2">
            <Label>Sell a plan</Label>
            <Select value={planId} onValueChange={setPlanId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a plan to sell..." />
              </SelectTrigger>
              <SelectContent>
                {sellable.map(p => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.name} — ${p.price.toFixed(2)}
                    {p.planType === 'membership'
                      ? `/${p.billingInterval === 'yearly' ? 'yr' : 'mo'} (${p.discountPercent}% off)`
                      : ` (${p.creditCount} credits)`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button className="w-full" disabled={!planId || sell.isPending} onClick={handleSell}>
              Record Sale & Attach to Customer
            </Button>
            {sellable.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No active plans in the catalog. Create plans under Memberships & Passes.
              </p>
            )}
          </div>

          {renewable.length > 0 && (
            <div className="space-y-2">
              <Label>Renew an existing membership</Label>
              {renewable.map(cp => (
                <div key={cp.id} className="flex items-center justify-between border rounded-md px-3 py-2 text-sm">
                  <div>
                    <div className="font-medium">{cp.planName}</div>
                    <div className="text-xs text-muted-foreground">
                      {cp.status === 'past_due' ? 'Past due' : 'Renews'}{' '}
                      {cp.renewsAt ? new Date(cp.renewsAt).toLocaleDateString() : '—'} • ${cp.price.toFixed(2)}
                    </div>
                  </div>
                  <Button size="sm" variant="outline" disabled={renew.isPending} onClick={() => handleRenew(cp)}>
                    <RefreshCw className="h-3.5 w-3.5 mr-1" /> Renew
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Cancel button for a plan enrollment (used on the customer profile). */
export function CancelPlanButton({ plan }: { plan: SosCustomerPlan }) {
  const cancel = useCancelSosCustomerPlan();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  if (plan.status === 'cancelled') return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      className="text-muted-foreground h-7 px-2 text-xs"
      disabled={cancel.isPending}
      onClick={() =>
        cancel.mutate(
          { id: plan.id },
          {
            onSuccess: () => {
              queryClient.invalidateQueries({ queryKey: getGetSosCustomerPlansQueryKey(plan.customerId) });
              toast({ title: 'Plan cancelled', description: plan.planName });
            },
          },
        )
      }
    >
      Cancel plan
    </Button>
  );
}
