import { useMemo, useState } from 'react';
import { useGetAdminComplianceSummary } from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/shared/StatCard';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatCurrency } from '@/lib/format';
import { useToast } from '@/hooks/use-toast';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { AlertTriangle, Download, FileSpreadsheet, RefreshCw, Scale, ShieldCheck, TrendingUp } from 'lucide-react';

/**
 * Master compliance dashboard (admin-only).
 *
 * Every figure comes from the server-side, append-only platform ledger — the
 * single reproducible source for money-relevant activity — via the
 * period-scoped summary endpoint. The Export button downloads the
 * server-generated CSV compliance report (the canonical export, replacing
 * the old client-side CSV utility).
 */

const PERIODS: { value: string; label: string; days: number }[] = [
  { value: '7', label: 'Last 7 days', days: 7 },
  { value: '30', label: 'Last 30 days', days: 30 },
  { value: '90', label: 'Last 90 days', days: 90 },
  { value: '365', label: 'Last 12 months', days: 365 },
];

const SOURCE_LABELS: Record<string, string> = {
  module_subscription: 'Module subscriptions',
  visit_checkout: 'Visit checkouts',
  plan_purchase: 'Plan purchases',
  plan_renewal: 'Plan renewals',
  deposit_captured: 'Deposit fees captured',
  deposit_released: 'Deposit holds released',
  deposit_failed: 'Deposit holds failed',
};

