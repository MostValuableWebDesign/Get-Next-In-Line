import { useState } from 'react';
import {
  useGetMasterOverview,
  getGetMasterOverviewQueryKey,
  usePreviewSettlementCycle,
  getPreviewSettlementCycleQueryKey,
  useRunSettlement,
  useListSettlementCycles,
  getListSettlementCyclesQueryKey,
  useGetSettlementCycle,
  getGetSettlementCycleQueryKey,
  useGetSettlementStatement,
  getGetSettlementStatementQueryKey,
  useRunSettlementPayouts,
  type GetMasterOverviewParams,
  type SettlementCycle,
  type SettlementStatement,
  type SettlementPayout,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { StatCard } from '@/components/shared/StatCard';
import { useToast } from '@/hooks/use-toast';
import { formatCurrency } from '@/lib/format';
import {
  Activity, ArrowLeftRight, Banknote, CalendarCheck, DollarSign, Globe2, Handshake, History,
  Landmark, Scale, Ticket, Users,
} from 'lucide-react';

/**
 * Command Center — Master Overview & Settlement Clearinghouse.
 *
 * Network-wide executive KPIs (tenants, bookings, transaction volume, co-op
 * activity, cross-business financial flows) with period selection, plus the
 * end-of-cycle clearinghouse: preview unsettled inter-business obligations,
 * execute a settlement run that nets them into per-tenant statements, and
 * browse past (immutable) cycles.
 */
export default function MasterOverview() {
  const [period, setPeriod] = useState<'this_month' | 'last_month'>('this_month');
  const params: GetMasterOverviewParams = { period };
  const { data: overview, isLoading } = useGetMasterOverview(params, {
    query: { queryKey: getGetMasterOverviewQueryKey(params) },
  });

  const KIND_LABELS: Record<string, string> = {
    referral_fee: 'Referral fees',
    ad_pool_contribution: 'Ad-pool contributions',
    perk_obligation: 'Perk-driven balances',
    coverage_labor: 'Coverage labor charges',
  };

  return (
    <div className="space-y-8" data-testid="page-master-overview">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Globe2 className="w-7 h-7 text-primary" /> Master Overview
          </h1>
          <p className="text-muted-foreground mt-1">
            Network-wide executive indicators and the co-op settlement clearinghouse.
          </p>
        </div>
        <Select value={period} onValueChange={(v) => setPeriod(v as typeof period)}>
          <SelectTrigger className="w-[180px]" data-testid="select-overview-period">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="this_month">This month</SelectItem>
            <SelectItem value="last_month">Last month</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading || !overview ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => <Skeleton key={i} className="h-32 rounded-xl" />)}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <StatCard title="Active Tenants" value={overview.activeTenants.toString()} icon={Users} subtitle={`Of ${overview.totalTenants} total`} />
            <StatCard title="Bookings" value={overview.bookingsCount.toString()} icon={CalendarCheck} subtitle={overview.periodLabel} />
            <StatCard title="Transaction Volume" value={formatCurrency(overview.transactionVolume)} icon={DollarSign} subtitle={`${overview.transactionCount} transactions`} />
            <StatCard title="Perk Redemptions" value={overview.perkRedemptions.toString()} icon={Ticket} subtitle={overview.periodLabel} />
            <StatCard title="Active Partnerships" value={overview.partnershipsActive.toString()} icon={Handshake} subtitle={`${overview.newPartnerships} new ${overview.periodLabel.toLowerCase()}`} />
            <StatCard title="Cross-Business Flows" value={formatCurrency(overview.obligationVolume)} icon={ArrowLeftRight} subtitle={overview.periodLabel} />
            <StatCard title="Unsettled Balance" value={formatCurrency(overview.unsettledBalance)} icon={Scale} subtitle="Awaiting settlement" />
            <StatCard title="Suspended Tenants" value={overview.suspendedTenants.toString()} icon={Activity} subtitle="Requires attention" />
          </div>

          <Card className="border-none shadow-md" data-testid="card-flows-by-kind">
            <CardHeader>
              <CardTitle className="text-base">Financial Flows by Source</CardTitle>
              <CardDescription>Inter-business obligations recorded {overview.periodLabel.toLowerCase()}, by kind.</CardDescription>
            </CardHeader>
            <CardContent>
              {overview.flowsByKind.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="text-no-flows">
                  No cross-business obligations recorded in this period.
                </p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {overview.flowsByKind.map((f) => (
                    <div key={f.kind} className="border rounded-lg p-4" data-testid={`flow-kind-${f.kind}`}>
                      <div className="text-sm text-muted-foreground">{KIND_LABELS[f.kind] ?? f.kind}</div>
                      <div className="text-2xl font-bold font-mono">{formatCurrency(f.total)}</div>
                      <div className="text-xs text-muted-foreground">{f.count} entr{f.count === 1 ? 'y' : 'ies'}</div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <SettlementConsole />
      <CycleHistory />
    </div>
  );
}

// ── Settlement console: preview + run ────────────────────────────────────────

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

function defaultWindow() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { start: isoDate(start), end: isoDate(end) };
}

function SettlementConsole() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [{ start, end }, setWindow] = useState(defaultWindow);
  const [confirming, setConfirming] = useState(false);

  const valid = Boolean(start && end && new Date(start) < new Date(end));
  const previewParams = { periodStart: start, periodEnd: end };
  const { data: preview, isLoading } = usePreviewSettlementCycle(previewParams, {
    query: { queryKey: getPreviewSettlementCycleQueryKey(previewParams), enabled: valid },
  });

  const runSettlement = useRunSettlement({
    mutation: {
      onSuccess: (res) => {
        setConfirming(false);
        toast({
          title: `Settlement cycle #${res.cycle.id} closed`,
          description: `${res.cycle.entryCount} entries netted into ${res.statements.length} statements.`,
        });
        queryClient.invalidateQueries({ queryKey: getListSettlementCyclesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getPreviewSettlementCycleQueryKey(previewParams) });
        queryClient.invalidateQueries({ queryKey: getGetMasterOverviewQueryKey({ period: 'this_month' }) });
        queryClient.invalidateQueries({ queryKey: getGetMasterOverviewQueryKey({ period: 'last_month' }) });
      },
      onError: (err: unknown) => {
        setConfirming(false);
        const message = (err as { data?: { message?: string } })?.data?.message ?? 'Settlement run failed.';
        toast({ title: 'Settlement not executed', description: message, variant: 'destructive' });
      },
    },
  });

  return (
    <Card className="border-none shadow-md" data-testid="card-settlement-console">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Landmark className="w-5 h-5 text-primary" /> Settlement Clearinghouse
        </CardTitle>
        <CardDescription>
          Preview unsettled inter-business obligations in a window, then execute the end-of-cycle
          run: obligations are netted pairwise into per-tenant statements and marked settled.
          No money moves — this reconciles balances only.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Period start</Label>
            <Input type="date" value={start} onChange={(e) => setWindow((w) => ({ ...w, start: e.target.value }))} className="w-40" data-testid="input-settlement-start" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Period end (exclusive)</Label>
            <Input type="date" value={end} onChange={(e) => setWindow((w) => ({ ...w, end: e.target.value }))} className="w-40" data-testid="input-settlement-end" />
          </div>
          <Button
            disabled={!valid || !preview || preview.entryCount === 0 || runSettlement.isPending}
            onClick={() => setConfirming(true)}
            data-testid="button-run-settlement"
          >
            Run Settlement
          </Button>
        </div>

        {confirming && preview && (
          <div className="rounded-md border border-amber-400/60 bg-amber-500/5 p-3 text-sm space-y-2" data-testid="confirm-run-settlement">
            <p>
              Close this cycle now? <strong>{preview.entryCount}</strong> ledger entr{preview.entryCount === 1 ? 'y' : 'ies'} totaling{' '}
              <strong>{formatCurrency(preview.grossVolume)}</strong> will be netted into per-business statements and permanently
              marked settled. A closed cycle can be reviewed but never altered.
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={runSettlement.isPending}
                onClick={() => runSettlement.mutate({ data: { periodStart: new Date(start).toISOString(), periodEnd: new Date(end).toISOString() } })}
                data-testid="button-confirm-run-settlement"
              >
                Confirm &amp; Close Cycle
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirming(false)} data-testid="button-cancel-run-settlement">
                Cancel
              </Button>
            </div>
          </div>
        )}

        {!valid ? (
          <p className="text-sm text-muted-foreground">Pick a valid window to preview.</p>
        ) : isLoading || !preview ? (
          <Skeleton className="h-24 w-full rounded-lg" />
        ) : preview.entryCount === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-unsettled">
            No unsettled obligations in this window.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="text-sm" data-testid="text-preview-summary">
              <strong>{preview.entryCount}</strong> unsettled entr{preview.entryCount === 1 ? 'y' : 'ies'} ·{' '}
              gross <strong>{formatCurrency(preview.grossVolume)}</strong> ·{' '}
              {preview.statements.length} business{preview.statements.length === 1 ? '' : 'es'} involved
            </div>
            <StatementsTable statements={preview.statements} testIdPrefix="preview" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StatementsTable({ statements, testIdPrefix }: { statements: SettlementStatement[]; testIdPrefix: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground border-b">
            <th className="py-2 pr-3 font-medium">Business</th>
            <th className="py-2 px-3 font-medium text-right">Owes network</th>
            <th className="py-2 px-3 font-medium text-right">Owed by network</th>
            <th className="py-2 pl-3 font-medium text-right">Net balance</th>
          </tr>
        </thead>
        <tbody>
          {statements.map((s) => (
            <tr key={s.tenantId} className="border-b last:border-0" data-testid={`${testIdPrefix}-statement-${s.tenantId}`}>
              <td className="py-2 pr-3 font-medium">{s.tenantName}</td>
              <td className="py-2 px-3 text-right text-muted-foreground">{formatCurrency(s.totalOwedToOthers)}</td>
              <td className="py-2 px-3 text-right text-muted-foreground">{formatCurrency(s.totalOwedByOthers)}</td>
              <td className={`py-2 pl-3 text-right font-medium ${s.netAmount > 0 ? 'text-emerald-600' : s.netAmount < 0 ? 'text-red-500' : ''}`}>
                {formatCurrency(s.netAmount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Cycle history + statement drill-down ─────────────────────────────────────

function CycleHistory() {
  const { data: cycles, isLoading } = useListSettlementCycles({
    query: { queryKey: getListSettlementCyclesQueryKey() },
  });
  const [openCycle, setOpenCycle] = useState<SettlementCycle | null>(null);

  return (
    <Card className="border-none shadow-md" data-testid="card-cycle-history">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="w-5 h-5 text-primary" /> Past Settlement Cycles
        </CardTitle>
        <CardDescription>
          Closed cycles are auditable and read-only — drill into any cycle's per-business statements.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-24 w-full rounded-lg" />
        ) : !cycles || cycles.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-cycles">
            No settlement cycles yet. Run the first one from the clearinghouse above.
          </p>
        ) : (
          <div className="space-y-2" data-testid="list-settlement-cycles">
            {cycles.map((c) => (
              <div key={c.id} className="border rounded-lg p-4 flex flex-col md:flex-row md:items-center justify-between gap-3" data-testid={`row-cycle-${c.id}`}>
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">Cycle #{c.id}</span>
                    <Badge variant="secondary" className="capitalize">{c.status}</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(c.periodStart).toLocaleDateString()} – {new Date(c.periodEnd).toLocaleDateString()} ·{' '}
                    {c.entryCount} entries · gross {formatCurrency(c.grossVolume)} ·{' '}
                    executed {new Date(c.executedAt).toLocaleString()}
                  </div>
                </div>
                <Button size="sm" variant="outline" onClick={() => setOpenCycle(c)} data-testid={`button-view-cycle-${c.id}`}>
                  View Statements
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
      {openCycle && <CycleDetailDialog cycle={openCycle} onClose={() => setOpenCycle(null)} />}
    </Card>
  );
}

function PayoutBadge({ payout, netAmount }: { payout: SettlementPayout | null | undefined; netAmount: number }) {
  if (netAmount <= 0) return null;
  if (!payout) {
    return <Badge variant="outline" data-testid={`badge-payout-none`}>Payout pending</Badge>;
  }
  const styles: Record<string, string> = {
    paid: 'bg-emerald-600 text-white hover:bg-emerald-600',
    simulated: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 hover:bg-amber-500/15',
    failed: 'bg-red-600 text-white hover:bg-red-600',
    pending: '',
  };
  const labels: Record<string, string> = {
    paid: 'Paid via Stripe',
    simulated: 'Simulated payout',
    failed: 'Payout failed',
    pending: 'Payout pending',
  };
  return (
    <Badge
      variant={payout.status === 'pending' ? 'outline' : 'secondary'}
      className={styles[payout.status] ?? ''}
      title={payout.failureReason ?? undefined}
      data-testid={`badge-payout-${payout.status}`}
    >
      {labels[payout.status] ?? payout.status}
    </Badge>
  );
}

function CycleDetailDialog({ cycle, onClose }: { cycle: SettlementCycle; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: detail, isLoading } = useGetSettlementCycle(cycle.id, {
    query: { queryKey: getGetSettlementCycleQueryKey(cycle.id) },
  });
  const [statementTenantId, setStatementTenantId] = useState<number | null>(null);

  const runPayouts = useRunSettlementPayouts({
    mutation: {
      onSuccess: (res) => {
        const parts = [
          res.paidCount > 0 ? `${res.paidCount} paid via Stripe` : null,
          res.simulatedCount > 0 ? `${res.simulatedCount} simulated (no funds moved)` : null,
          res.failedCount > 0 ? `${res.failedCount} failed` : null,
          res.skippedCount > 0 ? `${res.skippedCount} already settled` : null,
        ].filter(Boolean);
        toast({
          title: `Payout run — cycle #${res.cycleId}`,
          description: parts.length > 0 ? parts.join(' · ') : 'No net-positive statements to pay out.',
          variant: res.failedCount > 0 ? 'destructive' : undefined,
        });
        queryClient.invalidateQueries({ queryKey: getGetSettlementCycleQueryKey(cycle.id) });
      },
      onError: (err: unknown) => {
        const message = (err as { data?: { message?: string } })?.data?.message ?? 'Payout run failed.';
        toast({ title: 'Payouts not executed', description: message, variant: 'destructive' });
      },
    },
  });

  const creditorStatements = detail?.statements.filter((s) => s.netAmount > 0) ?? [];
  const unsettled = creditorStatements.filter(
    (s) => !s.payout || s.payout.status === 'failed' || s.payout.status === 'pending',
  );

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto" data-testid={`dialog-cycle-${cycle.id}`}>
        <DialogHeader>
          <DialogTitle>Settlement Cycle #{cycle.id}</DialogTitle>
          <DialogDescription>
            {new Date(cycle.periodStart).toLocaleDateString()} – {new Date(cycle.periodEnd).toLocaleDateString()} ·{' '}
            {cycle.entryCount} ledger entries · gross {formatCurrency(cycle.grossVolume)} · read-only.
          </DialogDescription>
        </DialogHeader>
        {isLoading || !detail ? (
          <Skeleton className="h-32 w-full rounded-lg" />
        ) : statementTenantId != null ? (
          <StatementDetail
            cycleId={cycle.id}
            tenantId={statementTenantId}
            onBack={() => setStatementTenantId(null)}
          />
        ) : (
          <div className="space-y-3">
            {creditorStatements.length > 0 && (
              <div className="flex items-center justify-between gap-3 rounded-md border p-3" data-testid="payout-controls">
                <div className="text-sm text-muted-foreground">
                  {unsettled.length > 0 ? (
                    <>
                      <strong>{unsettled.length}</strong> of {creditorStatements.length} net-positive statement{creditorStatements.length === 1 ? '' : 's'} awaiting payout.
                    </>
                  ) : (
                    <>All {creditorStatements.length} net-positive statement{creditorStatements.length === 1 ? '' : 's'} paid out.</>
                  )}
                </div>
                <Button
                  size="sm"
                  disabled={runPayouts.isPending || unsettled.length === 0}
                  onClick={() => runPayouts.mutate({ cycleId: cycle.id })}
                  data-testid="button-run-payouts"
                >
                  <Banknote className="w-4 h-4 mr-1" />
                  {creditorStatements.some((s) => s.payout?.status === 'failed') ? 'Retry Payouts' : 'Pay Out Businesses'}
                </Button>
              </div>
            )}
            {detail.statements.map((s) => (
              <div key={s.tenantId} className="border rounded-lg p-3 flex items-center justify-between gap-3" data-testid={`cycle-statement-${s.tenantId}`}>
                <div>
                  <div className="font-medium text-sm">{s.tenantName}</div>
                  <div className="text-xs text-muted-foreground">
                    Owes {formatCurrency(s.totalOwedToOthers)} · owed {formatCurrency(s.totalOwedByOthers)}
                  </div>
                  {s.payout?.status === 'failed' && s.payout.failureReason && (
                    <div className="text-xs text-red-500 mt-0.5" data-testid={`text-payout-failure-${s.tenantId}`}>
                      {s.payout.failureReason}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <PayoutBadge payout={s.payout} netAmount={s.netAmount} />
                  <span className={`font-mono font-semibold ${s.netAmount > 0 ? 'text-emerald-600' : s.netAmount < 0 ? 'text-red-500' : ''}`}>
                    {formatCurrency(s.netAmount)}
                  </span>
                  <Button size="sm" variant="outline" onClick={() => setStatementTenantId(s.tenantId)} data-testid={`button-view-statement-${s.tenantId}`}>
                    Details
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StatementDetail({ cycleId, tenantId, onBack }: { cycleId: number; tenantId: number; onBack: () => void }) {
  const { data, isLoading } = useGetSettlementStatement(cycleId, tenantId, {
    query: { queryKey: getGetSettlementStatementQueryKey(cycleId, tenantId) },
  });

  if (isLoading || !data) return <Skeleton className="h-32 w-full rounded-lg" />;
  const s = data.statement;
  return (
    <div className="space-y-4" data-testid={`statement-detail-${tenantId}`}>
      <Button size="sm" variant="ghost" onClick={onBack}>← All statements</Button>
      <div>
        <div className="font-semibold">{s.tenantName}</div>
        <div className="text-sm text-muted-foreground">
          Net balance:{' '}
          <span className={`font-mono font-semibold ${s.netAmount > 0 ? 'text-emerald-600' : s.netAmount < 0 ? 'text-red-500' : ''}`}>
            {formatCurrency(s.netAmount)}
          </span>{' '}
          ({s.netAmount >= 0 ? 'receives from' : 'pays into'} the network)
        </div>
        {s.netAmount > 0 && (
          <div className="mt-1 flex items-center gap-2" data-testid={`statement-payout-${tenantId}`}>
            <PayoutBadge payout={s.payout} netAmount={s.netAmount} />
            {s.payout?.status === 'paid' && s.payout.providerRef && (
              <span className="text-xs text-muted-foreground font-mono">{s.payout.providerRef}</span>
            )}
            {s.payout?.status === 'failed' && s.payout.failureReason && (
              <span className="text-xs text-red-500">{s.payout.failureReason}</span>
            )}
          </div>
        )}
      </div>
      {s.lines.length > 0 && (
        <div>
          <div className="text-sm font-medium mb-1">Pairwise netting</div>
          <div className="space-y-1">
            {s.lines.map((l) => (
              <div key={l.counterpartyTenantId} className="text-sm flex justify-between border rounded p-2" data-testid={`statement-line-${l.counterpartyTenantId}`}>
                <span>{l.counterpartyName}</span>
                <span className="text-muted-foreground">
                  owes them {formatCurrency(l.owedToCounterparty)} · they owe {formatCurrency(l.owedByCounterparty)} ·{' '}
                  <span className={`font-mono ${l.net > 0 ? 'text-emerald-600' : l.net < 0 ? 'text-red-500' : ''}`}>net {formatCurrency(l.net)}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div>
        <div className="text-sm font-medium mb-1">Underlying ledger entries</div>
        <div className="space-y-1" data-testid={`statement-entries-${tenantId}`}>
          {data.entries.map((e) => (
            <div key={e.id} className="text-xs flex justify-between gap-2 border rounded p-2" data-testid={`ledger-entry-${e.id}`}>
              <span className="min-w-0">
                <Badge variant="outline" className="mr-1 capitalize">{e.kind.replace(/_/g, ' ')}</Badge>
                {e.debtorTenantName} → {e.creditorTenantName}
                {e.description && <span className="text-muted-foreground"> · {e.description}</span>}
              </span>
              <span className="font-mono shrink-0">{formatCurrency(e.amount)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
