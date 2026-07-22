import React, { useState } from 'react';
import {
  useListSosVisits, useAdvanceSosVisit, getListSosVisitsQueryKey,
  useGetSosCustomerPlans, getGetSosCustomerPlansQueryKey,
} from '@workspace/api-client-react';
import type { SosCustomerPlan } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Receipt, CheckCircle, Clock, Crown, BadgePercent } from 'lucide-react';
import {
  PLAN_ICONS, SellPlanDialog, isUsablePlan, planBenefitLabel,
} from '@/components/sos/plan-benefits';

type Benefit = { customerPlanId: number; type: 'redeem_credit' | 'membership_discount' };

export function PosPage() {
  const { data: visits } = useListSosVisits({ active: true });
  const advance = useAdvanceSosVisit();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const openTickets = visits?.filter(v => v.status === 'payment') || [];
  const inService = visits?.filter(v => v.status === 'in_service') || [];

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Point of Sale</h1>
        <p className="text-muted-foreground text-sm mt-1">Process payments and close out visits.</p>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <div className="space-y-4">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Receipt className="h-5 w-5 text-primary" /> Open Tickets
          </h2>
          {openTickets.length === 0 ? (
            <Card className="border-dashed bg-muted/20">
              <CardContent className="flex flex-col items-center justify-center h-32 text-muted-foreground text-sm">
                No open tickets waiting for payment.
              </CardContent>
            </Card>
          ) : (
            openTickets.map(ticket => (
              <TicketCard
                key={ticket.id}
                ticket={ticket}
                isPending={advance.isPending}
                onCheckout={(amount, benefit) => {
                  advance.mutate(
                    {
                      id: ticket.id,
                      data: {
                        action: 'check_out',
                        paymentAmount: amount,
                        ...(benefit
                          ? { benefitCustomerPlanId: benefit.customerPlanId, benefitType: benefit.type }
                          : {}),
                      },
                    },
                    {
                      onSuccess: () => {
                        queryClient.invalidateQueries({ queryKey: getListSosVisitsQueryKey({ active: true }) });
                        queryClient.invalidateQueries({ queryKey: getGetSosCustomerPlansQueryKey(ticket.customerId) });
                        toast({
                          title: 'Payment completed',
                          description: benefit?.type === 'redeem_credit'
                            ? `Checked out ${ticket.customerName} — 1 plan credit redeemed.`
                            : benefit
                              ? `Checked out ${ticket.customerName} — member discount applied.`
                              : `Checked out ${ticket.customerName}.`,
                        });
                      },
                      onError: (err: any) => {
                        toast({
                          title: 'Checkout failed',
                          description: err?.message ?? 'Could not apply the selected benefit.',
                          variant: 'destructive',
                        });
                      },
                    }
                  );
                }}
              />
            ))
          )}
        </div>

        <div className="space-y-4">
          <h2 className="text-xl font-semibold flex items-center gap-2 text-muted-foreground">
            <Clock className="h-5 w-5" /> In Service (Upcoming)
          </h2>
          {inService.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center border rounded-lg bg-card/50">
              No active services.
            </div>
          ) : (
            inService.map(visit => (
              <div key={visit.id} className="p-4 border rounded-lg bg-card/50 flex justify-between items-center opacity-70 grayscale">
                <div>
                  <div className="font-medium">{visit.customerName}</div>
                  <div className="text-xs">{visit.serviceType}</div>
                </div>
                <div className="text-xs uppercase font-bold tracking-wide">In Service</div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function TicketCard({
  ticket, onCheckout, isPending,
}: {
  ticket: any;
  onCheckout: (amt: number, benefit: Benefit | null) => void;
  isPending: boolean;
}) {
  const [amount, setAmount] = useState(ticket.paymentAmount?.toString() || "");
  const [benefit, setBenefit] = useState<Benefit | null>(null);
  const [sellOpen, setSellOpen] = useState(false);

  const { data: planData } = useGetSosCustomerPlans(ticket.customerId, {
    query: { queryKey: getGetSosCustomerPlansQueryKey(ticket.customerId) },
  });
  const usable = (planData?.plans ?? []).filter(isUsablePlan);
  const selected = usable.find(p => p.id === benefit?.customerPlanId) ?? null;

  const base = parseFloat(amount || '0');
  const due =
    benefit?.type === 'redeem_credit'
      ? 0
      : benefit?.type === 'membership_discount' && selected
        ? Math.max(0, base * (1 - (selected.discountPercent ?? 0) / 100))
        : base;

  const toggleBenefit = (p: SosCustomerPlan) => {
    const type: Benefit['type'] = p.planType === 'membership' ? 'membership_discount' : 'redeem_credit';
    setBenefit(prev =>
      prev?.customerPlanId === p.id ? null : { customerPlanId: p.id, type },
    );
  };

  return (
    <Card className="border-primary/20 shadow-md">
      <CardContent className="p-5 flex flex-col gap-4">
        <div className="flex justify-between items-start">
          <div>
            <h3 className="font-bold text-lg">{ticket.customerName}</h3>
            <p className="text-sm text-muted-foreground">{ticket.serviceType} • {ticket.resourceName || 'No resource'}</p>
          </div>
          <div className="text-right">
            <div className="text-xs text-muted-foreground">Total Due</div>
            <div className="text-2xl font-bold">${due.toFixed(2)}</div>
            {benefit && due !== base && (
              <div className="text-xs text-muted-foreground line-through">${base.toFixed(2)}</div>
            )}
          </div>
        </div>

        {/* Active plan benefits for this customer */}
        <div className="border rounded-md p-3 bg-muted/20 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
              <Crown className="w-3.5 h-3.5 text-amber-600" /> Plan Benefits
            </span>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setSellOpen(true)}>
              Sell / Renew Plan
            </Button>
          </div>
          {usable.length === 0 ? (
            <p className="text-xs text-muted-foreground">No active membership or credits.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {usable.map(p => {
                const Icon = PLAN_ICONS[p.planType] ?? Crown;
                const active = benefit?.customerPlanId === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => toggleBenefit(p)}
                    className={`inline-flex items-center gap-1.5 px-2 py-1 rounded border text-xs font-medium transition-colors ${
                      active
                        ? 'bg-amber-100 border-amber-400 text-amber-900'
                        : 'bg-background border-border text-muted-foreground hover:border-amber-300'
                    }`}
                  >
                    <Icon className="w-3 h-3" /> {p.planName} — {planBenefitLabel(p)}
                    {active && <CheckCircle className="w-3 h-3" />}
                  </button>
                );
              })}
            </div>
          )}
          {benefit && selected && (
            <Badge variant="outline" className="text-amber-700 border-amber-200 bg-amber-50 font-normal">
              <BadgePercent className="w-3 h-3 mr-1" />
              {benefit.type === 'redeem_credit'
                ? `Paying with 1 credit from ${selected.planName}`
                : `${selected.discountPercent}% member discount will be applied`}
            </Badge>
          )}
        </div>

        <div className="flex gap-4 items-end border-t pt-4">
          <div className="space-y-1.5 flex-1">
            <Label>Service Amount</Label>
            <div className="relative">
              <span className="absolute left-3 top-2.5 text-muted-foreground">$</span>
              <Input
                type="number"
                className="pl-7 font-medium"
                value={amount}
                onChange={e => setAmount(e.target.value)}
              />
            </div>
          </div>
          <Button
            size="lg"
            className="w-1/2"
            disabled={isPending || (benefit?.type === 'redeem_credit' ? false : (!amount || base <= 0))}
            onClick={() => onCheckout(due, benefit)}
          >
            <CheckCircle className="mr-2 h-4 w-4" />
            {benefit?.type === 'redeem_credit' ? 'Redeem Credit & Complete' : 'Charge & Complete'}
          </Button>
        </div>
      </CardContent>

      <SellPlanDialog
        customerId={ticket.customerId}
        customerName={ticket.customerName}
        open={sellOpen}
        onOpenChange={setSellOpen}
      />
    </Card>
  );
}
