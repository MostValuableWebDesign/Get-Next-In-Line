import { useState } from 'react';
import {
  useListCoopRetailItems, getListCoopRetailItemsQueryKey,
  useCreateCoopRetailItem, useUpdateCoopRetailItem,
  useAdjustCoopRetailStock, useRecordCoopRetailSale,
  useGetCoopRetailLedger, getGetCoopRetailLedgerQueryKey,
  useListCoopPartnerships, getListCoopPartnershipsQueryKey,
  type CoopRetailItem,
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
import {
  AlertTriangle, Package, PackagePlus, Receipt, ShoppingCart, Store, Wrench,
} from 'lucide-react';

/**
 * Co-Op Shelf-Space Inventory Tracker — merchant-facing section of the Local
 * Co-Op Network hub. A host business logs consigned retail items tied to an
 * accepted partnership, records restocks/shrinkage, and both sides watch live
 * stock levels and the attributed cross-sale ledger. Retail sales themselves
 * are rung up from the POS checkout surface (RetailSalePOSCard).
 */

function errText(err: unknown): string {
  const e = err as { data?: { message?: string }; message?: string };
  return e?.data?.message ?? e?.message ?? 'Please try again.';
}

function useInvalidateRetail() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: getListCoopRetailItemsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetCoopRetailLedgerQueryKey() });
  };
}

function LowStockBadge({ item }: { item: CoopRetailItem }) {
  if (!item.lowStock) return null;
  return (
    <Badge
      variant="outline"
      className="text-amber-700 border-amber-300 bg-amber-50 gap-1"
      data-testid={`badge-low-stock-${item.id}`}
    >
      <AlertTriangle className="w-3 h-3" /> Low stock
    </Badge>
  );
}

