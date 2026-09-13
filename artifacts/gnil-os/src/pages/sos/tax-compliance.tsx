import { useMemo, useState } from 'react';
import {
  listCoopComplianceLedger,
  type CoopComplianceLedgerEntry,
  useGetCoopComplianceSettings,
  useUpdateCoopComplianceSettings,
  getGetCoopComplianceSettingsQueryKey,
  useGetCoopComplianceSummary,
  getGetCoopComplianceSummaryQueryKey,
  useListCoopComplianceLedger,
  getListCoopComplianceLedgerQueryKey,
  useCreateCoopComplianceEntry,
  useListCoopPartnerPayouts,
  getListCoopPartnerPayoutsQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { Scale, Download, Plus, AlertTriangle } from 'lucide-react';
import { usePagedList } from '@/hooks/usePagedList';

/**
 * Co-Op Tax & Revenue Compliance Ledger — merchant-facing "Tax & Compliance"
 * page. Period summaries separating direct revenue from co-op income/expense
 * classes, the ledger detail, partner payout / 1099 tracking, per-tenant tax
 * rate settings, manual entry, and QuickBooks/Xero/audit CSV exports.
 * All tax figures are ESTIMATES from merchant-configured rates.
 */

const CATEGORY_LABELS: Record<string, string> = {
  perk_redemption: 'Perk redemption',
  referral_commission: 'Referral commission',
  sponsorship: 'Sponsorship',
  shared_expense: 'Shared expense',
};

function money(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function periodOptions(): { value: string; label: string }[] {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const q = Math.floor((m - 1) / 3) + 1;
  const opts: { value: string; label: string }[] = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const val = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    opts.push({ value: val, label: d.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }) });
  }
  opts.push({ value: `${y}-Q${q}`, label: `Q${q} ${y}` });
  if (q > 1) opts.push({ value: `${y}-Q${q - 1}`, label: `Q${q - 1} ${y}` });
  opts.push({ value: `${y}`, label: `Year ${y}` });
  opts.push({ value: `${y - 1}`, label: `Year ${y - 1}` });
  return opts;
}

const LEDGER_PAGE_SIZE = 50;

