import { useMemo, useState } from 'react';
import {
  useGetCoopWallet, getGetCoopWalletQueryKey,
  useListCoopBoosts, getListCoopBoostsQueryKey,
  useListCoopSponsorshipSlots, getListCoopSponsorshipSlotsQueryKey,
  useCreateCoopBoost,
  useUpdateCoopPartnership, getListCoopPartnershipsQueryKey,
  type CoopPartnership, type CoopFeaturedBoost, type CoopWalletEntry,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Gavel, Megaphone, Percent, Sparkles, Wallet } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Sponsorship Hub — paid featured placement + internal earnings wallet.
//
// Merchants can buy a flat-fee "Featured Spot" (first come, first served) or
// bid in an auction for a slot window; the platform settles auctions
// automatically when the window opens. Earnings from revenue-share
// partnerships accrue in an internal wallet; payouts are processed by the
// platform operators. No real money moves here — it is an accounting record.
// ─────────────────────────────────────────────────────────────────────────────

const SURFACE_LABELS: Record<string, string> = {
  discovery: 'Local Discovery feed',
  booking_confirmation: 'Booking confirmation screen',
};

const ENTRY_LABELS: Record<string, string> = {
  redemption_earning: 'Referral earning',
  redemption_charge: 'Referral share paid',
  boost_purchase: 'Featured Spot purchase',
  payout: 'Payout processed',
};

const money = (n: number) =>
  n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });

function fmtWindow(startsAt: string, endsAt: string): string {
  const s = new Date(startsAt);
  const e = new Date(endsAt);
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  return `${s.toLocaleString(undefined, opts)} → ${e.toLocaleString(undefined, opts)}`;
}

const BOOST_STATUS_STYLES: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-700 border-emerald-300',
  pending: 'bg-amber-100 text-amber-700 border-amber-300',
  lost: 'bg-muted text-muted-foreground',
  expired: 'bg-muted text-muted-foreground',
};

export function SponsorshipHub({
  tenantId,
  partnerships,
}: {
  tenantId: number;
  partnerships: CoopPartnership[];
}) {
  return (
    <div className="grid lg:grid-cols-2 gap-6 items-start" data-testid="sponsorship-hub">
      <div className="space-y-6">
        <FeaturedSpotsCard tenantId={tenantId} partnerships={partnerships} />
        <RevenueShareCard tenantId={tenantId} partnerships={partnerships} />
      </div>
      <WalletCard />
    </div>
  );
}

// ── Featured Spots (boosts + auction bids) ───────────────────────────────────

