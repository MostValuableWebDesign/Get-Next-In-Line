import { useState } from 'react';
import {
  useListTenants,
  useListModules,
  useGetModulesPricing,
  useSimulateCheckout,
  getListTenantsQueryKey,
  getGetModuleTenantCountsQueryKey,
  getGetModuleTenantsQueryKey,
  getGetBillingSummaryQueryKey,
  getGetAgencyDashboardQueryKey,
  getGetTenantActivityQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { formatCurrency } from '@/lib/format';
import { useToast } from '@/hooks/use-toast';
import { useIsOffline } from '@/hooks/use-online';
import { CreditCard, ArrowRight, WifiOff } from 'lucide-react';

interface CheckoutSimulationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Dialog heading; each entry point supplies its own context. */
  title: string;
  description: string;
  /**
   * When provided, this module is preselected and locked — the dialog acts
   * as a single-module provisioning flow (Module Console). When omitted the
   * full module list is selectable (Billing).
   */
  lockedModuleId?: number;
}

/**
 * Shared Stripe checkout-simulation flow used by both the Billing page and
 * the Module Console. One implementation of tenant/module selection, cadence
 * toggles, markup handling, offline guard, order summary, the
 * simulate-checkout mutation, cache invalidation, and status toasts — so the
 * two entry points can never drift apart.
 */
