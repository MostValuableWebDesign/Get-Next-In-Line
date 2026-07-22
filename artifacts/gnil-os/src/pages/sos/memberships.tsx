import React, { useState } from 'react';
import {
  useListSosPlans, useCreateSosPlan, useUpdateSosPlan, getListSosPlansQueryKey,
} from '@workspace/api-client-react';
import type { SosPlan } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Plus, Crown, Package, Ticket, Pencil } from 'lucide-react';

const PLAN_TYPE_META: Record<
  string,
  { label: string; icon: React.ComponentType<{ className?: string }>; badgeClass: string }
> = {
  membership: { label: 'Membership', icon: Crown, badgeClass: 'text-amber-700 border-amber-200 bg-amber-50' },
  package: { label: 'Package', icon: Package, badgeClass: 'text-sky-700 border-sky-200 bg-sky-50' },
  pass: { label: 'Credit Pass', icon: Ticket, badgeClass: 'text-violet-700 border-violet-200 bg-violet-50' },
};

function planBenefitSummary(p: {
  planType: string; discountPercent?: number | null; creditCount?: number | null; billingInterval?: string | null; price: number;
}): string {
  if (p.planType === 'membership') {
    return `${p.discountPercent ?? 0}% off every visit • $${p.price.toFixed(2)}/${p.billingInterval === 'yearly' ? 'yr' : 'mo'}`;
  }
  return `${p.creditCount ?? 0} prepaid service credits • $${p.price.toFixed(2)} one-time`;
}

/**
 * Membership plan management content — rendered as the "Membership Plans"
 * tab on the Customers page (the old standalone /sos/memberships page
 * redirects there).
 */
