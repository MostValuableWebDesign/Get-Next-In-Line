import { useState } from 'react';
import {
  useListAdminProcurementVendors, getListAdminProcurementVendorsQueryKey,
  useCreateProcurementVendor, useUpdateProcurementVendor,
  useCreateProcurementVendorItem, useUpdateProcurementVendorItem,
  useGetAdminProcurementOverview, getGetAdminProcurementOverviewQueryKey,
  type ProcurementVendor,
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
import { useToast } from '@/hooks/use-toast';
import { BadgeCheck, Boxes, PiggyBank, Plus, ShoppingCart, Store } from 'lucide-react';

const money = (n: number) => `$${n.toFixed(2)}`;

type AdminVendor = ProcurementVendor;

function errMessage(e: unknown): string {
  const anyErr = e as { response?: { data?: { message?: string } }; message?: string };
  return anyErr?.response?.data?.message ?? anyErr?.message ?? 'Something went wrong';
}

/**
 * Command Center — Co-Op Supplier & Procurement Marketplace administration.
 *
 * - Curate the regional B2B vendor directory (only verified vendors are
 *   visible to merchants) and each vendor's supply items with bulk tiers.
 * - Network-wide view: active group buys and cumulative co-op savings.
 */
export function ProcurementAdminSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: vendors, isLoading } = useListAdminProcurementVendors();
  const { data: overview } = useGetAdminProcurementOverview();

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getListAdminProcurementVendorsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetAdminProcurementOverviewQueryKey() });
  };
  const onError = (e: unknown) =>
    toast({ title: 'Vendor directory error', description: errMessage(e), variant: 'destructive' });

  const [vendorDialogOpen, setVendorDialogOpen] = useState(false);
  const [vendorForm, setVendorForm] = useState({ name: '', category: '', region: '', contactEmail: '', isVerified: false });
  const createVendor = useCreateProcurementVendor({
    mutation: { onSuccess: () => { toast({ title: 'Vendor added' }); setVendorDialogOpen(false); refresh(); }, onError },
  });
  const updateVendor = useUpdateProcurementVendor({
    mutation: { onSuccess: refresh, onError },
  });

  const [itemVendor, setItemVendor] = useState<AdminVendor | null>(null);
  const [itemForm, setItemForm] = useState({ name: '', unit: '', basePrice: '', tiers: '' });
  const createItem = useCreateProcurementVendorItem({
    mutation: { onSuccess: () => { toast({ title: 'Supply item added' }); setItemVendor(null); refresh(); }, onError },
  });
  const updateItem = useUpdateProcurementVendorItem({
    mutation: { onSuccess: refresh, onError },
  });

  // Bulk tiers entered as "25:4.50, 100:3.75" (minQty:unitPrice pairs).
  const parseTiers = (raw: string) =>
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pair) => {
        const [q, p] = pair.split(':').map((x) => Number(x.trim()));
        return { minQty: q, unitPrice: p };
      })
      .filter((t) => Number.isInteger(t.minQty) && t.minQty > 0 && Number.isFinite(t.unitPrice) && t.unitPrice >= 0);

  return (
    <Card className="border-none shadow-md" data-testid="card-procurement-admin">
      <CardHeader className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <ShoppingCart className="w-5 h-5 text-primary" /> Supplier &amp; Procurement Marketplace
          </CardTitle>
          <CardDescription>
            Curate the verified regional B2B vendor directory and monitor network group buying.
            Merchants only see vendors marked verified.
          </CardDescription>
        </div>
        <Button size="sm" data-testid="button-add-vendor" onClick={() => { setVendorForm({ name: '', category: '', region: '', contactEmail: '', isVerified: false }); setVendorDialogOpen(true); }}>
          <Plus className="w-4 h-4 mr-1" /> Add vendor
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Network overview */}
        {overview && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-md border p-3" data-testid="stat-vendors">
              <div className="text-xs text-muted-foreground flex items-center gap-1"><Store className="w-3 h-3" /> Vendors</div>
              <div className="text-lg font-semibold">{overview.verifiedVendorCount}/{overview.vendorCount} verified</div>
            </div>
            <div className="rounded-md border p-3" data-testid="stat-open-buys">
              <div className="text-xs text-muted-foreground flex items-center gap-1"><Boxes className="w-3 h-3" /> Active group buys</div>
              <div className="text-lg font-semibold">{overview.openGroupBuys.length}</div>
            </div>
            <div className="rounded-md border p-3" data-testid="stat-closed-buys">
              <div className="text-xs text-muted-foreground">Completed pools</div>
              <div className="text-lg font-semibold">{overview.closedGroupBuyCount}</div>
            </div>
            <div className="rounded-md border p-3" data-testid="stat-total-savings">
              <div className="text-xs text-muted-foreground flex items-center gap-1"><PiggyBank className="w-3 h-3" /> Co-op savings</div>
              <div className="text-lg font-semibold text-emerald-600">{money(overview.totalSavings)}</div>
            </div>
          </div>
        )}

        {overview && overview.openGroupBuys.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold mb-2">Active group buys across the network</h4>
            <div className="space-y-1">
              {overview.openGroupBuys.map((g) => (
                <div key={g.id} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-sm" data-testid={`row-admin-buy-${g.id}`}>
                  <span>
                    {g.itemName} · {g.vendorName} · organized by {g.organizerTenantName}
                  </span>
                  <Badge variant="outline">
                    {g.totalQuantity} pooled · {money(g.currentUnitPrice)}/{g.unit} · {g.participants.length} merchant{g.participants.length === 1 ? '' : 's'}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        )}

        {overview && overview.savingsByTenant.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold mb-2">Savings by business</h4>
            <div className="space-y-1">
              {overview.savingsByTenant.map((t) => (
                <div key={t.tenantId} className="flex items-center justify-between text-sm" data-testid={`row-savings-${t.tenantId}`}>
                  <span>{t.tenantName}</span>
                  <span className="text-emerald-600 font-medium">{money(t.savings)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Vendor directory */}
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (vendors ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-admin-no-vendors">
            No vendors yet — add regional suppliers so merchants can start pooling orders.
          </p>
        ) : (
          <div className="space-y-2">
            {(vendors ?? []).map((v) => (
              <div key={v.id} className="rounded-md border p-3" data-testid={`row-admin-vendor-${v.id}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{v.name}</span>
                    <Badge variant="secondary">{v.category}</Badge>
                    <span className="text-xs text-muted-foreground">{v.region}</span>
                    {!v.isActive && <Badge variant="destructive">Retired</Badge>}
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1">
                      <Switch
                        checked={v.isVerified}
                        data-testid={`switch-verified-${v.id}`}
                        onCheckedChange={(checked) => updateVendor.mutate({ id: v.id, data: { isVerified: checked } })}
                      />
                      <span className="text-xs flex items-center gap-0.5">
                        <BadgeCheck className={`w-3.5 h-3.5 ${v.isVerified ? 'text-emerald-600' : 'text-muted-foreground'}`} /> Verified
                      </span>
                    </div>
                    <Button
                      size="sm" variant="outline" data-testid={`button-add-item-${v.id}`}
                      onClick={() => { setItemVendor(v); setItemForm({ name: '', unit: '', basePrice: '', tiers: '' }); }}
                    >
                      <Plus className="w-3 h-3 mr-1" /> Item
                    </Button>
                  </div>
                </div>
                <div className="mt-2 space-y-1">
                  {v.items.map((i) => (
                    <div key={i.id} className="flex flex-wrap items-center justify-between gap-2 text-sm" data-testid={`row-admin-item-${i.id}`}>
                      <span className={i.isActive ? '' : 'line-through text-muted-foreground'}>
                        {i.name} · {money(i.basePrice)}/{i.unit}
                        {i.bulkTiers.length > 0 && (
                          <span className="text-xs text-muted-foreground">
                            {' '}(bulk: {i.bulkTiers.map((t) => `${t.minQty}+ @ ${money(t.unitPrice)}`).join(', ')})
                          </span>
                        )}
                      </span>
                      <Button
                        size="sm" variant="ghost" data-testid={`button-toggle-item-${i.id}`}
                        onClick={() => updateItem.mutate({ id: i.id, data: { isActive: !i.isActive } })}
                      >
                        {i.isActive ? 'Retire' : 'Restore'}
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {/* Add vendor dialog */}
      <Dialog open={vendorDialogOpen} onOpenChange={setVendorDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a B2B vendor</DialogTitle>
            <DialogDescription>Only vendors marked verified are shown to merchants.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="space-y-1">
              <Label htmlFor="vendor-name">Name</Label>
              <Input id="vendor-name" data-testid="input-vendor-name" value={vendorForm.name} onChange={(e) => setVendorForm({ ...vendorForm, name: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="vendor-category">Category</Label>
                <Input id="vendor-category" data-testid="input-vendor-category" placeholder="sanitation, packaging…" value={vendorForm.category} onChange={(e) => setVendorForm({ ...vendorForm, category: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="vendor-region">Region</Label>
                <Input id="vendor-region" data-testid="input-vendor-region" value={vendorForm.region} onChange={(e) => setVendorForm({ ...vendorForm, region: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="vendor-email">Contact email (optional)</Label>
              <Input id="vendor-email" data-testid="input-vendor-email" value={vendorForm.contactEmail} onChange={(e) => setVendorForm({ ...vendorForm, contactEmail: e.target.value })} />
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={vendorForm.isVerified} data-testid="switch-vendor-verified" onCheckedChange={(checked) => setVendorForm({ ...vendorForm, isVerified: checked })} />
              <span className="text-sm">Verified (visible to merchants)</span>
            </div>
          </div>
          <DialogFooter>
            <Button
              data-testid="button-confirm-add-vendor"
              disabled={createVendor.isPending || !vendorForm.name.trim() || !vendorForm.category.trim() || !vendorForm.region.trim()}
              onClick={() =>
                createVendor.mutate({
                  data: {
                    name: vendorForm.name.trim(),
                    category: vendorForm.category.trim(),
                    region: vendorForm.region.trim(),
                    ...(vendorForm.contactEmail.trim() ? { contactEmail: vendorForm.contactEmail.trim() } : {}),
                    isVerified: vendorForm.isVerified,
                  },
                })
              }
            >
              Add vendor
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add item dialog */}
      <Dialog open={itemVendor != null} onOpenChange={(o) => !o && setItemVendor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add supply item — {itemVendor?.name}</DialogTitle>
            <DialogDescription>
              Set the solo unit price and optional bulk tiers as "minQty:price" pairs, e.g.
              "25:4.50, 100:3.75".
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="space-y-1">
              <Label htmlFor="item-name">Name</Label>
              <Input id="item-name" data-testid="input-item-name" value={itemForm.name} onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="item-unit">Unit</Label>
                <Input id="item-unit" data-testid="input-item-unit" placeholder="case of 12" value={itemForm.unit} onChange={(e) => setItemForm({ ...itemForm, unit: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="item-price">Base price</Label>
                <Input id="item-price" data-testid="input-item-price" type="number" min={0} step="0.01" value={itemForm.basePrice} onChange={(e) => setItemForm({ ...itemForm, basePrice: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="item-tiers">Bulk tiers (optional)</Label>
              <Input id="item-tiers" data-testid="input-item-tiers" placeholder="25:4.50, 100:3.75" value={itemForm.tiers} onChange={(e) => setItemForm({ ...itemForm, tiers: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button
              data-testid="button-confirm-add-item"
              disabled={createItem.isPending || !itemVendor || !itemForm.name.trim() || !itemForm.unit.trim() || !(Number(itemForm.basePrice) >= 0 && itemForm.basePrice !== '')}
              onClick={() =>
                itemVendor &&
                createItem.mutate({
                  id: itemVendor.id,
                  data: {
                    name: itemForm.name.trim(),
                    unit: itemForm.unit.trim(),
                    basePrice: Number(itemForm.basePrice),
                    bulkTiers: parseTiers(itemForm.tiers),
                  },
                })
              }
            >
              Add item
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