export default function TaxCompliancePage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const opts = useMemo(periodOptions, []);
  const [period, setPeriod] = useState(opts[0].value);
  const year = Number(period.slice(0, 4));

  const { data: summary, isLoading: summaryLoading } = useGetCoopComplianceSummary({ period });
  const { data: ledgerFirstPage, isLoading: ledgerLoading } = useListCoopComplianceLedger({
    period,
    limit: LEDGER_PAGE_SIZE,
  });
  // usePagedList resets its extra pages whenever the first page refreshes —
  // including period changes and post-mutation invalidations.
  const {
    items: ledger,
    hasMore: hasMoreLedger,
    loadingMore: loadingMoreLedger,
    loadMore: loadMoreLedger,
  } = usePagedList<CoopComplianceLedgerEntry>(ledgerFirstPage, LEDGER_PAGE_SIZE, (offset) =>
    listCoopComplianceLedger({ period, limit: LEDGER_PAGE_SIZE, offset }),
  );
  const { data: payouts } = useListCoopPartnerPayouts({ year });
  const { data: settings } = useGetCoopComplianceSettings();

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: getGetCoopComplianceSummaryQueryKey({ period }) });
    queryClient.invalidateQueries({
      queryKey: getListCoopComplianceLedgerQueryKey({ period, limit: LEDGER_PAGE_SIZE }),
    });
    queryClient.invalidateQueries({ queryKey: getListCoopPartnerPayoutsQueryKey({ year }) });
  };

  // ── settings form ──────────────────────────────────────────────────────────
  const [settingsDraft, setSettingsDraft] = useState<Record<string, string> | null>(null);
  const draft = settingsDraft ?? {
    stateRatePercent: String(settings?.stateRatePercent ?? 0),
    localRatePercent: String(settings?.localRatePercent ?? 0),
    salesRatePercent: String(settings?.salesRatePercent ?? 0),
    threshold1099: String(settings?.threshold1099 ?? 600),
  };
  const updateSettings = useUpdateCoopComplianceSettings({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetCoopComplianceSettingsQueryKey() });
        invalidateAll();
        setSettingsDraft(null);
        toast({ title: 'Tax settings saved', description: 'New rates apply to entries going forward only.' });
      },
      onError: () => toast({ title: 'Save failed', variant: 'destructive' }),
    },
  });

  // ── manual entry form ──────────────────────────────────────────────────────
  const [entry, setEntry] = useState({
    category: 'sponsorship',
    direction: 'expense',
    grossAmount: '',
    description: '',
    payeeName: '',
  });
  const createEntry = useCreateCoopComplianceEntry({
    mutation: {
      onSuccess: () => {
        invalidateAll();
        setEntry({ category: 'sponsorship', direction: 'expense', grossAmount: '', description: '', payeeName: '' });
        toast({ title: 'Entry logged' });
      },
      onError: () => toast({ title: 'Could not log entry', variant: 'destructive' }),
    },
  });

  // ── export ─────────────────────────────────────────────────────────────────
  const [exporting, setExporting] = useState(false);
  const handleExport = async (layout: string, dataset: string) => {
    setExporting(true);
    try {
      const base = import.meta.env.BASE_URL;
      const res = await fetch(
        `${base}api/coop/compliance/export?period=${encodeURIComponent(period)}&layout=${layout}&dataset=${dataset}`,
        {
          credentials: 'include',
        },
      );
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const filename =
        /filename="([^"]+)"/.exec(disposition)?.[1] ?? `coop-${dataset}-${layout}-${period}.csv`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast({ title: 'Export downloaded', description: filename });
    } catch {
      toast({ title: 'Export failed', variant: 'destructive' });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500" data-testid="tax-compliance-page">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Scale className="w-7 h-7 text-primary" /> Tax & Compliance
          </h1>
          <p className="text-muted-foreground mt-1">
            Audit-ready co-op financial ledger, estimated tax obligations, and 1099 payout tracking.
          </p>
        </div>
        <Select value={period} onValueChange={setPeriod}>
          <SelectTrigger className="w-[200px]" data-testid="select-tax-period">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {opts.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" data-testid="tax-disclaimer">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
        <span>
          {summary?.disclaimer ??
            'All tax figures are estimates computed from your configured rates — not tax advice. Consult your accountant before filing.'}
        </span>
      </div>

      {/* Period summary */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Period Summary</CardTitle>
            <CardDescription>Direct service revenue separated from co-op income and shared expenses.</CardDescription>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={exporting} onClick={() => handleExport('quickbooks', 'ledger')} data-testid="button-export-quickbooks">
              <Download className="w-4 h-4 mr-1" /> QuickBooks
            </Button>
            <Button variant="outline" size="sm" disabled={exporting} onClick={() => handleExport('xero', 'ledger')} data-testid="button-export-xero">
              <Download className="w-4 h-4 mr-1" /> Xero
            </Button>
            <Button variant="outline" size="sm" disabled={exporting} onClick={() => handleExport('audit', 'ledger')} data-testid="button-export-audit">
              <Download className="w-4 h-4 mr-1" /> Audit CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {summaryLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="summary-table">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-2 pr-4">Revenue class</th>
                    <th className="py-2 pr-4 text-right">Income</th>
                    <th className="py-2 pr-4 text-right">Expense</th>
                    <th className="py-2 pr-4 text-right">Net</th>
                    <th className="py-2 pr-4 text-right">Est. tax due</th>
                    <th className="py-2 text-right">Entries</th>
                  </tr>
                </thead>
                <tbody>
                  {summary?.sections.map((s) => (
                    <tr key={s.key} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-medium">{s.label}</td>
                      <td className="py-2 pr-4 text-right">{money(s.grossIncome)}</td>
                      <td className="py-2 pr-4 text-right">{money(s.grossExpense)}</td>
                      <td className="py-2 pr-4 text-right">{money(s.net)}</td>
                      <td className="py-2 pr-4 text-right">{money(s.estimatedTax)}</td>
                      <td className="py-2 text-right">{s.entryCount}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-semibold">
                    <td className="py-2 pr-4">Total estimated tax</td>
                    <td colSpan={4} className="py-2 pr-4 text-right" data-testid="text-total-estimated-tax">
                      {money(summary?.totalEstimatedTax ?? 0)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Ledger detail */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Compliance Ledger</CardTitle>
            <CardDescription>
              Every co-op financial event in the period, with the tax-rate snapshot in force when it was logged.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {ledgerLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : !ledger || ledger.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4" data-testid="ledger-empty">
                No ledger entries in this period yet. Perk redemptions with a monetary value are logged automatically; sponsorships and shared expenses can be added below.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="ledger-table">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b">
                      <th className="py-2 pr-4">Date</th>
                      <th className="py-2 pr-4">Category</th>
                      <th className="py-2 pr-4">Counterpart / payee</th>
                      <th className="py-2 pr-4">Description</th>
                      <th className="py-2 pr-4 text-right">Gross</th>
                      <th className="py-2 pr-4 text-right">Rates (S/L/Sa)</th>
                      <th className="py-2 text-right">Est. tax</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.map((e) => (
                      <tr key={e.id} className="border-b last:border-0" data-testid={`ledger-row-${e.id}`}>
                        <td className="py-2 pr-4 whitespace-nowrap">{e.occurredAt.slice(0, 10)}</td>
                        <td className="py-2 pr-4">
                          <Badge variant={e.direction === 'income' ? 'default' : 'secondary'}>
                            {CATEGORY_LABELS[e.category] ?? e.category} · {e.direction}
                          </Badge>
                        </td>
                        <td className="py-2 pr-4">{e.counterpartTenantName ?? e.payeeName ?? '—'}</td>
                        <td className="py-2 pr-4 max-w-[280px] truncate">{e.description ?? '—'}</td>
                        <td className="py-2 pr-4 text-right">{money(e.grossAmount)}</td>
                        <td className="py-2 pr-4 text-right text-muted-foreground">
                          {e.stateRatePercent}% / {e.localRatePercent}% / {e.salesRatePercent}%
                        </td>
                        <td className="py-2 text-right">{money(e.estimatedTaxAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {hasMoreLedger && (
                  <div className="pt-3 flex justify-center">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={loadingMoreLedger}
                      onClick={loadMoreLedger}
                      data-testid="button-ledger-load-more"
                    >
                      {loadingMoreLedger ? 'Loading…' : 'Load more entries'}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Partner payouts / 1099 */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Partner Payouts & 1099 Tracker</CardTitle>
              <CardDescription>
                Calendar-year {year} totals per payee; flagged at {money(payouts?.threshold1099 ?? 600)}.
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" disabled={exporting} onClick={() => handleExport('audit', 'payouts')} data-testid="button-export-payouts">
              <Download className="w-4 h-4 mr-1" /> 1099 CSV
            </Button>
          </CardHeader>
          <CardContent>
            {!payouts || payouts.payouts.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4" data-testid="payouts-empty">
                No partner payouts recorded for {year}.
              </p>
            ) : (
              <div className="space-y-2">
                {payouts.payouts.map((p) => (
                  <div key={p.payeeKey} className="flex items-center justify-between rounded-md border p-3" data-testid={`payout-row-${p.payeeKey}`}>
                    <div>
                      <p className="font-medium text-sm">{p.payeeName}</p>
                      <p className="text-xs text-muted-foreground">
                        {p.thresholdCrossed
                          ? p.form1099Ready
                            ? '1099 data ready'
                            : `1099 required — missing: ${p.missingFields.join(', ')}`
                          : `${money(p.remainingBeforeThreshold)} below threshold`}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold text-sm">{money(p.totalPaid)}</p>
                      {p.thresholdCrossed && (
                        <Badge variant="destructive" data-testid={`badge-1099-${p.payeeKey}`}>1099</Badge>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Settings + manual entry */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Tax Rate Settings</CardTitle>
              <CardDescription>Estimated rates for this business. Changes only affect future entries — historical entries keep their logged rates.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                {(
                  [
                    ['stateRatePercent', 'State rate %'],
                    ['localRatePercent', 'Local rate %'],
                    ['salesRatePercent', 'Sales tax %'],
                    ['threshold1099', '1099 threshold $'],
                  ] as const
                ).map(([key, label]) => (
                  <div key={key}>
                    <Label htmlFor={`input-${key}`}>{label}</Label>
                    <Input
                      id={`input-${key}`}
                      data-testid={`input-${key}`}
                      type="number"
                      min="0"
                      step="0.01"
                      value={draft[key]}
                      onChange={(e) => setSettingsDraft({ ...draft, [key]: e.target.value })}
                    />
                  </div>
                ))}
              </div>
              <Button
                data-testid="button-save-tax-settings"
                disabled={updateSettings.isPending || settingsDraft == null}
                onClick={() =>
                  updateSettings.mutate({
                    data: {
                      stateRatePercent: Number(draft.stateRatePercent) || 0,
                      localRatePercent: Number(draft.localRatePercent) || 0,
                      salesRatePercent: Number(draft.salesRatePercent) || 0,
                      threshold1099: Number(draft.threshold1099) || 0,
                    },
                  })
                }
              >
                Save settings
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Log Manual Entry</CardTitle>
              <CardDescription>Sponsorships, shared event expenses, and referral commissions not captured automatically.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Category</Label>
                  <Select value={entry.category} onValueChange={(v) => setEntry({ ...entry, category: v })}>
                    <SelectTrigger data-testid="select-entry-category"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="sponsorship">Sponsorship</SelectItem>
                      <SelectItem value="shared_expense">Shared expense</SelectItem>
                      <SelectItem value="referral_commission">Referral commission</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Direction</Label>
                  <Select value={entry.direction} onValueChange={(v) => setEntry({ ...entry, direction: v })}>
                    <SelectTrigger data-testid="select-entry-direction"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="income">Income</SelectItem>
                      <SelectItem value="expense">Expense</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="input-entry-amount">Amount $</Label>
                  <Input
                    id="input-entry-amount"
                    data-testid="input-entry-amount"
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={entry.grossAmount}
                    onChange={(e) => setEntry({ ...entry, grossAmount: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="input-entry-payee">Payee (for 1099)</Label>
                  <Input
                    id="input-entry-payee"
                    data-testid="input-entry-payee"
                    value={entry.payeeName}
                    onChange={(e) => setEntry({ ...entry, payeeName: e.target.value })}
                    placeholder="Partner or agent name"
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="input-entry-description">Description</Label>
                <Input
                  id="input-entry-description"
                  data-testid="input-entry-description"
                  value={entry.description}
                  onChange={(e) => setEntry({ ...entry, description: e.target.value })}
                  placeholder="e.g. Spring street fair co-sponsorship"
                />
              </div>
              <Button
                data-testid="button-log-entry"
                disabled={createEntry.isPending || !entry.description || !(Number(entry.grossAmount) > 0)}
                onClick={() =>
                  createEntry.mutate({
                    data: {
                      category: entry.category as 'sponsorship' | 'shared_expense' | 'referral_commission',
                      direction: entry.direction as 'income' | 'expense',
                      grossAmount: Number(entry.grossAmount),
                      description: entry.description,
                      payeeName: entry.payeeName.trim() || null,
                    },
                  })
                }
              >
                <Plus className="w-4 h-4 mr-1" /> Log entry
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