export function MembershipPlansContent() {
  const { data: plans } = useListSosPlans();
  const [editing, setEditing] = useState<SosPlan | null>(null);

  const groups: [string, SosPlan[]][] = ['membership', 'package', 'pass'].map(t => [
    t,
    (plans ?? []).filter(p => p.planType === t),
  ]);

  return (
    <div className="space-y-6" data-testid="membership-plans-content">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Memberships & Passes</h2>
          <p className="text-muted-foreground text-sm mt-1">
            Plans your business sells — recurring memberships, prepaid packages, and loyalty credit passes.
          </p>
        </div>
        <PlanDialog />
      </div>

      {groups.map(([type, list]) => {
        const meta = PLAN_TYPE_META[type];
        const Icon = meta.icon;
        return (
          <div key={type} className="space-y-3">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Icon className="h-5 w-5 text-primary" /> {meta.label}s
            </h2>
            {list.length === 0 ? (
              <Card className="border-dashed bg-muted/20">
                <CardContent className="flex items-center justify-center h-20 text-muted-foreground text-sm">
                  No {meta.label.toLowerCase()} plans yet.
                </CardContent>
              </Card>
            ) : (
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                {list.map(plan => (
                  <PlanCard key={plan.id} plan={plan} onEdit={() => setEditing(plan)} />
                ))}
              </div>
            )}
          </div>
        );
      })}

      {editing && <PlanDialog plan={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function PlanCard({ plan, onEdit }: { plan: SosPlan; onEdit: () => void }) {
  const meta = PLAN_TYPE_META[plan.planType];
  const update = useUpdateSosPlan();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const toggleActive = () => {
    update.mutate(
      { id: plan.id, data: { isActive: !plan.isActive } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSosPlansQueryKey() });
          toast({ title: plan.isActive ? 'Plan deactivated' : 'Plan reactivated', description: plan.name });
        },
      },
    );
  };

  return (
    <Card className={plan.isActive ? '' : 'opacity-60'}>
      <CardContent className="p-4 space-y-3">
        <div className="flex justify-between items-start gap-2">
          <div className="min-w-0">
            <div className="font-semibold truncate">{plan.name}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{planBenefitSummary(plan)}</div>
          </div>
          <Badge variant="outline" className={`shrink-0 ${meta.badgeClass}`}>{meta.label}</Badge>
        </div>
        {plan.description && (
          <p className="text-sm text-muted-foreground line-clamp-2">{plan.description}</p>
        )}
        <div className="flex items-center justify-between border-t pt-3">
          <span className={`text-xs font-medium ${plan.isActive ? 'text-emerald-600' : 'text-muted-foreground'}`}>
            {plan.isActive ? 'Active — available to sell' : 'Inactive'}
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={onEdit}>
              <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
            </Button>
            <Button size="sm" variant="outline" onClick={toggleActive} disabled={update.isPending}>
              {plan.isActive ? 'Deactivate' : 'Reactivate'}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** Create (no `plan`) or edit (with `plan`) a plan definition. */
function PlanDialog({ plan, onClose }: { plan?: SosPlan; onClose?: () => void }) {
  const isEdit = plan != null;
  const [open, setOpen] = useState(isEdit);
  const [name, setName] = useState(plan?.name ?? '');
  const [planType, setPlanType] = useState<string>(plan?.planType ?? 'membership');
  const [description, setDescription] = useState(plan?.description ?? '');
  const [price, setPrice] = useState(plan?.price?.toString() ?? '');
  const [billingInterval, setBillingInterval] = useState<string>(plan?.billingInterval ?? 'monthly');
  const [discountPercent, setDiscountPercent] = useState(plan?.discountPercent?.toString() ?? '');
  const [creditCount, setCreditCount] = useState(plan?.creditCount?.toString() ?? '');

  const create = useCreateSosPlan();
  const update = useUpdateSosPlan();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const close = () => { setOpen(false); onClose?.(); };

  const isMembership = planType === 'membership';
  const valid =
    name.trim().length > 0 &&
    price !== '' && parseFloat(price) >= 0 &&
    (isMembership
      ? discountPercent !== '' && +discountPercent >= 0 && +discountPercent <= 100
      : creditCount !== '' && +creditCount >= 1);

  const handleSave = () => {
    const onSuccess = () => {
      queryClient.invalidateQueries({ queryKey: getListSosPlansQueryKey() });
      toast({ title: isEdit ? 'Plan updated' : 'Plan created', description: name });
      close();
    };
    if (isEdit) {
      update.mutate(
        {
          id: plan.id,
          data: {
            name,
            description,
            price: parseFloat(price),
            ...(isMembership
              ? { billingInterval: billingInterval as 'monthly' | 'yearly', discountPercent: parseInt(discountPercent, 10) }
              : { creditCount: parseInt(creditCount, 10) }),
          },
        },
        { onSuccess },
      );
    } else {
      create.mutate(
        {
          data: {
            name,
            planType: planType as 'membership' | 'package' | 'pass',
            description: description || undefined,
            price: parseFloat(price),
            ...(isMembership
              ? { billingInterval: billingInterval as 'monthly' | 'yearly', discountPercent: parseInt(discountPercent, 10) }
              : { creditCount: parseInt(creditCount, 10) }),
          },
        },
        { onSuccess },
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) onClose?.(); }}>
      {!isEdit && (
        <DialogTrigger asChild>
          <Button><Plus className="mr-2 h-4 w-4" /> New Plan</Button>
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit ${plan.name}` : 'New Plan'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          {!isEdit && (
            <div className="space-y-2">
              <Label>Plan Type</Label>
              <Select value={planType} onValueChange={setPlanType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="membership">Membership — recurring discount</SelectItem>
                  <SelectItem value="package">Package — one-time bundle of credits</SelectItem>
                  <SelectItem value="pass">Credit Pass — loyalty credits</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-2">
            <Label>Name *</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder={isMembership ? 'Gold Membership' : '5-Visit Package'} />
          </div>
          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea rows={2} value={description} onChange={e => setDescription(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{isMembership ? 'Price per billing period *' : 'One-time price *'}</Label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-muted-foreground">$</span>
                <Input type="number" min="0" step="0.01" className="pl-7" value={price} onChange={e => setPrice(e.target.value)} />
              </div>
            </div>
            {isMembership ? (
              <div className="space-y-2">
                <Label>Billing Interval</Label>
                <Select value={billingInterval ?? 'monthly'} onValueChange={setBillingInterval}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="yearly">Yearly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="space-y-2">
                <Label>Service Credits *</Label>
                <Input type="number" min="1" value={creditCount} onChange={e => setCreditCount(e.target.value)} />
              </div>
            )}
          </div>
          {isMembership && (
            <div className="space-y-2">
              <Label>Discount % applied at checkout *</Label>
              <Input type="number" min="0" max="100" value={discountPercent} onChange={e => setDiscountPercent(e.target.value)} />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>Cancel</Button>
          <Button onClick={handleSave} disabled={!valid || create.isPending || update.isPending}>
            {isEdit ? 'Save Changes' : 'Create Plan'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
