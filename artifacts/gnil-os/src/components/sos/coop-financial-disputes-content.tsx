import { useMemo, useState } from 'react';
import {
  useListCoopFinancialDisputes, getListCoopFinancialDisputesQueryKey,
  useGetCoopFinancialDispute, getGetCoopFinancialDisputeQueryKey,
  useCreateCoopFinancialDispute,
  useAddCoopFinancialDisputeEvidence,
  useRespondToCoopFinancialDispute,
  useListCoopPartnershipRedemptions, getListCoopPartnershipRedemptionsQueryKey,
  type CoopPartnership,
  type CoopFinancialDispute,
  type CoopFinancialDisputeCreateDisputeType,
  type CoopFinancialDisputeEvidenceItem,
  type CoopFinancialDisputeEvent,
  type CoopFinancialDisputeEvidenceCreateReceiptsItem,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import {
  ChevronDown, ChevronUp, CircleDollarSign, FileText, Plus, Receipt, Scale, Ticket, Trash2,
} from 'lucide-react';

/**
 * Co-Op financial dispute mediation — merchant surface.
 *
 * Partners file structured money/count disputes on a partnership with
 * evidence (system redemption records + manual receipt entries). The platform
 * immediately reconciles the claim against its own redemption ledger:
 * matching claims auto-resolve with a written summary, everything else
 * escalates to platform admins. Both parties see the full status history.
 */

export const FINANCIAL_DISPUTE_TYPE_LABELS: Record<string, string> = {
  commission_mismatch: 'Commission / referral count mismatch',
  unfulfilled_redemption: 'Unfulfilled perk redemption',
  shared_expense: 'Shared expense discrepancy',
};

export const FINANCIAL_STATUS_LABELS: Record<string, string> = {
  filed: 'Filed',
  auto_resolved: 'Auto-reconciled',
  escalated: 'Escalated',
  resolved: 'Resolved',
  adjusted: 'Resolved (adjusted)',
};

export function financialStatusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'escalated': return 'destructive';
    case 'filed': return 'default';
    case 'auto_resolved': return 'secondary';
    default: return 'outline';
  }
}

const EVENT_LABELS: Record<string, string> = {
  filed: 'Dispute filed',
  evidence_added: 'Evidence added',
  auto_resolved: 'Auto-reconciled by the platform',
  escalated: 'Escalated for admin review',
  responded: 'Counterparty responded',
  adjustment_recorded: 'Ledger adjustment recorded',
  bounty_reversal_recorded: 'Referral bounty reversed',
  ruling_issued: 'Admin ruling issued',
  resolved: 'Resolved',
  adjusted: 'Closed with adjustments',
};

export function eventLabel(e: CoopFinancialDisputeEvent): string {
  return EVENT_LABELS[e.eventType] ?? e.eventType.replaceAll('_', ' ');
}

function money(n: number | null): string | null {
  return n == null ? null : `$${n.toFixed(2)}`;
}

export function claimSummary(d: CoopFinancialDispute): string {
  const parts: string[] = [];
  if (d.claimedCount != null || d.expectedCount != null) {
    parts.push(`claimed ${d.claimedCount ?? '—'} vs. expected ${d.expectedCount ?? '—'} redemptions`);
  }
  if (d.claimedAmount != null || d.expectedAmount != null) {
    parts.push(`claimed ${money(d.claimedAmount) ?? '—'} vs. expected ${money(d.expectedAmount) ?? '—'}`);
  }
  return parts.join(' · ');
}