export default function Compliance() {
  const [periodDays, setPeriodDays] = useState('30');
  const { toast } = useToast();
  const [isExporting, setIsExporting] = useState(false);

  // Stable period bounds per selection (recomputed only when the preset
  // changes) so the query key doesn't churn every render.
  const { from, to } = useMemo(() => {
    const days = PERIODS.find((p) => p.value === periodDays)?.days ?? 30;
    const now = new Date();
    return {
      from: new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString(),
      to: now.toISOString(),
    };
  }, [periodDays]);

  const { data: summary, isLoading, refetch } = useGetAdminComplianceSummary({ from, to });

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const base = import.meta.env.BASE_URL;
      const res = await fetch(
        `${base}api/admin/compliance/export?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        { credentials: 'include' },
      );
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const filename =
        /filename="([^"]+)"/.exec(disposition)?.[1] ??
        `compliance-report-${to.slice(0, 10)}.csv`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast({ title: 'Report Downloaded', description: `Saved ${filename}` });
    } catch {
      toast({
        title: 'Export Failed',
        description: "The server-side compliance report couldn't be generated. Try again.",
        variant: 'destructive',
      });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500" data-testid="compliance-dashboard">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Scale className="w-7 h-7 text-primary" /> Compliance Ledger
          </h1>
          <p className="text-muted-foreground mt-1">
            Platform-wide financial health from the append-only revenue ledger. Figures are immutable and reproducible.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={periodDays} onValueChange={setPeriodDays}>
            <SelectTrigger className="w-[180px]" data-testid="select-compliance-period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIODS.map((p) => (
                <SelectItem key={p.value} value={p.value} data-testid={`period-${p.value}`}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button className="gap-2" onClick={handleExport} disabled={isExporting} data-testid="button-export-compliance">
            <Download className="w-4 h-4" /> {isExporting ? 'Exporting…' : 'Export CSV Report'}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-32 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-[300px] w-full rounded-xl" />
        </div>
      ) : !summary ? (
        <Card className="border-dashed border-destructive/40 shadow-none" data-testid="compliance-error">
          <CardContent className="p-10 flex flex-col items-center justify-center text-center gap-4">
            <AlertTriangle className="w-8 h-8 text-destructive" />
            <div>
              <div className="text-lg font-semibold">Couldn't load the compliance summary</div>
              <p className="text-sm text-muted-foreground mt-1">Check your connection and try again.</p>
            </div>
            <Button variant="outline" onClick={() => refetch()} data-testid="compliance-error-retry">
              <RefreshCw className="w-4 h-4 mr-2" /> Retry
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <StatCard
              title="Ledger Entries"
              value={summary.totals.entryCount.toString()}
              icon={FileSpreadsheet}
              subtitle="Money events this period"
            />
            <StatCard
              title="Gross Volume"
              value={formatCurrency(summary.totals.grossAmount)}
              icon={TrendingUp}
              subtitle="All money moved"
            />
            <StatCard
              title="Platform Margin"
              value={formatCurrency(summary.totals.platformMargin)}
              icon={Scale}
              subtitle="Realized (partner modules pass through at $0)"
            />
            <StatCard
              title="Deposit Fees Captured"
              value={formatCurrency(summary.depositOutcomes.capturedFees)}
              icon={ShieldCheck}
              subtitle={`${summary.depositOutcomes.captured} captured · ${summary.depositOutcomes.released} released · ${summary.depositOutcomes.failed} failed`}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Card className="lg:col-span-2 border-none shadow-md">
              <CardHeader>
                <CardTitle>MRR by Module Category</CardTitle>
                <CardDescription>
                  Monthly-equivalent subscription revenue from persisted charged amounts — partner categories are pass-through with zero margin
                </CardDescription>
              </CardHeader>
              <CardContent className="h-[300px]" data-testid="chart-mrr-by-category">
                {summary.mrrByCategory.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                    No module subscriptions yet.
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={summary.mrrByCategory}>
                      <XAxis dataKey="category" fontSize={12} tickLine={false} axisLine={false} />
                      <YAxis fontSize={12} tickLine={false} axisLine={false} tickFormatter={(val) => `$${val}`} />
                      <Tooltip
                        formatter={(value: number, name: string) => [
                          formatCurrency(value),
                          name === 'mrr' ? 'MRR' : 'Platform Margin',
                        ]}
                        contentStyle={{ fontFamily: 'var(--font-sans)', borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                      />
                      <Bar dataKey="mrr" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="platformMargin" fill="hsl(var(--chart-2, 160 60% 45%))" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            <Card className="border-none shadow-md">
              <CardHeader>
                <CardTitle>Transaction Volume</CardTitle>
                <CardDescription>Ledger entries by source this period</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3" data-testid="list-volume-by-source">
                {summary.bySource.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No activity in this period.</p>
                ) : (
                  summary.bySource.map((s) => (
                    <div key={s.source} className="flex items-center justify-between gap-2" data-testid={`source-row-${s.source}`}>
                      <div className="flex items-center gap-2 min-w-0">
                        <Badge variant="secondary" className="shrink-0">{s.entryCount}</Badge>
                        <span className="text-sm truncate">{SOURCE_LABELS[s.source] ?? s.source}</span>
                      </div>
                      <span className="text-sm font-mono font-medium">{formatCurrency(s.amount)}</span>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </div>

          <Card className="border-none shadow-md">
            <CardHeader>
              <CardTitle>Per-Tenant Revenue Contribution</CardTitle>
              <CardDescription>All ledger activity attributed to each business over the selected period</CardDescription>
            </CardHeader>
            <CardContent>
              {summary.tenantContributions.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center" data-testid="text-no-contributions">
                  No ledger activity in this period.
                </p>
              ) : (
                <div className="rounded-md border border-border overflow-hidden">
                  <Table data-testid="table-tenant-contributions">
                    <TableHeader className="bg-muted/50">
                      <TableRow>
                        <TableHead>Tenant</TableHead>
                        <TableHead className="text-right">Entries</TableHead>
                        <TableHead className="text-right">Revenue</TableHead>
                        <TableHead className="text-right">Platform Margin</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {summary.tenantContributions.map((t) => (
                        <TableRow key={t.tenantId ?? 'legacy'} data-testid={`tenant-contribution-${t.tenantId ?? 'legacy'}`}>
                          <TableCell className="font-medium">{t.brandName}</TableCell>
                          <TableCell className="text-right font-mono">{t.entryCount}</TableCell>
                          <TableCell className="text-right font-mono">{formatCurrency(t.amount)}</TableCell>
                          <TableCell className="text-right font-mono">{formatCurrency(t.platformMargin)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
