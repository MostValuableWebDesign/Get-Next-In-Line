import { useMemo, useState } from 'react';
import {
  useListProcurementVendors, getListProcurementVendorsQueryKey,
  useListProcurementGroupBuys, getListProcurementGroupBuysQueryKey,
  useCreateProcurementGroupBuy, useJoinProcurementGroupBuy, useCloseProcurementGroupBuy,
  useGetProcurementGroupBuyLedger,
  useListProcurementLedger, getListProcurementLedgerQueryKey,
  useListProcurementSupplies, getListProcurementSuppliesQueryKey,
  useCreateProcurementSupply, useUpdateProcurementSupply, useReplenishProcurementSupply,
  type ProcurementVendor,
  type ProcurementGroupBuy,
  type ProcurementSupplyItem,
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
import {
  AlertTriangle, Boxes, CheckCircle2, PackageOpen, Plus, ShoppingCart, Store, TrendingDown,
} from 'lucide-react';

const money = (n: number) => `$${n.toFixed(2)}`;

type Vendor = ProcurementVendor;
type GroupBuy = ProcurementGroupBuy;
type Supply = ProcurementSupplyItem;

function errMessage(e: unknown): string {
  const anyErr = e as { response?: { data?: { message?: string } }; message?: string };
  return anyErr?.response?.data?.message ?? anyErr?.message ?? 'Something went wrong';
}

/**
 * Co-Op Supplier & Procurement Marketplace — merchant hub section.
 *
 * - Verified local B2B vendor directory (admin-curated) with bulk pricing tiers.
 * - Collaborative group buys: open a pool on a vendor item, others join, and
 *   everyone watches the live volume-discount tier progress.
 * - Cost-split ledger on close: each participant's share + savings vs. solo.
 * - Supply tracking with low-stock thresholds, one-click replenishment, and
 *   optional auto-request mode.
 */
export function CoopProcurementSection({ tenantId }: { tenantId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: vendors, isLoading: vendorsLoading } = useListProcurementVendors();
  const { data: groupBuys, isLoading: buysLoading } = useListProcurementGroupBuys();
  const { data: supplies, isLoading: suppliesLoading } = useListProcurementSupplies();
  const { data: myLedger } = useListProcurementLedger();

  const refreshBuys = () => {
    queryClient.invalidateQueries({ queryKey: getListProcurementGroupBuysQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListProcurementLedgerQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListProcurementSuppliesQueryKey() });
  };

  // ── group buy actions ──────────────────────────────────────────────────
  const [poolItem, setPoolItem] = useState<{ vendor: Vendor; itemId: number } | null>(null);
  const [poolQty, setPoolQty] = useState('1');
  const createBuy = useCreateProcurementGroupBuy({
    mutation: {
      onSuccess: () => {
        toast({ title: 'Group buy opened', description: 'Other co-op merchants can now join your pool.' });
        setPoolItem(null);
        refreshBuys();
      },
      onError: (e) => toast({ title: 'Could not open group buy', description: errMessage(e), variant: 'destructive' }),
    },
  });

  const [joinTarget, setJoinTarget] = useState<GroupBuy | null>(null);
  const [joinQty, setJoinQty] = useState('1');
  const joinBuy = useJoinProcurementGroupBuy({
    mutation: {
      onSuccess: () => {
        toast({ title: 'Pool updated', description: 'Your quantity is in the shared cart.' });
        setJoinTarget(null);
        refreshBuys();
      },
      onError: (e) => toast({ title: 'Could not join', description: errMessage(e), variant: 'destructive' }),
    },
  });

  const closeBuy = useCloseProcurementGroupBuy({
    mutation: {
      onSuccess: () => {
        toast({ title: 'Group buy closed', description: 'The cost-split ledger has been generated.' });
        refreshBuys();
      },
      onError: (e) => toast({ title: 'Could not close', description: errMessage(e), variant: 'destructive' }),
    },
  });

  const [ledgerBuyId, setLedgerBuyId] = useState<number | null>(null);
  const { data: ledgerView } = useGetProcurementGroupBuyLedger(ledgerBuyId ?? 0, {
    query: {
      queryKey: ['/api/coop/procurement/group-buys/ledger', ledgerBuyId],
      enabled: ledgerBuyId != null,
    },
  });

  // ── supplies ───────────────────────────────────────────────────────────
  const refreshSupplies = () =>
    queryClient.invalidateQueries({ queryKey: getListProcurementSuppliesQueryKey() });
  const [supplyDialogOpen, setSupplyDialogOpen] = useState(false);
  const [supplyForm, setSupplyForm] = useState({
    name: '', unit: 'unit', onHandQty: '0', lowStockThreshold: '0',
    vendorItemId: 'none', autoRequestEnabled: false,
  });
  const createSupply = useCreateProcurementSupply({
    mutation: {
      onSuccess: () => {
        toast({ title: 'Supply tracked' });
        setSupplyDialogOpen(false);
        refreshSupplies();
      },
      onError: (e) => toast({ title: 'Could not add supply', description: errMessage(e), variant: 'destructive' }),
    },
  });
  const updateSupply = useUpdateProcurementSupply({
    mutation: {
      onSuccess: () => refreshSupplies(),
      onError: (e) => toast({ title: 'Could not update supply', description: errMessage(e), variant: 'destructive' }),
    },
  });
  const replenish = useReplenishProcurementSupply({
    mutation: {
      onSuccess: (r) => {
        toast({
          title: r.action === 'created' ? 'Replenishment group buy opened' : 'Joined an open group buy',
          description: 'Your reorder quantity is pooled with the network.',
        });
        refreshBuys();
      },
      onError: (e) => toast({ title: 'Could not replenish', description: errMessage(e), variant: 'destructive' }),
    },
  });

  const vendorItems = useMemo(
    () => (vendors ?? []).flatMap((v) => v.items.map((i) => ({ vendor: v, item: i }))),
    [vendors]
  );

  const openBuys = (groupBuys ?? []).filter((g) => g.status === 'open');
  const closedBuys = (groupBuys ?? []).filter((g) => g.status !== 'open');
  const lowSupplies = (supplies ?? []).filter((s) => s.belowThreshold);
  const totalSavings = (myLedger ?? []).reduce((s, e) => s + e.savingsAmount, 0);

  const tierProgress = (g: GroupBuy) => {
    if (g.status !== 'open') return null;
    if (!g.nextTier) return g.currentTier ? 'Top discount tier unlocked' : null;
    const remaining = g.nextTier.minQty - g.totalQuantity;
    return `${remaining} more ${g.unit}${remaining === 1 ? '' : 's'} to unlock ${money(g.nextTier.unitPrice)}/${g.unit}`;
  };

  return (
    <Card data-testid="card-coop-procurement">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShoppingCart className="h-5 w-5" />
          Supplier &amp; Procurement Marketplace
        </CardTitle>
        <CardDescription>
          Pool supply orders with other co-op merchants to unlock bulk wholesale discounts from
          vetted local vendors.
          {totalSavings > 0 && (
            <span className="ml-1 font-medium text-emerald-600" data-testid="text-procurement-total-savings">
              You've saved {money(totalSavings)} through group buying.
            </span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Low-stock reminders */}
        {lowSupplies.length > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:bg-amber-950/30" data-testid="banner-low-stock">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-4 w-4" /> Reorder reminders — {lowSupplies.length} supply
              {lowSupplies.length === 1 ? ' is' : 'ies are'} below threshold
            </div>
            <div className="space-y-1">
              {lowSupplies.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-2 text-sm">
                  <span>
                    {s.name} — {s.onHandQty}/{s.lowStockThreshold} {s.unit}s on hand
                  </span>
                  {s.vendorItemId != null && (
                    <Button
                      size="sm" variant="outline" data-testid={`button-replenish-${s.id}`}
                      disabled={replenish.isPending}
                      onClick={() => replenish.mutate({ id: s.id, data: {} })}
                    >
                      {s.openGroupBuyId != null ? 'Join open group buy' : 'Start group buy'}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Open group buys */}
        <div>
          <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <Boxes className="h-4 w-4" /> Open group buys
          </h4>
          {buysLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : openBuys.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="text-no-open-buys">
              No open group buys — start one from the vendor directory below.
            </p>
          ) : (
            <div className="space-y-2">
              {openBuys.map((g) => (
                <div key={g.id} className="rounded-md border p-3" data-testid={`row-group-buy-${g.id}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="font-medium">{g.itemName}</span>{' '}
                      <span className="text-sm text-muted-foreground">
                        {g.vendorName} · organized by {g.organizerTenantName}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" data-testid={`badge-tier-${g.id}`}>
                        {g.totalQuantity} pooled · {money(g.currentUnitPrice)}/{g.unit}
                        {g.currentTier ? ' (bulk tier)' : ' (base price)'}
                      </Badge>
                      <Button
                        size="sm" variant="outline" data-testid={`button-join-buy-${g.id}`}
                        onClick={() => { setJoinTarget(g); setJoinQty(String(g.myQuantity ?? 1)); }}
                      >
                        {g.myQuantity != null ? `Adjust (${g.myQuantity})` : 'Join'}
                      </Button>
                      {g.organizerTenantId === tenantId && (
                        <Button
                          size="sm" data-testid={`button-close-buy-${g.id}`}
                          disabled={closeBuy.isPending}
                          onClick={() => closeBuy.mutate({ id: g.id })}
                        >
                          Close &amp; split costs
                        </Button>
                      )}
                    </div>
                  </div>
                  {tierProgress(g) && (
                    <p className="mt-1 text-xs text-muted-foreground" data-testid={`text-tier-progress-${g.id}`}>
                      <TrendingDown className="mr-1 inline h-3 w-3" />
                      {tierProgress(g)}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* My closed orders / ledger */}
        {closedBuys.length > 0 && (
          <div>
            <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <CheckCircle2 className="h-4 w-4" /> My past group buys
            </h4>
            <div className="space-y-2">
              {closedBuys.map((g) => (
                <div key={g.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3" data-testid={`row-closed-buy-${g.id}`}>
                  <div>
                    <span className="font-medium">{g.itemName}</span>{' '}
                    <span className="text-sm text-muted-foreground">
                      {g.vendorName} · {g.totalQuantity} pooled · settled at {money(g.currentUnitPrice)}/{g.unit}
                    </span>
                  </div>
                  <Button size="sm" variant="outline" data-testid={`button-view-ledger-${g.id}`} onClick={() => setLedgerBuyId(g.id)}>
                    View ledger
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Vendor directory */}
        <div>
          <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <Store className="h-4 w-4" /> Verified local vendors
          </h4>
          {vendorsLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : (vendors ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="text-no-vendors">
              No verified vendors yet — the platform team is curating the regional directory.
            </p>
          ) : (
            <div className="space-y-2">
              {(vendors ?? []).map((v) => (
                <div key={v.id} className="rounded-md border p-3" data-testid={`row-vendor-${v.id}`}>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{v.name}</span>
                    <Badge variant="secondary">{v.category}</Badge>
                    <span className="text-xs text-muted-foreground">{v.region}</span>
                    <Badge variant="outline" className="text-emerald-600 border-emerald-300">Verified</Badge>
                  </div>
                  <div className="mt-2 space-y-1">
                    {v.items.map((i) => (
                      <div key={i.id} className="flex flex-wrap items-center justify-between gap-2 text-sm" data-testid={`row-vendor-item-${i.id}`}>
                        <span>
                          {i.name} · {money(i.basePrice)}/{i.unit}
                          {i.bulkTiers.length > 0 && (
                            <span className="text-xs text-muted-foreground">
                              {' '}(bulk: {i.bulkTiers.map((t) => `${t.minQty}+ @ ${money(t.unitPrice)}`).join(', ')})
                            </span>
                          )}
                        </span>
                        <Button
                          size="sm" variant="outline" data-testid={`button-start-buy-${i.id}`}
                          onClick={() => { setPoolItem({ vendor: v, itemId: i.id }); setPoolQty('1'); }}
                        >
                          <Plus className="mr-1 h-3 w-3" /> Group buy
                        </Button>
                      </div>
                    ))}
                    {v.items.length === 0 && (
                      <p className="text-xs text-muted-foreground">No supply items listed yet.</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* My supplies */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h4 className="flex items-center gap-2 text-sm font-semibold">
              <PackageOpen className="h-4 w-4" /> My supplies
            </h4>
            <Button size="sm" variant="outline" data-testid="button-add-supply" onClick={() => setSupplyDialogOpen(true)}>
              <Plus className="mr-1 h-3 w-3" /> Track a supply
            </Button>
          </div>
          {suppliesLoading ? (
            <Skeleton className="h-12 w-full" />
          ) : (supplies ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="text-no-supplies">
              Track essential supplies with a low-stock threshold to get reorder reminders and
              one-click group-buy replenishment.
            </p>
          ) : (
            <div className="space-y-2">
              {(supplies ?? []).map((s) => (
                <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3" data-testid={`row-supply-${s.id}`}>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{s.name}</span>
                    {s.belowThreshold ? (
                      <Badge variant="outline" className="text-amber-600 border-amber-300" data-testid={`badge-low-${s.id}`}>
                        Low stock
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">OK</Badge>
                    )}
                    {s.vendorName && (
                      <span className="text-xs text-muted-foreground">↳ {s.vendorItemName} @ {s.vendorName}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1 text-sm">
                      <Label className="text-xs text-muted-foreground">On hand</Label>
                      <Input
                        className="h-8 w-20" type="number" min={0} defaultValue={s.onHandQty}
                        data-testid={`input-onhand-${s.id}`}
                        onBlur={(e) => {
                          const v = Math.max(0, Number(e.target.value) || 0);
                          if (v !== s.onHandQty) updateSupply.mutate({ id: s.id, data: { onHandQty: v } });
                        }}
                      />
                      <span className="text-xs text-muted-foreground">/ {s.lowStockThreshold} min</span>
                    </div>
                    {s.vendorItemId != null && (
                      <div className="flex items-center gap-1">
                        <Switch
                          checked={s.autoRequestEnabled}
                          data-testid={`switch-auto-${s.id}`}
                          onCheckedChange={(checked) =>
                            updateSupply.mutate({ id: s.id, data: { autoRequestEnabled: checked } })
                          }
                        />
                        <span className="text-xs text-muted-foreground">Auto-request</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>

      {/* Start group buy dialog */}
      <Dialog open={poolItem != null} onOpenChange={(o) => !o && setPoolItem(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Open a group buy</DialogTitle>
            <DialogDescription>
              Other co-op merchants can join your pool; everyone pays the bulk-tier price the pool
              reaches when you close it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="pool-qty">Your quantity</Label>
            <Input id="pool-qty" data-testid="input-pool-qty" type="number" min={1} value={poolQty} onChange={(e) => setPoolQty(e.target.value)} />
          </div>
          <DialogFooter>
            <Button
              data-testid="button-confirm-open-buy"
              disabled={createBuy.isPending || !poolItem || Number(poolQty) < 1}
              onClick={() =>
                poolItem &&
                createBuy.mutate({ data: { vendorItemId: poolItem.itemId, quantity: Number(poolQty) } })
              }
            >
              Open group buy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Join / adjust dialog */}
      <Dialog open={joinTarget != null} onOpenChange={(o) => !o && setJoinTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{joinTarget?.myQuantity != null ? 'Adjust your quantity' : 'Join group buy'}</DialogTitle>
            <DialogDescription>
              {joinTarget?.itemName} from {joinTarget?.vendorName} — pool currently at{' '}
              {joinTarget?.totalQuantity} {joinTarget?.unit}s, {money(joinTarget?.currentUnitPrice ?? 0)}/{joinTarget?.unit}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="join-qty">Your quantity (0 to leave)</Label>
            <Input id="join-qty" data-testid="input-join-qty" type="number" min={0} value={joinQty} onChange={(e) => setJoinQty(e.target.value)} />
          </div>
          <DialogFooter>
            <Button
              data-testid="button-confirm-join-buy"
              disabled={joinBuy.isPending || !joinTarget || Number(joinQty) < 0}
              onClick={() => joinTarget && joinBuy.mutate({ id: joinTarget.id, data: { quantity: Number(joinQty) } })}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Ledger dialog */}
      <Dialog open={ledgerBuyId != null} onOpenChange={(o) => !o && setLedgerBuyId(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Cost-split ledger</DialogTitle>
            <DialogDescription>
              {ledgerView?.groupBuy.itemName} — settled at {money(ledgerView?.groupBuy.currentUnitPrice ?? 0)}/
              {ledgerView?.groupBuy.unit} (solo price {money(ledgerView?.groupBuy.basePrice ?? 0)}).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            {(ledgerView?.entries ?? []).map((e) => (
              <div key={e.id} className="flex items-center justify-between rounded border p-2 text-sm" data-testid={`row-ledger-${e.id}`}>
                <span>{e.tenantName} — {e.quantity} × {money(e.unitPrice)}</span>
                <span>
                  {money(e.shareAmount)}{' '}
                  <span className="text-emerald-600">(saved {money(e.savingsAmount)})</span>
                </span>
              </div>
            ))}
            {ledgerView && (
              <div className="flex items-center justify-between p-2 text-sm font-medium" data-testid="row-ledger-totals">
                <span>Total ({ledgerView.totals.quantity} {ledgerView.groupBuy.unit}s)</span>
                <span>
                  {money(ledgerView.totals.amount)}{' '}
                  <span className="text-emerald-600">(saved {money(ledgerView.totals.savings)})</span>
                </span>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Track supply dialog */}
      <Dialog open={supplyDialogOpen} onOpenChange={setSupplyDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Track a supply</DialogTitle>
            <DialogDescription>
              Set a low-stock threshold to get reorder reminders; link a vendor item to enable
              one-click and automatic group-buy replenishment.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="space-y-1">
              <Label htmlFor="supply-name">Name</Label>
              <Input id="supply-name" data-testid="input-supply-name" value={supplyForm.name} onChange={(e) => setSupplyForm({ ...supplyForm, name: e.target.value })} />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1">
                <Label htmlFor="supply-unit">Unit</Label>
                <Input id="supply-unit" data-testid="input-supply-unit" value={supplyForm.unit} onChange={(e) => setSupplyForm({ ...supplyForm, unit: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="supply-onhand">On hand</Label>
                <Input id="supply-onhand" data-testid="input-supply-onhand" type="number" min={0} value={supplyForm.onHandQty} onChange={(e) => setSupplyForm({ ...supplyForm, onHandQty: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="supply-threshold">Low-stock at</Label>
                <Input id="supply-threshold" data-testid="input-supply-threshold" type="number" min={0} value={supplyForm.lowStockThreshold} onChange={(e) => setSupplyForm({ ...supplyForm, lowStockThreshold: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Linked vendor item (optional)</Label>
              <Select value={supplyForm.vendorItemId} onValueChange={(v) => setSupplyForm({ ...supplyForm, vendorItemId: v })}>
                <SelectTrigger data-testid="select-supply-vendor-item">
                  <SelectValue placeholder="Not linked" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not linked</SelectItem>
                  {vendorItems.map(({ vendor, item }) => (
                    <SelectItem key={item.id} value={String(item.id)}>
                      {item.name} — {vendor.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {supplyForm.vendorItemId !== 'none' && (
              <div className="flex items-center gap-2">
                <Switch
                  checked={supplyForm.autoRequestEnabled}
                  data-testid="switch-supply-auto"
                  onCheckedChange={(checked) => setSupplyForm({ ...supplyForm, autoRequestEnabled: checked })}
                />
                <span className="text-sm">Auto-request a group buy when stock runs low</span>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              data-testid="button-confirm-add-supply"
              disabled={createSupply.isPending || !supplyForm.name.trim()}
              onClick={() =>
                createSupply.mutate({
                  data: {
                    name: supplyForm.name.trim(),
                    unit: supplyForm.unit.trim() || 'unit',
                    onHandQty: Math.max(0, Number(supplyForm.onHandQty) || 0),
                    lowStockThreshold: Math.max(0, Number(supplyForm.lowStockThreshold) || 0),
                    ...(supplyForm.vendorItemId !== 'none'
                      ? {
                          vendorItemId: Number(supplyForm.vendorItemId),
                          autoRequestEnabled: supplyForm.autoRequestEnabled,
                        }
                      : {}),
                  },
                })
              }
            >
              Track supply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