/** Shared evidence list — rendered identically for merchants and admins. */
export function EvidenceList({ evidence, disputeId }: { evidence: CoopFinancialDisputeEvidenceItem[]; disputeId: number }) {
  if (evidence.length === 0) {
    return <p className="text-xs text-muted-foreground" data-testid={`text-no-evidence-${disputeId}`}>No evidence attached.</p>;
  }
  return (
    <div className="space-y-1" data-testid={`list-evidence-${disputeId}`}>
      {evidence.map(ev => (
        <div key={ev.id} className="flex items-start gap-1.5 text-xs" data-testid={`row-evidence-${ev.id}`}>
          {ev.kind === 'redemption' ? (
            <>
              <Ticket className="w-3 h-3 mt-0.5 shrink-0 text-muted-foreground" />
              <span>
                System redemption <span className="font-mono">{ev.redemptionPassCode}</span>
                {ev.redemptionRedeemedAt && ` · redeemed ${new Date(ev.redemptionRedeemedAt).toLocaleString()}`}
              </span>
            </>
          ) : (
            <>
              <Receipt className="w-3 h-3 mt-0.5 shrink-0 text-muted-foreground" />
              <span>
                Receipt <span className="font-mono">{ev.referenceNumber}</span>
                {ev.amount != null && ` · ${money(ev.amount)}`}
                {ev.entryDate && ` · ${new Date(ev.entryDate).toLocaleDateString()}`}
                {ev.description && ` — ${ev.description}`}
              </span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/** Shared status timeline. */
export function DisputeTimeline({ events, disputeId }: { events: CoopFinancialDisputeEvent[]; disputeId: number }) {
  return (
    <ol className="space-y-1" data-testid={`timeline-${disputeId}`}>
      {events.map(e => (
        <li key={e.id} className="flex items-start gap-2 text-xs" data-testid={`event-${e.id}`}>
          <span className="mt-1 w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
          <div>
            <span className="font-medium">{eventLabel(e)}</span>
            <span className="text-muted-foreground"> · {new Date(e.createdAt).toLocaleString()} · {e.actorType}</span>
            {e.note && <div className="text-muted-foreground whitespace-pre-wrap">{e.note}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function invalidateFinancial(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({
    predicate: q => typeof q.queryKey[0] === 'string' &&
      (q.queryKey[0].includes('/api/coop/financial-disputes') || q.queryKey[0].includes('/redemptions')),
  });
}

// ── Receipt entry rows (shared between filing & add-evidence) ────────────────

type ReceiptDraft = { referenceNumber: string; amount: string; entryDate: string; description: string };
const emptyReceipt = (): ReceiptDraft => ({ referenceNumber: '', amount: '', entryDate: '', description: '' });

function receiptsValid(rows: ReceiptDraft[]): boolean {
  return rows.every(r =>
    r.referenceNumber.trim() !== '' && r.entryDate !== '' &&
    r.amount !== '' && Number.isFinite(Number(r.amount)) && Number(r.amount) > 0);
}

function toReceiptPayload(rows: ReceiptDraft[]): CoopFinancialDisputeEvidenceCreateReceiptsItem[] {
  return rows.map(r => ({
    referenceNumber: r.referenceNumber.trim(),
    amount: Number(r.amount),
    entryDate: new Date(r.entryDate).toISOString(),
    ...(r.description.trim() ? { description: r.description.trim() } : {}),
  }));
}

function ReceiptRows({ rows, setRows, idPrefix }: {
  rows: ReceiptDraft[];
  setRows: (rows: ReceiptDraft[]) => void;
  idPrefix: string;
}) {
  const update = (i: number, patch: Partial<ReceiptDraft>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="border rounded-md p-2 space-y-2" data-testid={`${idPrefix}-receipt-${i}`}>
          <div className="grid grid-cols-2 gap-2">
            <Input placeholder="Reference #" value={r.referenceNumber}
              onChange={e => update(i, { referenceNumber: e.target.value })}
              data-testid={`input-${idPrefix}-receipt-ref-${i}`} />
            <Input type="number" min="0.01" step="0.01" placeholder="Amount ($)" value={r.amount}
              onChange={e => update(i, { amount: e.target.value })}
              data-testid={`input-${idPrefix}-receipt-amount-${i}`} />
            <Input type="date" value={r.entryDate}
              onChange={e => update(i, { entryDate: e.target.value })}
              data-testid={`input-${idPrefix}-receipt-date-${i}`} />
            <Input placeholder="Description (optional)" value={r.description}
              onChange={e => update(i, { description: e.target.value })}
              data-testid={`input-${idPrefix}-receipt-desc-${i}`} />
          </div>
          <Button size="sm" variant="ghost" className="gap-1 h-7 text-destructive hover:text-destructive"
            onClick={() => setRows(rows.filter((_, j) => j !== i))}
            data-testid={`button-${idPrefix}-remove-receipt-${i}`}>
            <Trash2 className="w-3 h-3" /> Remove
          </Button>
        </div>
      ))}
      <Button size="sm" variant="outline" className="gap-1.5"
        onClick={() => setRows([...rows, emptyReceipt()])}
        data-testid={`button-${idPrefix}-add-receipt`}>
        <Plus className="w-3.5 h-3.5" /> Add receipt entry
      </Button>
    </div>
  );
}

// ── Redemption evidence picker ───────────────────────────────────────────────

function RedemptionPicker({ partnershipId, selected, setSelected, idPrefix }: {
  partnershipId: number;
  selected: Set<number>;
  setSelected: (s: Set<number>) => void;
  idPrefix: string;
}) {
  const { data: redemptions, isLoading } = useListCoopPartnershipRedemptions(partnershipId, {
    query: { queryKey: getListCoopPartnershipRedemptionsQueryKey(partnershipId) },
  });
  if (isLoading) return <Skeleton className="h-12 w-full rounded-md" />;
  if (!redemptions || redemptions.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid={`text-${idPrefix}-no-redemptions`}>
        No system redemption records exist for this partnership yet.
      </p>
    );
  }
  const toggle = (id: number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };
  return (
    <div className="max-h-40 overflow-y-auto border rounded-md divide-y" data-testid={`list-${idPrefix}-redemptions`}>
      {redemptions.map(r => (
        <label key={r.id} className="flex items-center gap-2 p-2 text-xs cursor-pointer hover:bg-muted/50"
          data-testid={`row-${idPrefix}-redemption-${r.id}`}>
          <Checkbox checked={selected.has(r.id)} onCheckedChange={() => toggle(r.id)}
            data-testid={`checkbox-${idPrefix}-redemption-${r.id}`} />
          <span className="font-mono">{r.passCode}</span>
          <span className="text-muted-foreground ml-auto">
            {new Date(r.redeemedAt).toLocaleString()}
            {r.redeemedByTenantName ? ` · by ${r.redeemedByTenantName}` : ''}
          </span>
        </label>
      ))}
    </div>
  );
}

// ── Filing dialog ────────────────────────────────────────────────────────────

export function FileFinancialDisputeDialog({ tenantId, target, onClose }: {
  tenantId: number;
  target: CoopPartnership | null;
  onClose: () => void;
}) {
  const [disputeType, setDisputeType] = useState<string>('');
  const [claimedCount, setClaimedCount] = useState('');
  const [expectedCount, setExpectedCount] = useState('');
  const [claimedAmount, setClaimedAmount] = useState('');
  const [expectedAmount, setExpectedAmount] = useState('');
  const [windowStart, setWindowStart] = useState('');
  const [windowEnd, setWindowEnd] = useState('');
  const [details, setDetails] = useState('');
  const [selectedRedemptions, setSelectedRedemptions] = useState<Set<number>>(new Set());
  const [receipts, setReceipts] = useState<ReceiptDraft[]>([]);

  const queryClient = useQueryClient();
  const { toast } = useToast();
  const create = useCreateCoopFinancialDispute();

  const reset = () => {
    setDisputeType(''); setClaimedCount(''); setExpectedCount('');
    setClaimedAmount(''); setExpectedAmount(''); setWindowStart(''); setWindowEnd('');
    setDetails(''); setSelectedRedemptions(new Set()); setReceipts([]);
  };

  const otherName = target
    ? (target.hostTenantId === tenantId ? target.partnerTenantName : target.hostTenantName)
    : '';
  const isExpenseDispute = disputeType === 'shared_expense';
  const windowInvalid = windowStart !== '' && windowEnd !== '' && new Date(windowEnd) < new Date(windowStart);
  const hasFigures = isExpenseDispute
    ? claimedAmount !== '' && Number(claimedAmount) >= 0
    : claimedCount !== '' && Number.isInteger(Number(claimedCount)) && Number(claimedCount) >= 0;
  const canSubmit =
    target != null && disputeType !== '' && windowStart !== '' && windowEnd !== '' &&
    !windowInvalid && hasFigures && receiptsValid(receipts) && !create.isPending;

  const submit = () => {
    if (!target || !canSubmit) return;
    const evidence =
      selectedRedemptions.size > 0 || receipts.length > 0
        ? {
            ...(selectedRedemptions.size > 0 ? { redemptionIds: [...selectedRedemptions] } : {}),
            ...(receipts.length > 0 ? { receipts: toReceiptPayload(receipts) } : {}),
          }
        : undefined;
    create.mutate(
      {
        data: {
          partnershipId: target.id,
          disputeType: disputeType as CoopFinancialDisputeCreateDisputeType,
          ...(claimedCount !== '' ? { claimedCount: Number(claimedCount) } : {}),
          ...(expectedCount !== '' ? { expectedCount: Number(expectedCount) } : {}),
          ...(claimedAmount !== '' ? { claimedAmount: Number(claimedAmount) } : {}),
          ...(expectedAmount !== '' ? { expectedAmount: Number(expectedAmount) } : {}),
          windowStartAt: new Date(windowStart).toISOString(),
          windowEndAt: new Date(`${windowEnd}T23:59:59.999`).toISOString(),
          ...(details.trim() ? { details: details.trim() } : {}),
          ...(evidence ? { evidence } : {}),
        },
      },
      {
        onSuccess: created => {
          invalidateFinancial(queryClient);
          toast({
            title: created.status === 'auto_resolved' ? 'Dispute auto-reconciled' : 'Financial dispute filed',
            description:
              created.status === 'auto_resolved'
                ? 'Platform records settled the disagreement — see the reconciliation summary below.'
                : `${otherName} has been notified and the case ${created.status === 'escalated' ? 'was escalated to platform mediation' : 'is on file'}.`,
          });
          onClose();
          reset();
        },
        onError: (err: unknown) => {
          const e = err as { data?: { message?: string }; message?: string };
          toast({
            title: 'Could not file the dispute',
            description: e?.data?.message ?? e?.message ?? 'Please try again.',
            variant: 'destructive',
          });
        },
      },
    );
  };

  return (
    <Dialog open={target != null} onOpenChange={o => { if (!o) { onClose(); reset(); } }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg" data-testid="dialog-file-financial-dispute">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Scale className="w-4 h-4" /> File Financial Dispute
          </DialogTitle>
          <DialogDescription>
            Dispute a money or count disagreement with {otherName}. The platform immediately checks
            its own redemption records — matching claims resolve automatically, everything else goes
            to platform mediation. {otherName} is notified either way.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Dispute type</Label>
            <Select value={disputeType} onValueChange={setDisputeType}>
              <SelectTrigger data-testid="select-financial-dispute-type">
                <SelectValue placeholder="Choose a type" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(FINANCIAL_DISPUTE_TYPE_LABELS).map(([v, l]) => (
                  <SelectItem key={v} value={v}>{l}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {!isExpenseDispute && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="fin-claimed-count">Your count (claimed)</Label>
                <Input id="fin-claimed-count" type="number" min="0" step="1" value={claimedCount}
                  onChange={e => setClaimedCount(e.target.value)} data-testid="input-claimed-count" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fin-expected-count">Partner's count (their figure)</Label>
                <Input id="fin-expected-count" type="number" min="0" step="1" value={expectedCount}
                  onChange={e => setExpectedCount(e.target.value)} data-testid="input-expected-count" />
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="fin-claimed-amount">{isExpenseDispute ? 'Your amount ($)' : 'Claimed amount ($, optional)'}</Label>
              <Input id="fin-claimed-amount" type="number" min="0" step="0.01" value={claimedAmount}
                onChange={e => setClaimedAmount(e.target.value)} data-testid="input-claimed-amount" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fin-expected-amount">{isExpenseDispute ? "Partner's amount ($)" : 'Expected amount ($, optional)'}</Label>
              <Input id="fin-expected-amount" type="number" min="0" step="0.01" value={expectedAmount}
                onChange={e => setExpectedAmount(e.target.value)} data-testid="input-expected-amount" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="fin-window-start">Period start</Label>
              <Input id="fin-window-start" type="date" value={windowStart}
                onChange={e => setWindowStart(e.target.value)} data-testid="input-window-start" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fin-window-end">Period end</Label>
              <Input id="fin-window-end" type="date" value={windowEnd}
                onChange={e => setWindowEnd(e.target.value)} data-testid="input-window-end" />
            </div>
          </div>
          {windowInvalid && (
            <p className="text-xs text-destructive" data-testid="text-window-invalid">Period end must not be before the start.</p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="fin-details">Details</Label>
            <Textarea id="fin-details" placeholder="What happened? Context that helps your partner and the mediators."
              value={details} onChange={e => setDetails(e.target.value)} data-testid="input-financial-details" />
          </div>
          {target && (
            <div className="space-y-1.5">
              <Label>Attach system redemption records (optional)</Label>
              <RedemptionPicker partnershipId={target.id} selected={selectedRedemptions}
                setSelected={setSelectedRedemptions} idPrefix="file" />
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Receipt / transaction entries (optional)</Label>
            <ReceiptRows rows={receipts} setRows={setReceipts} idPrefix="file" />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={!canSubmit} data-testid="button-submit-financial-dispute">
            <Scale className="w-4 h-4 mr-1.5" /> File Dispute
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Ticket list & detail ─────────────────────────────────────────────────────

export function FinancialDisputesSection({ tenantId }: { tenantId: number }) {
  const { data: disputes, isLoading } = useListCoopFinancialDisputes({
    query: { queryKey: getListCoopFinancialDisputesQueryKey() },
  });

  return (
    <Card data-testid="card-financial-disputes">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <CircleDollarSign className="w-4 h-4 text-primary" /> Financial Disputes
        </CardTitle>
        <CardDescription>
          Money and count disagreements on your partnerships. The platform reconciles each claim
          against its own redemption records; unresolved cases go to platform mediation.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <Skeleton className="h-16 w-full rounded-lg" />
        ) : !disputes || disputes.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-financial-disputes">
            No financial disputes on file. Use “File Financial Dispute” on an active partnership if
            counts or amounts don't line up.
          </p>
        ) : (
          disputes.map(d => <FinancialDisputeRow key={d.id} dispute={d} tenantId={tenantId} />)
        )}
      </CardContent>
    </Card>
  );
}

function FinancialDisputeRow({ dispute: d, tenantId }: { dispute: CoopFinancialDispute; tenantId: number }) {
  const [open, setOpen] = useState(false);
  const iFiled = d.filedByTenantId === tenantId;
  const otherName = iFiled ? d.respondentTenantName : d.filedByTenantName;
  return (
    <div className="border rounded-lg p-3 space-y-2" data-testid={`row-financial-dispute-${d.id}`}>
      <div className="flex items-center gap-2 flex-wrap text-sm">
        <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <span className="font-medium" data-testid={`text-fin-dispute-title-${d.id}`}>
          {FINANCIAL_DISPUTE_TYPE_LABELS[d.disputeType] ?? d.disputeType}
        </span>
        <Badge variant={financialStatusVariant(d.status)} data-testid={`badge-fin-dispute-status-${d.id}`}>
          {FINANCIAL_STATUS_LABELS[d.status] ?? d.status}
        </Badge>
        <Button size="sm" variant="ghost" className="ml-auto h-7 gap-1" onClick={() => setOpen(o => !o)}
          data-testid={`button-toggle-fin-dispute-${d.id}`}>
          {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          {open ? 'Hide' : 'Details'}
        </Button>
      </div>
      <div className="text-xs text-muted-foreground">
        {iFiled ? `You filed against ${otherName}` : `${otherName} filed against you`} · {d.perkTitle} ·{' '}
        {new Date(d.windowStartAt).toLocaleDateString()} – {new Date(d.windowEndAt).toLocaleDateString()}
        {claimSummary(d) && ` · ${claimSummary(d)}`}
      </div>
      {open && <FinancialDisputeDetail disputeId={d.id} tenantId={tenantId} />}
    </div>
  );
}

function FinancialDisputeDetail({ disputeId, tenantId }: { disputeId: number; tenantId: number }) {
  const { data: d, isLoading } = useGetCoopFinancialDispute(disputeId, {
    query: { queryKey: getGetCoopFinancialDisputeQueryKey(disputeId) },
  });
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const respond = useRespondToCoopFinancialDispute();
  const addEvidence = useAddCoopFinancialDisputeEvidence();
  const [response, setResponse] = useState('');
  const [addingEvidence, setAddingEvidence] = useState(false);
  const [selectedRedemptions, setSelectedRedemptions] = useState<Set<number>>(new Set());
  const [receipts, setReceipts] = useState<ReceiptDraft[]>([]);

  if (isLoading || !d) return <Skeleton className="h-20 w-full rounded-md" />;

  const openStatuses = ['filed', 'escalated'];
  const isOpen = openStatuses.includes(d.status);
  const iAmRespondent = d.respondentTenantId === tenantId;
  const onError = (err: unknown) => {
    const e = err as { data?: { message?: string }; message?: string };
    toast({ title: 'Action failed', description: e?.data?.message ?? e?.message ?? 'Please try again.', variant: 'destructive' });
  };

  return (
    <div className="space-y-3 pt-1 border-t mt-1" data-testid={`detail-financial-dispute-${d.id}`}>
      {d.details && <p className="text-xs italic text-muted-foreground pt-2">“{d.details}”</p>}
      {d.reconciliationSummary && (
        <div className="rounded-md bg-muted/60 p-2.5 text-xs space-y-1" data-testid={`text-reconciliation-summary-${d.id}`}>
          <div className="font-semibold flex items-center gap-1.5"><Scale className="w-3 h-3" /> Reconciliation report</div>
          <p className="whitespace-pre-wrap">{d.reconciliationSummary}</p>
        </div>
      )}
      {d.counterpartyResponse && (
        <div className="text-xs" data-testid={`text-counterparty-response-${d.id}`}>
          <span className="font-medium">{d.respondentTenantName} responded:</span>{' '}
          <span className="text-muted-foreground">“{d.counterpartyResponse}”</span>
        </div>
      )}
      {d.ruling && (
        <div className="rounded-md border border-primary/30 bg-primary/5 p-2.5 text-xs" data-testid={`text-ruling-${d.id}`}>
          <span className="font-semibold">Platform ruling:</span> {d.ruling}
        </div>
      )}
      {d.adjustments.length > 0 && (
        <div className="space-y-1 text-xs" data-testid={`list-adjustments-${d.id}`}>
          <div className="font-semibold">Ledger adjustments</div>
          {d.adjustments.map(a => (
            <div key={a.id} className="text-muted-foreground" data-testid={`row-adjustment-${a.id}`}>
              {a.adjustmentType === 'bounty_reversal' ? 'Bounty reversal' : 'Adjustment'} of ${a.amount.toFixed(2)}
              {a.creditTenantName && ` · credit ${a.creditTenantName}`}
              {a.debitTenantName && ` · debit ${a.debitTenantName}`} — {a.reason}
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

      {isOpen && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="gap-1.5 h-7"
            onClick={() => setAddingEvidence(o => !o)} data-testid={`button-add-evidence-${d.id}`}>
            <Plus className="w-3 h-3" /> Add evidence
          </Button>
        </div>
      )}
      {isOpen && addingEvidence && (
        <div className="space-y-2 border rounded-md p-2.5">
          <Label className="text-xs">System redemption records</Label>
          <RedemptionPicker partnershipId={d.partnershipId} selected={selectedRedemptions}
            setSelected={setSelectedRedemptions} idPrefix={`detail-${d.id}`} />
          <Label className="text-xs">Receipt entries</Label>
          <ReceiptRows rows={receipts} setRows={setReceipts} idPrefix={`detail-${d.id}`} />
          <Button size="sm" className="h-7"
            disabled={addEvidence.isPending || (selectedRedemptions.size === 0 && receipts.length === 0) || !receiptsValid(receipts)}
            onClick={() =>
              addEvidence.mutate(
                {
                  id: d.id,
                  data: {
                    ...(selectedRedemptions.size > 0 ? { redemptionIds: [...selectedRedemptions] } : {}),
                    ...(receipts.length > 0 ? { receipts: toReceiptPayload(receipts) } : {}),
                  },
                },
                {
                  onSuccess: () => {
                    invalidateFinancial(queryClient);
                    setSelectedRedemptions(new Set());
                    setReceipts([]);
                    setAddingEvidence(false);
                    toast({ title: 'Evidence added to the ticket' });
                  },
                  onError,
                },
              )}
            data-testid={`button-save-evidence-${d.id}`}>
            Attach Evidence
          </Button>
        </div>
      )}
      {isOpen && iAmRespondent && d.counterpartyResponse == null && (
        <div className="space-y-2">
          <Label className="text-xs" htmlFor={`fin-respond-${d.id}`}>Your response</Label>
          <Textarea id={`fin-respond-${d.id}`} placeholder="Your side of the story — visible to your partner and the mediators."
            value={response} onChange={e => setResponse(e.target.value)} data-testid={`input-respond-${d.id}`} />
          <Button size="sm" className="h-7" disabled={!response.trim() || respond.isPending}
            onClick={() =>
              respond.mutate({ id: d.id, data: { response: response.trim() } }, {
                onSuccess: () => {
                  invalidateFinancial(queryClient);
                  setResponse('');
                  toast({ title: 'Response recorded' });
                },
                onError,
              })}
            data-testid={`button-submit-response-${d.id}`}>
            Submit Response
          </Button>
        </div>
      )}
    </div>
  );
}
