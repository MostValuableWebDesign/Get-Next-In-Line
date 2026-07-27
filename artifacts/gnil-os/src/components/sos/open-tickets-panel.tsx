import React, { useState } from 'react';
import {
  useListSosVisits, useAdvanceSosVisit, getListSosVisitsQueryKey,
  useGetSosCustomerPlans, getGetSosCustomerPlansQueryKey,
  useListSosStaff,
} from '@workspace/api-client-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { SosCustomerPlan } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { CheckCircle, Crown, BadgePercent } from 'lucide-react';
import {
  PLAN_ICONS, SellPlanDialog, isUsablePlan, planBenefitLabel,
} from '@/components/sos/plan-benefits';
import { usePartnerPerks, PartnerPerksBlock } from '@/components/sos/partner-perks';
import type { CoopActivePerk, CoopFlashPerk } from '@workspace/api-client-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Printer } from 'lucide-react';

type Benefit = { customerPlanId: number; type: 'redeem_credit' | 'membership_discount' };

/**
 * Open Tickets ("awaiting payment") panel — the single place tickets are
 * checked out. Lives on the Business Bookings page; other pages (e.g. POS)
 * link here instead of duplicating it.
 */
export function OpenTicketsPanel() {
  const { data: visits } = useListSosVisits({ active: true });
  const advance = useAdvanceSosVisit();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  // Live co-op partner perks — deployed automatically while a partnership is
  // accepted and active; disappear the moment it's deactivated or declined.
  const { perks, flashPerks, disclaimer } = usePartnerPerks();
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);

  const openTickets = visits?.filter(v => v.status === 'payment') || [];

  if (openTickets.length === 0) {
    return (
      <Card className="border-dashed bg-muted/20">
        <CardContent className="flex flex-col items-center justify-center h-32 text-muted-foreground text-sm">
          No open tickets waiting for payment.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {openTickets.map(ticket => (
        <TicketCard
          key={ticket.id}
          ticket={ticket}
          perks={perks}
          flashPerks={flashPerks}
          disclaimer={disclaimer}
          isPending={advance.isPending}
          onCheckout={(amount, benefit, staffId) => {
            advance.mutate(
              {
                id: ticket.id,
                data: {
                  action: 'check_out',
                  paymentAmount: amount,
                  ...(staffId != null ? { staffId } : {}),
                  ...(benefit
                    ? { benefitCustomerPlanId: benefit.customerPlanId, benefitType: benefit.type }
                    : {}),
                },
              },
              {
                onSuccess: () => {
                  queryClient.invalidateQueries({ queryKey: getListSosVisitsQueryKey({ active: true }) });
                  queryClient.invalidateQueries({ queryKey: getGetSosCustomerPlansQueryKey(ticket.customerId) });
                  setReceipt({
                    customerName: ticket.customerName,
                    serviceType: ticket.serviceType,
                    amount,
                  });
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
      ))}
      <ReceiptDialog receipt={receipt} perks={perks} flashPerks={flashPerks} disclaimer={disclaimer} onClose={() => setReceipt(null)} />
    </div>
  );
}

type ReceiptData = { customerName: string; serviceType: string; amount: number };

/**
 * Post-checkout receipt (printable). Partner perks from active co-op
 * partnerships are printed on every receipt automatically.
 */
function ReceiptDialog({
  receipt, perks, flashPerks, disclaimer, onClose,
}: {
  receipt: ReceiptData | null;
  perks: CoopActivePerk[];
  flashPerks: CoopFlashPerk[];
  disclaimer: string | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={receipt != null} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent data-testid="dialog-receipt">
        <DialogHeader>
          <DialogTitle>Receipt</DialogTitle>
          <DialogDescription>Payment completed — print or close.</DialogDescription>
        </DialogHeader>
        {receipt && (
          <div className="space-y-3 text-sm" data-testid="receipt-body">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Customer</span>
              <span className="font-medium">{receipt.customerName}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Service</span>
              <span>{receipt.serviceType}</span>
            </div>
            <div className="flex justify-between border-t pt-2">
              <span className="text-muted-foreground">Total paid</span>
              <span className="font-bold">${receipt.amount.toFixed(2)}</span>
            </div>
            <PartnerPerksBlock perks={perks} flashPerks={flashPerks} disclaimer={disclaimer} staffFacing title="Your Partner Perks" />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="button-close-receipt">Close</Button>
          <Button onClick={() => window.print()} className="gap-2" data-testid="button-print-receipt">
            <Printer className="w-4 h-4" /> Print
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TicketCard({
  ticket, perks, flashPerks, disclaimer, onCheckout, isPending,
}: {
  ticket: any;
  perks: CoopActivePerk[];
  flashPerks: CoopFlashPerk[];
  disclaimer: string | null;
  onCheckout: (amt: number, benefit: Benefit | null, staffId: number | null) => void;
  isPending: boolean;
}) {
  const [amount, setAmount] = useState(ticket.paymentAmount?.toString() || "");
  const [benefit, setBenefit] = useState<Benefit | null>(null);
  const [sellOpen, setSellOpen] = useState(false);
  // Optional staff attribution — drives per-staff earnings reporting.
  const [staffId, setStaffId] = useState<string>(ticket.staffId?.toString() ?? '');
  const { data: staff } = useListSosStaff();
  const activeStaff = staff?.filter(s => s.isActive) ?? [];

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

        {/* Co-op partner perks — staff-facing (includes redemption codes) */}
        <PartnerPerksBlock perks={perks} flashPerks={flashPerks} disclaimer={disclaimer} staffFacing />

        {activeStaff.length > 0 && (
          <div className="space-y-1.5">
            <Label>Performed By (optional)</Label>
            <Select value={staffId} onValueChange={setStaffId}>
              <SelectTrigger data-testid={`select-checkout-staff-${ticket.id}`}>
                <SelectValue placeholder="Attribute to a staff member..." />
              </SelectTrigger>
              <SelectContent>
                {activeStaff.map(s => (
                  <SelectItem key={s.id} value={s.id.toString()}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

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
            onClick={() => onCheckout(due, benefit, staffId ? Number(staffId) : null)}
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
