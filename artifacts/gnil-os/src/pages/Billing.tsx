import { useState } from 'react';
import { useGetBillingSummary, useGetModulesPricing, useListTenants, useSimulateCheckout } from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { formatCurrency, formatPercent } from '@/lib/format';
import { CreditCard, ShoppingCart, ArrowRight, WifiOff } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useIsOffline } from '@/hooks/use-online';
import { Skeleton } from '@/components/ui/skeleton';

export default function Billing() {
  const { data: summary, isLoading: isLoadingSummary } = useGetBillingSummary();
  const { data: pricing, isLoading: isLoadingPricing } = useGetModulesPricing();
  
  if (isLoadingSummary || isLoadingPricing) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Skeleton className="md:col-span-2 h-[400px]" />
          <Skeleton className="h-[400px]" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Billing & Finance</h1>
          <p className="text-muted-foreground mt-1">Review revenue streams, margins, and run checkout simulations.</p>
        </div>
        <CheckoutSimulationModal />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="md:col-span-2 border-none shadow-md">
          <CardHeader>
            <CardTitle>Module Pricing Matrix</CardTitle>
            <CardDescription>Current wholesale vs. resale pricing across all modules</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border border-border overflow-hidden">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Module Name</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-right">Wholesale</TableHead>
                    <TableHead className="text-right">Markup</TableHead>
                    <TableHead className="text-right font-bold">Resale</TableHead>
                    <TableHead className="text-right text-emerald-600">Margin</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pricing?.map(p => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">{p.name}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-[10px] uppercase">{p.category}</Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground">{formatCurrency(p.wholesalePrice)}</TableCell>
                      <TableCell className="text-right font-mono">{p.markupPercent}%</TableCell>
                      <TableCell className="text-right font-mono font-bold">{formatCurrency(p.resalePrice)}</TableCell>
                      <TableCell className="text-right font-mono text-emerald-600 font-medium">+{formatCurrency(p.margin)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card className="border-none shadow-md bg-primary text-primary-foreground">
            <CardHeader className="pb-2">
              <CardTitle className="text-primary-foreground/80 font-medium text-sm uppercase tracking-wider">Total MRR</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-4xl font-bold font-mono tracking-tight">{formatCurrency(summary?.totalMrr || 0)}</div>
            </CardContent>
          </Card>

          <Card className="border-none shadow-md">
            <CardHeader>
              <CardTitle>MRR by Category</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {summary?.byCategory.map((c) => (
                  <div key={c.category} className="flex items-center justify-between">
                    <span className="font-medium text-sm uppercase tracking-wider text-muted-foreground">{c.category}</span>
                    <span className="font-mono font-bold text-foreground">{formatCurrency(c.mrr)}</span>
                  </div>
                ))}
                {!summary?.byCategory.length && (
                  <div className="text-center text-sm text-muted-foreground py-4">No categories</div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="border-none shadow-md">
            <CardHeader>
              <CardTitle>Top Tenants by MRR</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {summary?.topTenants.map((t, idx) => (
                  <div key={t.tenantId} className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground">
                        {idx + 1}
                      </div>
                      <span className="font-medium">{t.brandName}</span>
                    </div>
                    <span className="font-mono font-bold">{formatCurrency(t.mrr)}</span>
                  </div>
                ))}
                {!summary?.topTenants.length && (
                  <div className="text-center text-sm text-muted-foreground py-4">No active tenants</div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function CheckoutSimulationModal() {
  const [open, setOpen] = useState(false);
  const { data: tenants } = useListTenants();
  const { data: pricing } = useGetModulesPricing();
  const simulateCheckout = useSimulateCheckout();
  const { toast } = useToast();
  const isOffline = useIsOffline();

  const [selectedTenant, setSelectedTenant] = useState<string>('');
  const [selectedModules, setSelectedModules] = useState<number[]>([]);
  const [applyMarkup, setApplyMarkup] = useState(true);
  const [cadences, setCadences] = useState<Record<number, 'monthly' | 'biweekly'>>({});

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
        setOpen(false);
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
    setSelectedModules(prev => 
      prev.includes(id) ? prev.filter(m => m !== id) : [...prev, id]
    );
  };

  const selectedPricing = pricing?.filter(p => selectedModules.includes(p.id)) || [];
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
  const totalWholesale = selectedPricing.reduce((sum, p) => sum + wholesaleFor(p), 0);
  const totalResale = selectedPricing.reduce((sum, p) => sum + chargeFor(p), 0);
  const totalMargin = applyMarkup ? selectedPricing.reduce((sum, p) => sum + marginFor(p), 0) : 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="default" className="gap-2 bg-foreground text-background hover:bg-foreground/90">
          <ShoppingCart className="w-4 h-4" /> Simulate Checkout
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Stripe Checkout Simulation</DialogTitle>
          <DialogDescription>
            Simulate a client self-serving modules via the tenant portal.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-6 py-4">
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">1. Select Target Tenant</label>
              <Select value={selectedTenant} onValueChange={setSelectedTenant}>
                <SelectTrigger>
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
                <span>2. Select Modules</span>
                <div className="flex items-center space-x-2">
                  <Checkbox id="markup" checked={applyMarkup} onCheckedChange={(c) => setApplyMarkup(!!c)} />
                  <label htmlFor="markup" className="text-xs font-normal cursor-pointer text-muted-foreground">Apply Agency Markup</label>
                </div>
              </label>
              <div className="border rounded-md h-[240px] overflow-y-auto p-2 space-y-1">
                {pricing?.map(p => {
                  const isSelected = selectedModules.includes(p.id);
                  const hasBiweekly = p.resalePriceBiweekly != null;
                  const cadence = cadenceOf(p);
                  return (
                    <div key={p.id} className="p-2 hover:bg-muted/50 rounded-sm">
                      <div className="flex items-center space-x-3 cursor-pointer" onClick={() => toggleModule(p.id)}>
                        <Checkbox checked={isSelected} onCheckedChange={() => toggleModule(p.id)} />
                        <div className="flex-1 flex justify-between items-center text-sm">
                          <span>{p.name}</span>
                          <span className="font-mono text-muted-foreground">
                            {formatCurrency(chargeFor(p))}{hasBiweekly && cadence === 'biweekly' ? '/2wk' : ''}
                          </span>
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
                    <span className="font-mono shrink-0">
                      {formatCurrency(chargeFor(p))}
                      <span className="text-muted-foreground text-xs">{cadenceOf(p) === 'biweekly' ? '/2wk' : '/mo'}</span>
                    </span>
                  </div>
                ))}
                {selectedPricing.length === 0 && (
                  <div className="text-center text-muted-foreground italic py-4">No modules selected</div>
                )}
              </div>
            </div>

            <div className="pt-4 border-t mt-4 space-y-2">
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground">Wholesale Cost (Agency pays)</span>
                <span className="font-mono">{formatCurrency(totalWholesale)}</span>
              </div>
              <div className="flex justify-between items-center text-sm">
                <span className="text-emerald-600">Agency Profit Margin</span>
                <span className="font-mono text-emerald-600">+{formatCurrency(totalMargin)}</span>
              </div>
              <div className="flex justify-between items-center pt-2">
                <span className="font-bold text-lg">Total Charge</span>
                <span className="font-mono font-bold text-2xl">{formatCurrency(totalResale)}</span>
              </div>
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
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
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