export function CheckoutSimulationDialog({
  open,
  onOpenChange,
  title,
  description,
  lockedModuleId,
}: CheckoutSimulationDialogProps) {
  const { data: tenants } = useListTenants();
  const { data: modules } = useListModules();
  const { data: pricing } = useGetModulesPricing();
  const simulateCheckout = useSimulateCheckout();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const isOffline = useIsOffline();

  const [selectedTenant, setSelectedTenant] = useState<string>('');
  const [pickedModules, setPickedModules] = useState<number[]>([]);
  const [applyMarkup, setApplyMarkup] = useState(true);
  const [cadences, setCadences] = useState<Record<number, 'monthly' | 'biweekly'>>({});

  const selectedModules = lockedModuleId != null ? [lockedModuleId] : pickedModules;

  const handleSimulate = () => {
    if (!selectedTenant || selectedModules.length === 0) return;

    const moduleCadences = selectedModules
      .filter(id => cadences[id] === 'biweekly')
      .map(id => ({ moduleId: id, cadence: 'biweekly' as const }));

    simulateCheckout.mutate({
      data: {
        tenantId: parseInt(selectedTenant),
        moduleIds: selectedModules,
        applyMarkup,
        ...(moduleCadences.length > 0 ? { moduleCadences } : {})
      }
    }, {
      onSuccess: (res) => {
        onOpenChange(false);
        setSelectedTenant('');
        setPickedModules([]);
        queryClient.invalidateQueries({ queryKey: getListTenantsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetModuleTenantCountsQueryKey() });
        for (const id of selectedModules) {
          queryClient.invalidateQueries({ queryKey: getGetModuleTenantsQueryKey(id) });
        }
        queryClient.invalidateQueries({ queryKey: getGetBillingSummaryQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetAgencyDashboardQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetTenantActivityQueryKey() });
        toast({
          title: "Checkout Simulation Successful",
          description: `Transaction ID: ${res.transactionId} | Total: ${formatCurrency(res.totalResale)}`,
        });
      },
      onError: () => {
        toast({
          title: 'Checkout simulation failed',
          description: 'The request could not be completed. Your selections are still here — please try again.',
          variant: 'destructive',
        });
      }
    });
  };

  const toggleModule = (id: number) => {
    if (lockedModuleId != null) return;
    setPickedModules(prev =>
      prev.includes(id) ? prev.filter(m => m !== id) : [...prev, id]
    );
  };

  // Partner classification needs the module list. Until it resolves, treat
  // partner status as unknown and render no cost figures at all — a partner
  // module must never flash wholesale/resale numbers while loading.
  const modulesReady = modules != null;
  const partnerIds = new Set(
    (modules ?? []).filter(m => m.categorySlug === 'partners').map(m => m.id),
  );
  const isPartnerModule = (id: number) => partnerIds.has(id);

  const visiblePricing = (lockedModuleId != null
    ? pricing?.filter(p => p.id === lockedModuleId)
    : pricing) || [];
  const selectedPricing = visiblePricing.filter(p => selectedModules.includes(p.id));
  // Pricing figures must never render before the pricing query resolves —
  // otherwise a locked partner flow could flash retail UI ($0 totals, markup
  // toggle) while pricing is still loading.
  const pricingReady = pricing != null;
  // Partner Integrations are billed directly by the partner — no charge,
  // retail price, or markup applies. When everything in view is a partner
  // module, hide all cost figures and the markup toggle entirely. For a
  // locked module, classify from module metadata directly so partner status
  // is known even while pricing is still loading.
  const allVisiblePartner = lockedModuleId != null
    ? modulesReady && isPartnerModule(lockedModuleId)
    : visiblePricing.length > 0 && visiblePricing.every(p => isPartnerModule(p.id));
  const allSelectedPartner = lockedModuleId != null
    ? modulesReady && isPartnerModule(lockedModuleId)
    : selectedPricing.length > 0 && selectedPricing.every(p => isPartnerModule(p.id));
  const cadenceOf = (p: NonNullable<typeof pricing>[number]) =>
    cadences[p.id] === 'biweekly' && p.resalePriceBiweekly != null ? 'biweekly' : 'monthly';
  const wholesaleFor = (p: NonNullable<typeof pricing>[number]) =>
    cadenceOf(p) === 'biweekly' ? (p.wholesalePriceBiweekly ?? p.wholesalePrice) : p.wholesalePrice;
  const resaleFor = (p: NonNullable<typeof pricing>[number]) =>
    cadenceOf(p) === 'biweekly' ? (p.resalePriceBiweekly ?? p.resalePrice) : p.resalePrice;
  const marginFor = (p: NonNullable<typeof pricing>[number]) =>
    cadenceOf(p) === 'biweekly' ? (p.marginBiweekly ?? p.margin) : p.margin;
  const chargeFor = (p: NonNullable<typeof pricing>[number]) =>
    applyMarkup ? resaleFor(p) : wholesaleFor(p);
  const totalResale = selectedPricing.reduce((sum, p) => sum + chargeFor(p), 0);
  const totalMargin = applyMarkup ? selectedPricing.reduce((sum, p) => sum + marginFor(p), 0) : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-6 py-4">
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">1. Select Target Tenant</label>
              <Select value={selectedTenant} onValueChange={setSelectedTenant}>
                <SelectTrigger data-testid="select-checkout-tenant">
                  <SelectValue placeholder="Choose tenant..." />
                </SelectTrigger>
                <SelectContent>
                  {tenants?.map(t => (
                    <SelectItem key={t.id} value={t.id.toString()}>{t.brandName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium flex justify-between items-center">
                <span>{lockedModuleId != null ? '2. Module' : '2. Select Modules'}</span>
                {allVisiblePartner ? (
                  <span className="text-xs font-normal text-muted-foreground" data-testid="text-partner-activation">
                    Partner activation
                  </span>
                ) : !modulesReady || !pricingReady ? null : (
                  <div className="flex items-center space-x-2">
                    <Checkbox id="markup" checked={applyMarkup} onCheckedChange={(c) => setApplyMarkup(!!c)} />
                    <label htmlFor="markup" className="text-xs font-normal cursor-pointer text-muted-foreground">Apply Retail Pricing</label>
                  </div>
                )}
              </label>
              <div className="border rounded-md h-[240px] overflow-y-auto p-2 space-y-1">
                {visiblePricing.map(p => {
                  const isSelected = selectedModules.includes(p.id);
                  const hasBiweekly = p.resalePriceBiweekly != null;
                  const cadence = cadenceOf(p);
                  return (
                    <div key={p.id} className="p-2 hover:bg-muted/50 rounded-sm">
                      <div
                        className={`flex items-center space-x-3 ${lockedModuleId != null ? '' : 'cursor-pointer'}`}
                        onClick={() => toggleModule(p.id)}
                      >
                        <Checkbox
                          checked={isSelected}
                          disabled={lockedModuleId != null}
                          onCheckedChange={() => toggleModule(p.id)}
                        />
                        <div className="flex-1 flex justify-between items-center text-sm">
                          <span>{p.name}</span>
                          {!modulesReady || !pricingReady ? null : isPartnerModule(p.id) ? (
                            <span className="text-xs text-muted-foreground">Included</span>
                          ) : (
                            <span className="font-mono text-muted-foreground">
                              {formatCurrency(chargeFor(p))}{hasBiweekly && cadence === 'biweekly' ? '/2wk' : ''}
                            </span>
                          )}
                        </div>
                      </div>
                      {isSelected && hasBiweekly && (
                        <div className="flex gap-1 mt-2 ml-7" data-testid={`cadence-toggle-${p.id}`}>
                          {(['monthly', 'biweekly'] as const).map(c => (
                            <button
                              key={c}
                              type="button"
                              onClick={(e) => { e.stopPropagation(); setCadences(prev => ({ ...prev, [p.id]: c })); }}
                              className={`px-2 py-0.5 rounded-full text-[11px] border transition-colors ${cadence === c ? 'bg-foreground text-background border-foreground' : 'border-border text-muted-foreground hover:bg-muted'}`}
                              data-testid={`button-cadence-${c}-${p.id}`}
                            >
                              {c === 'monthly' ? 'Monthly' : 'Bi-Weekly'}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="bg-muted/30 p-6 rounded-lg border flex flex-col justify-between">
            <div>
              <h3 className="font-bold border-b pb-2 mb-4 flex items-center gap-2">
                <CreditCard className="w-4 h-4 text-muted-foreground" />
                Order Summary
              </h3>

              <div className="space-y-3 text-sm">
                {selectedPricing.map(p => (
                  <div key={p.id} className="flex justify-between items-center">
                    <span className="text-muted-foreground truncate pr-4">
                      {p.name}
                      {cadenceOf(p) === 'biweekly' && (
                        <Badge variant="outline" className="ml-2 text-[9px] uppercase align-middle">Bi-Weekly</Badge>
                      )}
                    </span>
                    {!modulesReady || !pricingReady ? null : isPartnerModule(p.id) ? (
                      <span className="text-xs text-muted-foreground shrink-0">Included</span>
                    ) : (
                      <span className="font-mono shrink-0">
                        {formatCurrency(chargeFor(p))}
                        <span className="text-muted-foreground text-xs">{cadenceOf(p) === 'biweekly' ? '/2wk' : '/mo'}</span>
                      </span>
                    )}
                  </div>
                ))}
                {selectedPricing.length === 0 && (
                  <div className="text-center text-muted-foreground italic py-4">No modules selected</div>
                )}
              </div>
            </div>

            <div className="pt-4 border-t mt-4 space-y-2">
              {!modulesReady ? null : allSelectedPartner ? (
                /* Partner pass-through summary is safe to show while pricing
                   loads — it contains no dollar figures. */
                <div className="space-y-1" data-testid="summary-passthrough">
                  <div className="font-bold">Partner activation — no charge</div>
                  <div className="text-xs text-muted-foreground">
                    Partner products are activated at no charge — the partner bills the client
                    directly.
                  </div>
                </div>
              ) : !pricingReady ? null : (
                <>
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-emerald-600">Profit Margin</span>
                    <span className="font-mono text-emerald-600">+{formatCurrency(totalMargin)}</span>
                  </div>
                  <div className="flex justify-between items-center pt-2">
                    <span className="font-bold text-lg">Total Charge</span>
                    <span className="font-mono font-bold text-2xl">{formatCurrency(totalResale)}</span>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {isOffline && (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
            data-testid="alert-offline-checkout"
          >
            <WifiOff className="size-4 shrink-0" />
            You're offline — transactions are disabled until the connection is restored. Your
            selections will be kept while this dialog stays open.
          </div>
        )}
        <div className="flex justify-end gap-2 pt-4 border-t">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={!selectedTenant || selectedModules.length === 0 || simulateCheckout.isPending || isOffline}
            onClick={handleSimulate}
            className="gap-2"
            data-testid="button-run-transaction"
          >
            {simulateCheckout.isPending ? 'Processing...' : isOffline ? 'Offline — can’t run' : (
              <>Run Transaction <ArrowRight className="w-4 h-4" /></>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