export function ShelfSpaceTrackerSection({ tenantId }: { tenantId: number }) {
  const { data, isLoading } = useListCoopRetailItems({
    query: { queryKey: getListCoopRetailItemsQueryKey() },
  });

  return (
    <div className="space-y-6" data-testid="shelf-space-tracker">
      <div>
        <h3 className="text-lg font-bold tracking-tight flex items-center gap-2">
          <Package className="w-5 h-5 text-primary" /> Shelf-Space Tracker
        </h3>
        <p className="text-sm text-muted-foreground mt-1">
          Consigned retail inventory across your partnerships — track stock you host for
          partners, watch your own products on their shelves, and see every attributed sale.
        </p>
      </div>

      {isLoading ? (
        <Skeleton className="h-24 w-full rounded-xl" />
      ) : (
        <div className="grid lg:grid-cols-2 gap-6 items-start">
          <HostedItemsCard items={data?.hosted ?? []} tenantId={tenantId} />
          <div className="space-y-6">
            <PlacedItemsCard items={data?.placed ?? []} />
            <CrossSaleLedgerCard />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Items I'm hosting ────────────────────────────────────────────────────────

function HostedItemsCard({ items, tenantId }: { items: CoopRetailItem[]; tenantId: number }) {
  const [addOpen, setAddOpen] = useState(false);
  const [adjustItem, setAdjustItem] = useState<CoopRetailItem | null>(null);
  const [editItem, setEditItem] = useState<CoopRetailItem | null>(null);

  return (
    <Card data-testid="card-hosted-items">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Store className="w-4 h-4 text-primary" /> Items I'm Hosting
            </CardTitle>
            <CardDescription>
              Partner products on your shelves. Sales are rung up from POS checkout.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setAddOpen(true)} data-testid="button-add-retail-item">
            <PackagePlus className="w-4 h-4 mr-1.5" /> Add Item
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-hosted-items">
            No consigned items yet. Add a partner's product to start tracking shelf space.
          </p>
        ) : (
          items.map(item => (
            <div
              key={item.id}
              className={`border rounded-lg p-3 flex items-center justify-between gap-3 ${!item.isActive ? 'opacity-60' : ''}`}
              data-testid={`row-hosted-item-${item.id}`}
            >
              <div className="min-w-0">
                <div className="font-medium text-sm flex items-center gap-2 flex-wrap">
                  {item.name}
                  <LowStockBadge item={item} />
                  {!item.isActive && <Badge variant="secondary" className="text-[10px]">Inactive</Badge>}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  From {item.ownerTenantName} • ${item.unitPrice.toFixed(2)} • partner keeps {item.ownerSharePercent}%
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <div className="text-right">
                  <div className="text-lg font-bold tabular-nums" data-testid={`text-stock-${item.id}`}>
                    {item.quantityOnShelf}
                  </div>
                  <div className="text-[10px] text-muted-foreground">on shelf</div>
                </div>
                <Button
                  size="sm" variant="outline" className="h-8"
                  onClick={() => setAdjustItem(item)}
                  data-testid={`button-adjust-${item.id}`}
                >
                  <Wrench className="w-3.5 h-3.5 mr-1" /> Stock
                </Button>
                <Button
                  size="sm" variant="ghost" className="h-8"
                  onClick={() => setEditItem(item)}
                  data-testid={`button-edit-${item.id}`}
                >
                  Edit
                </Button>
              </div>
            </div>
          ))
        )}
      </CardContent>
      <AddItemDialog open={addOpen} onOpenChange={setAddOpen} tenantId={tenantId} />
      <AdjustStockDialog item={adjustItem} onClose={() => setAdjustItem(null)} />
      <EditItemDialog item={editItem} onClose={() => setEditItem(null)} />
    </Card>
  );
}

// ── My items on partners' shelves ────────────────────────────────────────────

function PlacedItemsCard({ items }: { items: CoopRetailItem[] }) {
  return (
    <Card data-testid="card-placed-items">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Package className="w-4 h-4 text-primary" /> My Items on Partners' Shelves
        </CardTitle>
        <CardDescription>
          Live stock of your products displayed at partner storefronts.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-placed-items">
            None of your products are on a partner's shelf yet — the hosting business adds them
            from its own dashboard.
          </p>
        ) : (
          items.map(item => (
            <div
              key={item.id}
              className="border rounded-lg p-3 flex items-center justify-between gap-3"
              data-testid={`row-placed-item-${item.id}`}
            >
              <div className="min-w-0">
                <div className="font-medium text-sm flex items-center gap-2 flex-wrap">
                  {item.name}
                  <LowStockBadge item={item} />
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  At {item.hostTenantName} • ${item.unitPrice.toFixed(2)} • your share {item.ownerSharePercent}%
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-lg font-bold tabular-nums">{item.quantityOnShelf}</div>
                <div className="text-[10px] text-muted-foreground">on shelf</div>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

// ── Cross-sale ledger ────────────────────────────────────────────────────────

function CrossSaleLedgerCard() {
  const { data, isLoading } = useGetCoopRetailLedger({
    query: { queryKey: getGetCoopRetailLedgerQueryKey() },
  });

  return (
    <Card data-testid="card-retail-ledger">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Receipt className="w-4 h-4 text-primary" /> Cross-Sale Ledger
        </CardTitle>
        <CardDescription>
          Attributed retail sales per partner — units, gross revenue, and your share.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-16 w-full rounded-lg" />
        ) : (data?.partners ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-ledger">
            No retail sales recorded yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="table-retail-ledger">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="py-2 pr-3 text-left font-medium">Partner</th>
                  <th className="py-2 px-3 text-right font-medium">Units</th>
                  <th className="py-2 px-3 text-right font-medium">Gross</th>
                  <th className="py-2 pl-3 text-right font-medium">My Share</th>
                </tr>
              </thead>
              <tbody>
                {(data?.partners ?? []).map(p => (
                  <tr key={p.partnerTenantId} className="border-b last:border-0" data-testid={`row-ledger-${p.partnerTenantId}`}>
                    <td className="py-2 pr-3 font-medium">{p.partnerName}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{p.unitsSold}</td>
                    <td className="py-2 px-3 text-right tabular-nums">${p.grossRevenue.toFixed(2)}</td>
                    <td className="py-2 pl-3 text-right tabular-nums font-medium" data-testid={`cell-myshare-${p.partnerTenantId}`}>
                      ${p.myShare.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Add item dialog ──────────────────────────────────────────────────────────

function AddItemDialog({
  open, onOpenChange, tenantId,
}: { open: boolean; onOpenChange: (o: boolean) => void; tenantId: number }) {
  const { toast } = useToast();
  const invalidate = useInvalidateRetail();
  const create = useCreateCoopRetailItem();
  const { data: partnerships } = useListCoopPartnerships(
    { tenantId },
    { query: { queryKey: getListCoopPartnershipsQueryKey({ tenantId }) } },
  );
  const accepted = (partnerships ?? []).filter(
    p => p.status === 'accepted' && p.isActive && p.bannedAt == null,
  );

  const [partnershipId, setPartnershipId] = useState('');
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [share, setShare] = useState('50');
  const [threshold, setThreshold] = useState('3');

  const partnerNameOf = (p: (typeof accepted)[number]) =>
    p.hostTenantId === tenantId ? p.partnerTenantName : p.hostTenantName;

  const valid =
    partnershipId && name.trim() && Number(quantity) >= 0 && Number(price) > 0 &&
    Number(share) >= 0 && Number(share) <= 100 && Number(threshold) >= 0;

  const submit = () => {
    create.mutate(
      {
        data: {
          partnershipId: Number(partnershipId),
          name: name.trim(),
          quantityOnShelf: Number(quantity),
          unitPrice: Number(price),
          ownerSharePercent: Number(share),
          lowStockThreshold: Number(threshold),
        },
      },
      {
        onSuccess: () => {
          invalidate();
          onOpenChange(false);
          setName(''); setQuantity(''); setPrice('');
          toast({ title: 'Item added', description: 'The consigned item is now tracked on your shelf.' });
        },
        onError: (err: unknown) =>
          toast({ title: 'Could not add item', description: errText(err), variant: 'destructive' }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-add-retail-item">
        <DialogHeader>
          <DialogTitle>Add Consigned Item</DialogTitle>
          <DialogDescription>
            Log a partner's retail product you'll display and sell at your storefront.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Originating Partner</Label>
            <Select value={partnershipId} onValueChange={setPartnershipId}>
              <SelectTrigger data-testid="select-item-partnership">
                <SelectValue placeholder="Pick an accepted partnership..." />
              </SelectTrigger>
              <SelectContent>
                {accepted.map(p => (
                  <SelectItem key={p.id} value={String(p.id)}>{partnerNameOf(p)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {accepted.length === 0 && (
              <p className="text-xs text-muted-foreground">
                You need an accepted, active partnership before adding consigned inventory.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Product Name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Lavender Candle" data-testid="input-item-name" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Quantity on Shelf</Label>
              <Input type="number" min="0" value={quantity} onChange={e => setQuantity(e.target.value)} data-testid="input-item-quantity" />
            </div>
            <div className="space-y-1.5">
              <Label>Unit Retail Price ($)</Label>
              <Input type="number" min="0" step="0.01" value={price} onChange={e => setPrice(e.target.value)} data-testid="input-item-price" />
            </div>
            <div className="space-y-1.5">
              <Label>Partner's Share (%)</Label>
              <Input type="number" min="0" max="100" value={share} onChange={e => setShare(e.target.value)} data-testid="input-item-share" />
            </div>
            <div className="space-y-1.5">
              <Label>Low-Stock Threshold</Label>
              <Input type="number" min="0" value={threshold} onChange={e => setThreshold(e.target.value)} data-testid="input-item-threshold" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!valid || create.isPending} data-testid="button-save-retail-item">
            Add Item
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Adjust stock dialog (restock / shrinkage) ────────────────────────────────

function AdjustStockDialog({ item, onClose }: { item: CoopRetailItem | null; onClose: () => void }) {
  const { toast } = useToast();
  const invalidate = useInvalidateRetail();
  const adjust = useAdjustCoopRetailStock();
  const [mode, setMode] = useState<'restock' | 'shrinkage'>('restock');
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');

  const submit = () => {
    if (!item) return;
    const n = Number(qty);
    adjust.mutate(
      {
        id: item.id,
        data: {
          quantityDelta: mode === 'restock' ? n : -n,
          reason: mode,
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      },
      {
        onSuccess: () => {
          invalidate();
          onClose();
          setQty(''); setNote('');
          toast({
            title: mode === 'restock' ? 'Restocked' : 'Stock adjusted',
            description: `${item.name} stock updated — the change is logged in the item's history.`,
          });
        },
        onError: (err: unknown) =>
          toast({ title: 'Could not adjust stock', description: errText(err), variant: 'destructive' }),
      },
    );
  };

  return (
    <Dialog open={item != null} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent data-testid="dialog-adjust-stock">
        <DialogHeader>
          <DialogTitle>Adjust Stock — {item?.name}</DialogTitle>
          <DialogDescription>
            Currently {item?.quantityOnShelf} on shelf. Restocks and shrinkage are both logged.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Adjustment Type</Label>
            <Select value={mode} onValueChange={v => setMode(v as 'restock' | 'shrinkage')}>
              <SelectTrigger data-testid="select-adjust-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="restock">Restock (add units)</SelectItem>
                <SelectItem value="shrinkage">Shrinkage / removal (remove units)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Units</Label>
            <Input type="number" min="1" value={qty} onChange={e => setQty(e.target.value)} data-testid="input-adjust-qty" />
          </div>
          <div className="space-y-1.5">
            <Label>Note (optional)</Label>
            <Input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. weekly delivery, damaged unit" data-testid="input-adjust-note" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!(Number(qty) > 0) || adjust.isPending} data-testid="button-save-adjust">
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit item dialog ─────────────────────────────────────────────────────────

function EditItemDialog({ item, onClose }: { item: CoopRetailItem | null; onClose: () => void }) {
  const { toast } = useToast();
  const invalidate = useInvalidateRetail();
  const update = useUpdateCoopRetailItem();
  const [name, setName] = useState<string | null>(null);
  const [price, setPrice] = useState<string | null>(null);
  const [share, setShare] = useState<string | null>(null);
  const [threshold, setThreshold] = useState<string | null>(null);

  const submit = (extra: { isActive?: boolean } = {}) => {
    if (!item) return;
    update.mutate(
      {
        id: item.id,
        data: {
          ...(name != null && name.trim() ? { name: name.trim() } : {}),
          ...(price != null && Number(price) > 0 ? { unitPrice: Number(price) } : {}),
          ...(share != null ? { ownerSharePercent: Number(share) } : {}),
          ...(threshold != null ? { lowStockThreshold: Number(threshold) } : {}),
          ...extra,
        },
      },
      {
        onSuccess: () => {
          invalidate();
          onClose();
          setName(null); setPrice(null); setShare(null); setThreshold(null);
          toast({ title: 'Item updated' });
        },
        onError: (err: unknown) =>
          toast({ title: 'Could not update item', description: errText(err), variant: 'destructive' }),
      },
    );
  };

  return (
    <Dialog open={item != null} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent data-testid="dialog-edit-retail-item">
        <DialogHeader>
          <DialogTitle>Edit Item — {item?.name}</DialogTitle>
          <DialogDescription>From {item?.ownerTenantName}. Stock changes go through Adjust Stock.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Product Name</Label>
            <Input value={name ?? item?.name ?? ''} onChange={e => setName(e.target.value)} data-testid="input-edit-name" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>Price ($)</Label>
              <Input type="number" min="0" step="0.01" value={price ?? String(item?.unitPrice ?? '')} onChange={e => setPrice(e.target.value)} data-testid="input-edit-price" />
            </div>
            <div className="space-y-1.5">
              <Label>Partner Share (%)</Label>
              <Input type="number" min="0" max="100" value={share ?? String(item?.ownerSharePercent ?? '')} onChange={e => setShare(e.target.value)} data-testid="input-edit-share" />
            </div>
            <div className="space-y-1.5">
              <Label>Low-Stock At</Label>
              <Input type="number" min="0" value={threshold ?? String(item?.lowStockThreshold ?? '')} onChange={e => setThreshold(e.target.value)} data-testid="input-edit-threshold" />
            </div>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button
            variant={item?.isActive ? 'destructive' : 'secondary'}
            className="mr-auto"
            onClick={() => submit({ isActive: !item?.isActive })}
            disabled={update.isPending}
            data-testid="button-toggle-item-active"
          >
            {item?.isActive ? 'Deactivate' : 'Reactivate'}
          </Button>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => submit()} disabled={update.isPending} data-testid="button-save-edit-item">
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── POS retail sale entry ────────────────────────────────────────────────────

/**
 * Retail-sale entry surfaced from the POS checkout flow: staff ring up
 * partner-consigned products (quantity per item); stock decrements in real
 * time and both businesses get attributed ledger entries.
 */
export function RetailSalePOSCard() {
  const { toast } = useToast();
  const invalidate = useInvalidateRetail();
  const { data } = useListCoopRetailItems({
    query: { queryKey: getListCoopRetailItemsQueryKey() },
  });
  const sale = useRecordCoopRetailSale();
  const [itemId, setItemId] = useState('');
  const [qty, setQty] = useState('1');

  const sellable = (data?.hosted ?? []).filter(i => i.isActive);
  if (sellable.length === 0) return null;
  const selected = sellable.find(i => String(i.id) === itemId) ?? null;

  const submit = () => {
    if (!selected) return;
    sale.mutate(
      { id: selected.id, data: { quantity: Number(qty) } },
      {
        onSuccess: (res) => {
          invalidate();
          setQty('1');
          toast({
            title: 'Retail sale recorded',
            description: `${res.unitsSold} × ${selected.name} — $${res.grossAmount.toFixed(2)} gross; ${selected.ownerTenantName}'s share $${res.ownerShareAmount.toFixed(2)}.${res.lowStockAlertSent ? ' Low-stock alert sent to both businesses.' : ''}`,
          });
        },
        onError: (err: unknown) =>
          toast({ title: 'Could not record sale', description: errText(err), variant: 'destructive' }),
      },
    );
  };

  return (
    <Card className="border-primary/20" data-testid="card-retail-sale-pos">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <ShoppingCart className="w-4 h-4 text-primary" /> Partner Retail Sale
        </CardTitle>
        <CardDescription>
          Ring up consigned partner products — stock updates instantly and the sale is
          attributed to the originating partner.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5 flex-1 min-w-48">
          <Label>Item</Label>
          <Select value={itemId} onValueChange={setItemId}>
            <SelectTrigger data-testid="select-pos-retail-item">
              <SelectValue placeholder="Pick a shelf item..." />
            </SelectTrigger>
            <SelectContent>
              {sellable.map(i => (
                <SelectItem key={i.id} value={String(i.id)}>
                  {i.name} — ${i.unitPrice.toFixed(2)} ({i.quantityOnShelf} left)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 w-24">
          <Label>Qty</Label>
          <Input type="number" min="1" value={qty} onChange={e => setQty(e.target.value)} data-testid="input-pos-retail-qty" />
        </div>
        <Button
          onClick={submit}
          disabled={!selected || !(Number(qty) > 0) || sale.isPending}
          data-testid="button-record-retail-sale"
        >
          Record Sale{selected && Number(qty) > 0 ? ` — $${(selected.unitPrice * Number(qty)).toFixed(2)}` : ''}
        </Button>
        {selected?.lowStock && (
          <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50 gap-1">
            <AlertTriangle className="w-3 h-3" /> Low stock
          </Badge>
        )}
      </CardContent>
    </Card>
  );
}
