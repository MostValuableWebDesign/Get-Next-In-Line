import { useState } from 'react';
import {
  useListAdminCoopFinancialDisputes, getListAdminCoopFinancialDisputesQueryKey,
  useCreateCoopFinancialAdjustment,
  useIssueCoopFinancialRuling,
  useListCoopSuspensions, getListCoopSuspensionsQueryKey,
  useCreateCoopSuspension, useLiftCoopSuspension,
  useListTenants, getListTenantsQueryKey,
  type CoopFinancialDispute,
  type ListAdminCoopFinancialDisputesParams,
  type CoopFinancialAdjustmentCreateAdjustmentType,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import {
  EvidenceList, DisputeTimeline, FINANCIAL_DISPUTE_TYPE_LABELS, FINANCIAL_STATUS_LABELS,
  financialStatusVariant, claimSummary,
} from '@/components/sos/coop-financial-disputes-content';
import {
  Ban, ChevronDown, ChevronUp, CircleDollarSign, Gavel, Scale, Undo2, UserX,
} from 'lucide-react';

/**
 * Mediation Hub — platform-admin console for co-op financial disputes.
 *
 * Escalated money/count disputes land here with parties, evidence, and the
 * automated reconciliation report. Admins record ledger adjustments and
 * bounty reversals (persisted compensating entries — no money movement),
 * close tickets with a written ruling, and manage tenant-level co-op
 * suspensions. Repeat violators are auto-suspended by the platform when
 * rulings against them cross the configured threshold.
 */

const FIN_STATUS_FILTERS = ['escalated', 'all', 'filed', 'auto_resolved', 'resolved', 'adjusted'] as const;

export function MediationHub() {
  const [statusFilter, setStatusFilter] = useState<string>('escalated');
  const params: ListAdminCoopFinancialDisputesParams | undefined =
    statusFilter === 'all' ? undefined : { status: statusFilter as NonNullable<ListAdminCoopFinancialDisputesParams['status']> };
  const { data: disputes, isLoading } = useListAdminCoopFinancialDisputes(params, {
    query: { queryKey: getListAdminCoopFinancialDisputesQueryKey(params) },
  });

  return (
    <div className="space-y-6" data-testid="mediation-hub">
      <Card className="border-none shadow-md" data-testid="card-mediation-queue">
        <CardHeader className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Scale className="w-5 h-5 text-primary" /> Mediation Hub — Financial Disputes
            </CardTitle>
            <CardDescription>
              Money and count disputes between co-op partners. Escalated tickets need an admin
              decision: record ledger adjustments, reverse referral bounties, or close with a
              ruling. Adjustments inform settlement — no money moves.
            </CardDescription>
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-44" data-testid="select-fin-status-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FIN_STATUS_FILTERS.map(s => (
                <SelectItem key={s} value={s}>
                  {s === 'all' ? 'All statuses' : (FINANCIAL_STATUS_LABELS[s] ?? s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? (
            <Skeleton className="h-24 w-full rounded-lg" />
          ) : !disputes || disputes.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="text-no-fin-disputes">
              No financial disputes{statusFilter === 'all' ? '' : ` with status "${FINANCIAL_STATUS_LABELS[statusFilter] ?? statusFilter}"`}.
            </p>
          ) : (
            disputes.map(d => <MediationTicket key={d.id} dispute={d} />)
          )}
        </CardContent>
      </Card>
      <SuspensionManager />
    </div>
  );
}

function MediationTicket({ dispute: d }: { dispute: CoopFinancialDispute }) {
  const [open, setOpen] = useState(d.status === 'escalated');
  return (
    <div className="border rounded-lg p-4 space-y-2" data-testid={`row-fin-dispute-${d.id}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-semibold text-sm" data-testid={`text-fin-parties-${d.id}`}>
          {d.filedByTenantName}
        </span>
        <span className="text-xs text-muted-foreground">filed against</span>
        <span className="font-semibold text-sm">{d.respondentTenantName}</span>
        <Badge variant={financialStatusVariant(d.status)} data-testid={`badge-fin-status-${d.id}`}>
          {FINANCIAL_STATUS_LABELS[d.status] ?? d.status}
        </Badge>
        <Button size="sm" variant="ghost" className="ml-auto h-7 gap-1" onClick={() => setOpen(o => !o)}
          data-testid={`button-toggle-fin-ticket-${d.id}`}>
          {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          {open ? 'Hide' : 'Review'}
        </Button>
      </div>
      <div className="text-sm" data-testid={`text-fin-type-${d.id}`}>
        {FINANCIAL_DISPUTE_TYPE_LABELS[d.disputeType] ?? d.disputeType}
        {claimSummary(d) && <span className="text-muted-foreground"> — {claimSummary(d)}</span>}
      </div>
      <div className="text-xs text-muted-foreground">
        Perk: {d.perkTitle} · Period {new Date(d.windowStartAt).toLocaleDateString()} – {new Date(d.windowEndAt).toLocaleDateString()} ·
        Filed {new Date(d.createdAt).toLocaleDateString()}
        {d.escalatedAt && ` · Escalated ${new Date(d.escalatedAt).toLocaleDateString()}`}
        {d.resolvedAt && ` · Closed ${new Date(d.resolvedAt).toLocaleDateString()}`}
      </div>
      {open && <MediationTicketDetail dispute={d} />}
    </div>
  );
}

function MediationTicketDetail({ dispute: d }: { dispute: CoopFinancialDispute }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createAdjustment = useCreateCoopFinancialAdjustment();
  const issueRuling = useIssueCoopFinancialRuling();

  const [adjOpen, setAdjOpen] = useState(false);
  const [adjType, setAdjType] = useState<string>('adjustment');
  const [adjAmount, setAdjAmount] = useState('');
  const [adjCredit, setAdjCredit] = useState('');
  const [adjReason, setAdjReason] = useState('');
  const [adjConfirming, setAdjConfirming] = useState(false);

  const [rulingOpen, setRulingOpen] = useState(false);
  const [rulingText, setRulingText] = useState('');
  const [ruledAgainst, setRuledAgainst] = useState<string>('none');

  const refresh = () => {
    queryClient.invalidateQueries({
      predicate: q => typeof q.queryKey[0] === 'string' &&
        (q.queryKey[0].includes('/api/admin/coop/') || q.queryKey[0].includes('/api/coop/')),
    });
  };
  const onError = (err: unknown) => {
    const e = err as { data?: { message?: string }; message?: string };
    toast({ title: 'Action failed', description: e?.data?.message ?? e?.message ?? 'Please try again.', variant: 'destructive' });
  };

  const actionable = d.status === 'escalated';
  const busy = createAdjustment.isPending || issueRuling.isPending;
  const parties = [
    { id: d.filedByTenantId, name: d.filedByTenantName },
    { id: d.respondentTenantId, name: d.respondentTenantName },
  ];
  const creditParty = parties.find(p => String(p.id) === adjCredit) ?? null;
  const debitParty = parties.find(p => String(p.id) !== adjCredit) ?? null;
  const adjValid = adjCredit !== '' && adjReason.trim() !== '' &&
    adjAmount !== '' && Number(adjAmount) > 0;

  const submitAdjustment = () => {
    if (!adjValid || !creditParty || !debitParty) return;
    createAdjustment.mutate(
      {
        id: d.id,
        data: {
          adjustmentType: adjType as CoopFinancialAdjustmentCreateAdjustmentType,
          amount: Number(adjAmount),
          creditTenantId: creditParty.id,
          debitTenantId: debitParty.id,
          reason: adjReason.trim(),
        },
      },
      {
        onSuccess: () => {
          refresh();
          toast({
            title: adjType === 'bounty_reversal' ? 'Bounty reversal recorded' : 'Ledger adjustment recorded',
            description: `$${Number(adjAmount).toFixed(2)} credit to ${creditParty.name}, debit ${debitParty.name}.`,
          });
          setAdjOpen(false); setAdjConfirming(false);
          setAdjAmount(''); setAdjCredit(''); setAdjReason(''); setAdjType('adjustment');
        },
        onError: err => { setAdjConfirming(false); onError(err); },
      },
    );
  };

  const submitRuling = () => {
    if (!rulingText.trim()) return;
    issueRuling.mutate(
      {
        id: d.id,
        data: {
          ruling: rulingText.trim(),
          ...(ruledAgainst !== 'none' ? { ruledAgainstTenantId: Number(ruledAgainst) } : {}),
        },
      },
      {
        onSuccess: () => {
          refresh();
          toast({ title: 'Ruling issued', description: 'Both parties have been notified. The ticket is closed.' });
          setRulingOpen(false); setRulingText(''); setRuledAgainst('none');
        },
        onError,
      },
    );
  };

  return (
    <div className="space-y-3 pt-2 border-t" data-testid={`detail-fin-ticket-${d.id}`}>
      {d.details && <p className="text-xs italic text-muted-foreground">“{d.details}”</p>}
      {d.reconciliationSummary && (
        <div className="rounded-md bg-muted/60 p-2.5 text-xs space-y-1" data-testid={`text-admin-reconciliation-${d.id}`}>
          <div className="font-semibold flex items-center gap-1.5"><Scale className="w-3 h-3" /> Automated reconciliation report</div>
          <p className="whitespace-pre-wrap">{d.reconciliationSummary}</p>
          {d.reconciliationSystemCount != null && (
            <p className="text-muted-foreground">System redemption count for the period: {d.reconciliationSystemCount}</p>
          )}
        </div>
      )}
      {d.counterpartyResponse && (
        <div className="text-xs" data-testid={`text-admin-response-${d.id}`}>
          <span className="font-medium">{d.respondentTenantName} responded:</span>{' '}
          <span className="text-muted-foreground">“{d.counterpartyResponse}”</span>
        </div>
      )}
      {d.ruling && (
        <div className="rounded-md border border-primary/30 bg-primary/5 p-2.5 text-xs" data-testid={`text-admin-ruling-${d.id}`}>
          <span className="font-semibold">Ruling:</span> {d.ruling}
        </div>
      )}
      {d.adjustments.length > 0 && (
        <div className="space-y-1 text-xs" data-testid={`list-admin-adjustments-${d.id}`}>
          <div className="font-semibold">Recorded adjustments</div>
          {d.adjustments.map(a => (
            <div key={a.id} className="text-muted-foreground" data-testid={`row-admin-adjustment-${a.id}`}>
              {a.adjustmentType === 'bounty_reversal' ? 'Bounty reversal' : 'Adjustment'} of ${a.amount.toFixed(2)}
              {a.creditTenantName && ` · credit ${a.creditTenantName}`}
              {a.debitTenantName && ` · debit ${a.debitTenantName}`} — {a.reason} · {new Date(a.createdAt).toLocaleDateString()}
            </div>
          ))}
        </div>
      )}
      <div className="space-y-1">
        <div className="text-xs font-semibold">Evidence</div>
        <EvidenceList evidence={d.evidence} disputeId={d.id} />
      </div>
      <div className="space-y-1">
        <div className="text-xs font-semibold">Status history</div>
        <DisputeTimeline events={d.events} disputeId={d.id} />
      </div>

      {actionable && (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" variant="outline" className="gap-1.5" disabled={busy}
            onClick={() => { setAdjOpen(o => !o); setRulingOpen(false); }}
            data-testid={`button-open-adjustment-${d.id}`}>
            <CircleDollarSign className="w-3.5 h-3.5" /> Record Adjustment / Reversal
          </Button>
          <Button size="sm" variant="outline" className="gap-1.5" disabled={busy}
            onClick={() => { setRulingOpen(o => !o); setAdjOpen(false); }}
            data-testid={`button-open-ruling-${d.id}`}>
            <Gavel className="w-3.5 h-3.5" /> Close with Ruling
          </Button>
        </div>
      )}

      {actionable && adjOpen && (
        <div className="border rounded-md p-3 space-y-3" data-testid={`form-adjustment-${d.id}`}>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={adjType} onValueChange={setAdjType}>
                <SelectTrigger data-testid={`select-adjustment-type-${d.id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="adjustment">Ledger adjustment</SelectItem>
                  <SelectItem value="bounty_reversal">Referral bounty reversal</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Amount ($)</Label>
              <Input type="number" min="0.01" step="0.01" value={adjAmount}
                onChange={e => setAdjAmount(e.target.value)}
                data-testid={`input-adjustment-amount-${d.id}`} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Credit (in favor of)</Label>
            <Select value={adjCredit} onValueChange={setAdjCredit}>
              <SelectTrigger data-testid={`select-adjustment-credit-${d.id}`}>
                <SelectValue placeholder="Choose the party to credit" />
              </SelectTrigger>
              <SelectContent>
                {parties.map(p => (
                  <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {creditParty && debitParty && (
              <p className="text-xs text-muted-foreground">
                {debitParty.name} will carry the offsetting debit.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Reason</Label>
            <Textarea placeholder="Why this compensating entry is being recorded — visible to both parties."
              value={adjReason} onChange={e => setAdjReason(e.target.value)}
              data-testid={`input-adjustment-reason-${d.id}`} />
          </div>
          {adjConfirming ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm space-y-2"
              data-testid={`confirm-adjustment-${d.id}`}>
              <p>
                Record a {adjType === 'bounty_reversal' ? 'bounty reversal' : 'ledger adjustment'} of{' '}
                <span className="font-semibold">${Number(adjAmount || 0).toFixed(2)}</span> crediting{' '}
                <span className="font-semibold">{creditParty?.name}</span> and debiting{' '}
                <span className="font-semibold">{debitParty?.name}</span>? This entry is persisted on
                the ticket and informs settlement.
              </p>
              <div className="flex gap-2">
                <Button size="sm" disabled={busy} onClick={submitAdjustment}
                  data-testid={`button-confirm-adjustment-${d.id}`}>
                  Yes, record it
                </Button>
                <Button size="sm" variant="outline" onClick={() => setAdjConfirming(false)}
                  data-testid={`button-cancel-adjustment-${d.id}`}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" disabled={!adjValid || busy} onClick={() => setAdjConfirming(true)}
              data-testid={`button-record-adjustment-${d.id}`}>
              <CircleDollarSign className="w-3.5 h-3.5 mr-1.5" /> Record Entry
            </Button>
          )}
        </div>
      )}

      {actionable && rulingOpen && (
        <div className="border rounded-md p-3 space-y-3" data-testid={`form-ruling-${d.id}`}>
          <div className="space-y-1.5">
            <Label>Written ruling</Label>
            <Textarea placeholder="The final decision, visible to both parties. Closing the ticket notifies them."
              value={rulingText} onChange={e => setRulingText(e.target.value)}
              data-testid={`input-ruling-${d.id}`} />
          </div>
          <div className="space-y-1.5">
            <Label>Ruled against (optional — counts toward repeat-violator auto-suspension)</Label>
            <Select value={ruledAgainst} onValueChange={setRuledAgainst}>
              <SelectTrigger data-testid={`select-ruled-against-${d.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No party at fault</SelectItem>
                {parties.map(p => (
                  <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button size="sm" disabled={!rulingText.trim() || busy} onClick={submitRuling}
            data-testid={`button-issue-ruling-${d.id}`}>
            <Gavel className="w-3.5 h-3.5 mr-1.5" /> Issue Ruling & Close
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Tenant co-op suspension management ───────────────────────────────────────

function SuspensionManager() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: suspensions, isLoading } = useListCoopSuspensions({
    query: { queryKey: getListCoopSuspensionsQueryKey() },
  });
  const { data: tenants } = useListTenants({
    query: { queryKey: getListTenantsQueryKey() },
  });
  const suspend = useCreateCoopSuspension();
  const lift = useLiftCoopSuspension();

  const [suspendTenantId, setSuspendTenantId] = useState('');
  const [suspendReason, setSuspendReason] = useState('');
  const [confirmingSuspend, setConfirmingSuspend] = useState(false);

  const refresh = () => {
    queryClient.invalidateQueries({
      predicate: q => typeof q.queryKey[0] === 'string' &&
        (q.queryKey[0].includes('/api/admin/coop/') || q.queryKey[0].includes('/api/coop/')),
    });
  };
  const onError = (err: unknown) => {
    const e = err as { data?: { message?: string }; message?: string };
    toast({ title: 'Action failed', description: e?.data?.message ?? e?.message ?? 'Please try again.', variant: 'destructive' });
  };

  const activeSuspendedIds = new Set((suspensions ?? []).filter(s => s.status === 'active').map(s => s.tenantId));
  const suspendTarget = (tenants ?? []).find(t => String(t.id) === suspendTenantId) ?? null;

  const doSuspend = () => {
    if (!suspendTarget) return;
    suspend.mutate(
      { data: { tenantId: suspendTarget.id, ...(suspendReason.trim() ? { reason: suspendReason.trim() } : {}) } },
      {
        onSuccess: () => {
          refresh();
          toast({
            title: 'Co-op participation suspended',
            description: `${suspendTarget.brandName}'s perks stop being served and they can't form new partnerships until reinstated.`,
          });
          setSuspendTenantId(''); setSuspendReason(''); setConfirmingSuspend(false);
        },
        onError: err => { setConfirmingSuspend(false); onError(err); },
      },
    );
  };

  return (
    <Card data-testid="card-coop-suspensions">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserX className="w-5 h-5 text-primary" /> Co-op Participation Suspensions
        </CardTitle>
        <CardDescription>
          Suspended tenants' perks are excluded from every co-op surface and they cannot form new
          partnerships. Repeat violators are suspended automatically when admin rulings against
          them cross the configured threshold; manual suspensions are available here too.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-16 w-full rounded-lg" />
        ) : !suspensions || suspensions.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-suspensions">
            No co-op suspensions on record.
          </p>
        ) : (
          <div className="divide-y" data-testid="list-coop-suspensions">
            {suspensions.map(s => (
              <div key={s.id} className="py-3 flex flex-col md:flex-row md:items-center justify-between gap-3"
                data-testid={`row-suspension-${s.id}`}>
                <div className="min-w-0 space-y-0.5">
                  <div className="text-sm font-medium flex items-center gap-2">
                    {s.tenantName}
                    {s.status === 'active' ? (
                      <Badge variant="destructive" data-testid={`badge-suspension-status-${s.id}`}>Suspended</Badge>
                    ) : (
                      <Badge variant="secondary" data-testid={`badge-suspension-status-${s.id}`}>
                        Lifted{s.liftedAt ? ` ${new Date(s.liftedAt).toLocaleDateString()}` : ''}
                      </Badge>
                    )}
                    <Badge variant="outline" data-testid={`badge-suspension-trigger-${s.id}`}>
                      {s.trigger === 'repeat_violator' ? 'Auto — repeat violator' : 'Manual'}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Suspended {new Date(s.suspendedAt).toLocaleDateString()}
                    {s.trigger === 'repeat_violator' && s.rulingsCount != null &&
                      ` · ${s.rulingsCount} adverse ruling${s.rulingsCount === 1 ? '' : 's'} within ${s.windowDays} days`}
                    {s.reason && ` · ${s.reason}`}
                  </div>
                </div>
                {s.status === 'active' && (
                  <Button size="sm" variant="outline" className="gap-1.5 shrink-0" disabled={lift.isPending}
                    onClick={() => lift.mutate({ id: s.id }, {
                      onSuccess: () => { refresh(); toast({ title: 'Suspension lifted', description: `${s.tenantName} can participate in the co-op again.` }); },
                      onError,
                    })}
                    data-testid={`button-lift-suspension-${s.id}`}>
                    <Undo2 className="w-3.5 h-3.5" /> Reinstate
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="border rounded-md p-3 space-y-3" data-testid="form-suspend-tenant">
          <div className="text-sm font-medium flex items-center gap-1.5">
            <Ban className="w-4 h-4" /> Suspend a tenant manually
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Select value={suspendTenantId} onValueChange={v => { setSuspendTenantId(v); setConfirmingSuspend(false); }}>
              <SelectTrigger data-testid="select-suspend-tenant">
                <SelectValue placeholder="Choose a business" />
              </SelectTrigger>
              <SelectContent>
                {(tenants ?? []).filter(t => !activeSuspendedIds.has(t.id)).map(t => (
                  <SelectItem key={t.id} value={String(t.id)}>{t.brandName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input placeholder="Reason (recommended)" value={suspendReason}
              onChange={e => setSuspendReason(e.target.value)} data-testid="input-suspend-reason" />
          </div>
          {confirmingSuspend && suspendTarget ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm space-y-2"
              data-testid="confirm-suspend-tenant">
              <p>
                Suspend <span className="font-semibold">{suspendTarget.brandName}</span> from co-op
                participation? Their perks stop being served everywhere and they can't form new
                partnerships until reinstated.
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="destructive" disabled={suspend.isPending} onClick={doSuspend}
                  data-testid="button-confirm-suspend">
                  Yes, suspend
                </Button>
                <Button size="sm" variant="outline" onClick={() => setConfirmingSuspend(false)}
                  data-testid="button-cancel-suspend">
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="outline" className="gap-1.5 text-destructive hover:text-destructive"
              disabled={suspendTenantId === '' || suspend.isPending}
              onClick={() => setConfirmingSuspend(true)}
              data-testid="button-suspend-tenant">
              <Ban className="w-3.5 h-3.5" /> Suspend Co-op Participation
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