function FeaturedSpotsCard({
  tenantId,
  partnerships,
}: {
  tenantId: number;
  partnerships: CoopPartnership[];
}) {
  const { data: slots, isLoading: slotsLoading } = useListCoopSponsorshipSlots({
    query: { queryKey: getListCoopSponsorshipSlotsQueryKey() },
  });
  const { data: boosts, isLoading: boostsLoading } = useListCoopBoosts({
    query: { queryKey: getListCoopBoostsQueryKey() },
  });
  const [buying, setBuying] = useState(false);

  return (
    <Card data-testid="card-featured-spots">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Megaphone className="w-4 h-4 text-primary" /> Featured Spots
            </CardTitle>
            <CardDescription>
              Put one of your partner perks in the highlighted featured slot — buy a window
              outright or outbid other businesses at auction. Expired boosts fall back to
              organic placement automatically.
            </CardDescription>
          </div>
          <Button size="sm" className="gap-2" onClick={() => setBuying(true)} data-testid="button-buy-boost">
            <Sparkles className="w-4 h-4" /> Feature a Perk
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {slotsLoading ? (
          <Skeleton className="h-16 w-full rounded-lg" />
        ) : (
          <div className="grid sm:grid-cols-2 gap-2">
            {(slots?.slots ?? []).map(slot => (
              <div key={slot.surface} className="border rounded-lg p-3 text-sm" data-testid={`slot-${slot.surface}`}>
                <div className="font-medium">{SURFACE_LABELS[slot.surface] ?? slot.surface}</div>
                {slot.activeBoost ? (
                  <div className="text-xs text-muted-foreground mt-1">
                    Featured now: <span className="font-medium text-foreground">"{slot.activeBoost.perkTitle}"</span>
                    <br />until {new Date(slot.activeBoost.endsAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground mt-1">Slot open — no active boost</div>
                )}
                {slot.pendingWindows.length > 0 && (
                  <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                    <Gavel className="w-3 h-3" />
                    {slot.pendingWindows.length} upcoming auction{slot.pendingWindows.length === 1 ? '' : 's'} — high bid {money(Math.max(...slot.pendingWindows.map(w => w.highBid)))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {boostsLoading ? (
          <Skeleton className="h-12 w-full rounded-lg" />
        ) : (boosts ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-boosts">
            You haven't sponsored a featured spot yet.
          </p>
        ) : (
          <div className="space-y-2">
            {(boosts ?? []).map(b => (
              <BoostRow key={b.id} boost={b} />
            ))}
          </div>
        )}
      </CardContent>
      <BuyBoostDialog
        tenantId={tenantId}
        partnerships={partnerships}
        open={buying}
        onClose={() => setBuying(false)}
      />
    </Card>
  );
}

function BoostRow({ boost }: { boost: CoopFeaturedBoost }) {
  return (
    <div className="border rounded-lg p-3 flex items-center justify-between gap-3 text-sm" data-testid={`row-boost-${boost.id}`}>
      <div className="min-w-0">
        <div className="font-medium truncate">"{boost.perkTitle}" · {SURFACE_LABELS[boost.surface] ?? boost.surface}</div>
        <div className="text-xs text-muted-foreground mt-0.5">
          {boost.pricingType === 'bid' ? 'Auction bid' : 'Flat fee'} · {money(boost.amount)} · {fmtWindow(boost.startsAt, boost.endsAt)}
        </div>
      </div>
      <Badge variant="outline" className={`shrink-0 capitalize ${BOOST_STATUS_STYLES[boost.status] ?? ''}`} data-testid={`badge-boost-status-${boost.id}`}>
        {boost.status === 'lost' ? 'Outbid' : boost.status}
      </Badge>
    </div>
  );
}

function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function BuyBoostDialog({
  tenantId,
  partnerships,
  open,
  onClose,
}: {
  tenantId: number;
  partnerships: CoopPartnership[];
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const eligible = useMemo(
    () => partnerships.filter(p => p.status === 'accepted' && p.isActive && p.bannedAt == null),
    [partnerships],
  );
  const [partnershipId, setPartnershipId] = useState<string>('');
  const [surface, setSurface] = useState<'discovery' | 'booking_confirmation'>('discovery');
  const [pricingType, setPricingType] = useState<'flat' | 'bid'>('flat');
  const [amount, setAmount] = useState('25');
  const [startsAt, setStartsAt] = useState(() => toLocalInputValue(new Date(Date.now() + 60 * 60_000)));
  const [endsAt, setEndsAt] = useState(() => toLocalInputValue(new Date(Date.now() + 3 * 24 * 60 * 60_000)));

  const create = useCreateCoopBoost({
    mutation: {
      onSuccess: (boost) => {
        toast({
          title: boost.pricingType === 'bid' ? 'Bid placed' : 'Featured Spot purchased',
          description:
            boost.pricingType === 'bid'
              ? 'The auction settles automatically when the window opens — highest bid wins.'
              : boost.status === 'active'
                ? 'Your perk is featured now.'
                : 'Your featured window is reserved.',
        });
        queryClient.invalidateQueries({
          predicate: q => typeof q.queryKey[0] === 'string' && q.queryKey[0].includes('/api/coop/'),
        });
        onClose();
      },
      onError: (err: unknown) => {
        const message =
          (err as { data?: { message?: string } })?.data?.message ??
          'Could not create the boost. Check the window and amount.';
        toast({ title: 'Boost failed', description: message, variant: 'destructive' });
      },
    },
  });

  const submit = () => {
    const amt = parseFloat(amount);
    if (!partnershipId || !(amt > 0)) {
      toast({ title: 'Pick a perk and a positive amount', variant: 'destructive' });
      return;
    }
    create.mutate({
      data: {
        partnershipId: Number(partnershipId),
        surface,
        pricingType,
        amount: amt,
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent data-testid="dialog-buy-boost">
        <DialogHeader>
          <DialogTitle>Feature a Perk</DialogTitle>
          <DialogDescription>
            Featured perks render highlighted above organic matches on the chosen surface for the
            window you pick. Flat purchases reserve the slot immediately; auction bids compete —
            highest bid wins when the window opens.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Partnership perk</Label>
            <Select value={partnershipId} onValueChange={setPartnershipId}>
              <SelectTrigger data-testid="select-boost-partnership">
                <SelectValue placeholder="Choose an active partnership" />
              </SelectTrigger>
              <SelectContent>
                {eligible.map(p => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    "{p.perkTitle}" — with {p.hostTenantId === tenantId ? p.partnerTenantName : p.hostTenantName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Surface</Label>
              <Select value={surface} onValueChange={v => setSurface(v as typeof surface)}>
                <SelectTrigger data-testid="select-boost-surface"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="discovery">Local Discovery feed</SelectItem>
                  <SelectItem value="booking_confirmation">Booking confirmation</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Pricing</Label>
              <Select value={pricingType} onValueChange={v => setPricingType(v as typeof pricingType)}>
                <SelectTrigger data-testid="select-boost-pricing"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="flat">Flat fee (instant)</SelectItem>
                  <SelectItem value="bid">Auction bid</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{pricingType === 'bid' ? 'Bid amount ($)' : 'Price ($)'}</Label>
            <Input
              type="number" min="1" step="0.01" value={amount}
              onChange={e => setAmount(e.target.value)}
              data-testid="input-boost-amount"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Starts</Label>
              <Input type="datetime-local" value={startsAt} onChange={e => setStartsAt(e.target.value)} data-testid="input-boost-starts" />
            </div>
            <div className="space-y-1.5">
              <Label>Ends</Label>
              <Input type="datetime-local" value={endsAt} onChange={e => setEndsAt(e.target.value)} data-testid="input-boost-ends" />
            </div>
          </div>
          {pricingType === 'bid' && (
            <p className="text-xs text-muted-foreground">
              Bids need a future start time. You're only charged if you win the auction.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={create.isPending} data-testid="button-submit-boost">
            {create.isPending ? 'Submitting…' : pricingType === 'bid' ? 'Place Bid' : 'Buy Featured Spot'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Revenue-share terms per partnership ──────────────────────────────────────

function RevenueShareCard({
  tenantId,
  partnerships,
}: {
  tenantId: number;
  partnerships: CoopPartnership[];
}) {
  const eligible = useMemo(
    () => partnerships.filter(p => p.status === 'accepted' && p.bannedAt == null),
    [partnerships],
  );
  const [editing, setEditing] = useState<CoopPartnership | null>(null);
  return (
    <Card data-testid="card-revenue-share">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Percent className="w-4 h-4 text-primary" /> Revenue-Share Terms
        </CardTitle>
        <CardDescription>
          Add a referral bounty or percentage split to a partnership — every perk redemption is
          then settled automatically into both wallets, net of the platform fee.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {eligible.length === 0 ? (
          <p className="text-sm text-muted-foreground">No accepted partnerships yet.</p>
        ) : (
          eligible.map(p => (
            <div key={p.id} className="border rounded-lg p-3 flex items-center justify-between gap-3 text-sm" data-testid={`row-revshare-${p.id}`}>
              <div className="min-w-0">
                <div className="font-medium truncate">"{p.perkTitle}"</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {p.revenueShareKind == null
                    ? 'No revenue share — classic mutual perk'
                    : p.revenueShareKind === 'bounty'
                      ? `${money(p.revenueShareValue ?? 0)} bounty per redemption`
                      : `${p.revenueShareValue}% of ${money(p.revenueShareBaseAmount ?? 0)} per redemption`}
                </div>
              </div>
              <Button size="sm" variant="outline" className="shrink-0" onClick={() => setEditing(p)} data-testid={`button-edit-revshare-${p.id}`}>
                {p.revenueShareKind == null ? 'Add Terms' : 'Edit Terms'}
              </Button>
            </div>
          ))
        )}
      </CardContent>
      <RevenueShareDialog tenantId={tenantId} partnership={editing} onClose={() => setEditing(null)} />
    </Card>
  );
}

function RevenueShareDialog({
  tenantId,
  partnership,
  onClose,
}: {
  tenantId: number;
  partnership: CoopPartnership | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<'none' | 'bounty' | 'percent'>('none');
  const [value, setValue] = useState('10');
  const [base, setBase] = useState('50');
  const [openedFor, setOpenedFor] = useState<number | null>(null);
  if (partnership && openedFor !== partnership.id) {
    setOpenedFor(partnership.id);
    setKind(partnership.revenueShareKind ?? 'none');
    setValue(String(partnership.revenueShareValue ?? 10));
    setBase(String(partnership.revenueShareBaseAmount ?? 50));
  }

  const update = useUpdateCoopPartnership({
    mutation: {
      onSuccess: () => {
        toast({ title: 'Revenue-share terms saved' });
        queryClient.invalidateQueries({ queryKey: getListCoopPartnershipsQueryKey({ tenantId }) });
        queryClient.invalidateQueries({
          predicate: q => typeof q.queryKey[0] === 'string' && q.queryKey[0].includes('/api/coop/'),
        });
        onClose();
      },
      onError: (err: unknown) => {
        const message =
          (err as { data?: { message?: string } })?.data?.message ?? 'Could not save the terms.';
        toast({ title: 'Save failed', description: message, variant: 'destructive' });
      },
    },
  });

  const submit = () => {
    if (!partnership) return;
    const v = parseFloat(value);
    const b = parseFloat(base);
    update.mutate({
      id: partnership.id,
      data:
        kind === 'none'
          ? { revenueShareKind: null }
          : kind === 'bounty'
            ? { revenueShareKind: 'bounty', revenueShareValue: v }
            : { revenueShareKind: 'percent', revenueShareValue: v, revenueShareBaseAmount: b },
    });
  };

  return (
    <Dialog open={partnership != null} onOpenChange={o => { if (!o) { setOpenedFor(null); onClose(); } }}>
      <DialogContent data-testid="dialog-revenue-share">
        <DialogHeader>
          <DialogTitle>Revenue-Share Terms</DialogTitle>
          <DialogDescription>
            "{partnership?.perkTitle}" — when a referred customer redeems this perk, the redeeming
            business automatically pays the referring partner. The platform fee is deducted from
            the earning.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Split type</Label>
            <Select value={kind} onValueChange={v => setKind(v as typeof kind)}>
              <SelectTrigger data-testid="select-revshare-kind"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No revenue share</SelectItem>
                <SelectItem value="bounty">Flat referral bounty</SelectItem>
                <SelectItem value="percent">Percentage split</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {kind !== 'none' && (
            <div className="space-y-1.5">
              <Label>{kind === 'bounty' ? 'Bounty per redemption ($)' : 'Split percent (%)'}</Label>
              <Input type="number" min="0.01" step="0.01" value={value} onChange={e => setValue(e.target.value)} data-testid="input-revshare-value" />
            </div>
          )}
          {kind === 'percent' && (
            <div className="space-y-1.5">
              <Label>Agreed transaction value per redemption ($)</Label>
              <Input type="number" min="0.01" step="0.01" value={base} onChange={e => setBase(e.target.value)} data-testid="input-revshare-base" />
              <p className="text-xs text-muted-foreground">
                The split applies to this agreed nominal value for each redemption.
              </p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { setOpenedFor(null); onClose(); }}>Cancel</Button>
          <Button onClick={submit} disabled={update.isPending} data-testid="button-save-revshare">
            {update.isPending ? 'Saving…' : 'Save Terms'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Wallet ───────────────────────────────────────────────────────────────────

function WalletCard() {
  const { data: wallet, isLoading } = useGetCoopWallet({
    query: { queryKey: getGetCoopWalletQueryKey() },
  });
  return (
    <Card data-testid="card-coop-wallet">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Wallet className="w-4 h-4 text-primary" /> Co-Op Wallet
        </CardTitle>
        <CardDescription>
          Your accrued cross-promotion earnings and charges. Payouts are processed by the
          platform operators — this is an internal accounting record, not a bank balance.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-24 w-full rounded-lg" />
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="border rounded-lg p-3">
                <div className="text-lg font-bold" data-testid="text-wallet-balance">{money(wallet?.balance ?? 0)}</div>
                <div className="text-xs text-muted-foreground">Pending balance</div>
              </div>
              <div className="border rounded-lg p-3">
                <div className="text-lg font-bold" data-testid="text-wallet-lifetime">{money(wallet?.lifetimeEarnings ?? 0)}</div>
                <div className="text-xs text-muted-foreground">Lifetime earned</div>
              </div>
              <div className="border rounded-lg p-3">
                <div className="text-lg font-bold" data-testid="text-wallet-fees">{money(wallet?.totalFees ?? 0)}</div>
                <div className="text-xs text-muted-foreground">Platform fees</div>
              </div>
            </div>
            {(wallet?.entries ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-wallet-empty">
                No wallet activity yet — earnings appear when revenue-share perks are redeemed.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground border-b">
                      <th className="py-2 pr-3 font-medium">Activity</th>
                      <th className="py-2 px-3 font-medium text-right">Amount</th>
                      <th className="py-2 px-3 font-medium text-right">Fee</th>
                      <th className="py-2 pl-3 font-medium text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(wallet?.entries ?? []).map((e: CoopWalletEntry) => (
                      <tr key={e.id} className="border-b last:border-0" data-testid={`row-wallet-entry-${e.id}`}>
                        <td className="py-2 pr-3">
                          <div className="font-medium">{ENTRY_LABELS[e.entryType] ?? e.entryType}</div>
                          <div className="text-xs text-muted-foreground">
                            {e.description ?? e.partnershipPerkTitle ?? ''} · {new Date(e.createdAt).toLocaleDateString()}
                          </div>
                        </td>
                        <td className={`py-2 px-3 text-right font-medium ${e.amount >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                          {e.amount >= 0 ? '+' : ''}{money(e.amount)}
                        </td>
                        <td className="py-2 px-3 text-right text-muted-foreground">
                          {e.fee > 0 ? money(e.fee) : '—'}
                        </td>
                        <td className="py-2 pl-3 text-right">
                          <Badge variant="outline" className="capitalize">
                            {e.status === 'paid_out' ? 'Paid out' : 'Pending'}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
