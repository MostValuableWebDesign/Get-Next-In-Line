import { useState } from 'react';
import { useGetBillingSummary, useGetModulesPricing } from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CheckoutSimulationDialog } from '@/components/checkout/CheckoutSimulationDialog';
import { formatCurrency } from '@/lib/format';
import { ShoppingCart } from 'lucide-react';
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
            <CardDescription>Retail pricing and profit margin across all modules</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border border-border overflow-hidden">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Module Name</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-right font-bold">Retail Price</TableHead>
                    <TableHead className="text-right text-emerald-600">Profit Margin</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pricing?.map(p => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">{p.name}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-[10px] uppercase">{p.category}</Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono font-bold">{formatCurrency(p.resalePrice)}</TableCell>
                      <TableCell className="text-right font-mono text-emerald-600 font-medium" data-testid={`pricing-margin-${p.id}`}>
                        +{formatCurrency(p.margin)}
                        {p.resalePrice > 0 && (
                          <span className="text-xs text-emerald-600/80"> ({Math.round((p.margin / p.resalePrice) * 100)}%)</span>
                        )}
                      </TableCell>
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

  return (
    <>
      <Button
        variant="default"
        className="gap-2 bg-foreground text-background hover:bg-foreground/90"
        onClick={() => setOpen(true)}
      >
        <ShoppingCart className="w-4 h-4" /> Simulate Checkout
      </Button>
      <CheckoutSimulationDialog
        open={open}
        onOpenChange={setOpen}
        title="Stripe Checkout Simulation"
        description="Simulate a client self-serving modules via the tenant portal."
      />
    </>
  );
}
