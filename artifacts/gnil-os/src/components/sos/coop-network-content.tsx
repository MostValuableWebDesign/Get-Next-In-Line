import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  useListCoopDirectory, getListCoopDirectoryQueryKey,
  useListCoopPartnerships, getListCoopPartnershipsQueryKey,
  useCreateCoopInvite, useRespondToCoopInvite,
  useListCoopActivePerks, getListCoopActivePerksQueryKey,
  useRedeemCoopPerk,
  useListPlatformInvites, getListPlatformInvitesQueryKey,
  useCreatePlatformInvite,
  useListCoopPartnerPerformance, getListCoopPartnerPerformanceQueryKey,
  useListCoopMonthlyReports, getListCoopMonthlyReportsQueryKey,
  useListCoopDisputes, getListCoopDisputesQueryKey,
  useCreateCoopDispute, useWithdrawCoopDispute,
  useListCoopSuggestions, getListCoopSuggestionsQueryKey,
  useDismissCoopSuggestion,
  type CoopSuggestion,
  type CoopDirectoryEntry, type CoopPartnership, type CoopPerkRedeemResult,
  type PlatformInvite,
  type CoopPartnerPerformance, type CoopMonthlyReport,
  type ListCoopPartnerPerformanceParams,
  type CoopDispute, type CoopDisputeCreateCategory,
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
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { CoopCampaignsSection } from '@/components/sos/coop-campaigns-content';
import {
  AlertTriangle, ArrowLeftRight, ArrowUpDown, BarChart3, Bell, CalendarClock, Check, Copy,
  DollarSign, Eye, Flag, Handshake, Keyboard, Link2, MapPin, PauseCircle, ScanLine, Search,
  Send, Store, Ticket, TrendingUp, Undo2, UserPlus, Users, X, XCircle,
} from 'lucide-react';

const DISPUTE_CATEGORIES = [
  'Partner refusing valid digital perk',
  'Inappropriate business conduct',
  'Closed storefront/unresponsive',
] as const;

const SAME_INDUSTRY_MESSAGE = 'Same-industry pairings are restricted by platform guidelines.';

/**
 * Local Co-Op Network — merchant-facing hub (Business Bookings tab).
 *
 * Business owners browse a directory of other businesses on the platform,
 * send partnership invites with a custom perk + mutual reward terms, and
 * accept/decline incoming invites. Accepted partnerships go live on both
 * businesses' checkout, receipt, and customer pass surfaces automatically.
 *
 * All requests are scoped by the selected business (?tenant= → x-tenant-id).
 */
export function CoopNetworkContent({ tenantId }: { tenantId: number | null }) {
  if (tenantId == null) {
    return (
      <Card className="border-dashed shadow-none">
        <CardContent className="p-10 text-center text-muted-foreground" data-testid="text-coop-pick-business">
          Select a specific business above to browse the Local Co-Op Network.
        </CardContent>
      </Card>
    );
  }
  return <CoopNetworkInner key={tenantId} tenantId={tenantId} />;
}

function CoopNetworkInner({ tenantId }: { tenantId: number }) {
  const { data: partnerships, isLoading } = useListCoopPartnerships(
    { tenantId },
    { query: { queryKey: getListCoopPartnershipsQueryKey({ tenantId }) } },
  );
  const { data: perks } = useListCoopActivePerks({
    query: { queryKey: getListCoopActivePerksQueryKey() },
  });
  const { data: disputes } = useListCoopDisputes({
    query: { queryKey: getListCoopDisputesQueryKey() },
  });

  const received = (partnerships ?? []).filter(
    p => p.status === 'pending' && p.requestedByTenantId != null && p.requestedByTenantId !== tenantId,
  );
  const sent = (partnerships ?? []).filter(
    p => p.status === 'pending' && p.requestedByTenantId === tenantId,
  );
  const now = Date.now();
  const isExpired = (p: CoopPartnership) =>
    p.perkEndsAt != null && new Date(p.perkEndsAt).getTime() <= now;
  const active = (partnerships ?? []).filter(
    p => p.status === 'accepted' && p.isActive && !isExpired(p) && p.bannedAt == null,
  );
  // Expired perks are archived, never deleted — shown under an Expired state.
  const expired = (partnerships ?? []).filter(p => p.status === 'accepted' && isExpired(p));
  const partneredTenantIds = useMemo(
    () =>
      new Set(
        (partnerships ?? [])
          .filter(p => p.status !== 'declined')
          .map(p => (p.hostTenantId === tenantId ? p.partnerTenantId : p.hostTenantId)),
      ),
    [partnerships, tenantId],
  );

  return (
    <div className="space-y-6" data-testid="coop-network-hub">
      <div>
        <h2 className="text-xl font-bold tracking-tight flex items-center gap-2">
          <Handshake className="w-5 h-5 text-primary" /> Local Co-Op Network
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Partner with non-competing local businesses. Accepted perks go live automatically on both
          businesses' checkout, receipts, and customer passes.
        </p>
      </div>

      <div>
        <ScanPerkDialog />
      </div>

      {received.length > 0 && (
        <div
          className="rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm flex items-center gap-2"
          role="alert"
          data-testid="alert-coop-incoming-invites"
        >
          <Bell className="w-4 h-4 text-primary shrink-0" />
          <span>
            You have {received.length} pending partnership invite{received.length === 1 ? '' : 's'} —
            review {received.length === 1 ? 'it' : 'them'} below.
          </span>
        </div>
      )}

      <SuggestedPartners tenantId={tenantId} />

      {/* Flash campaigns & seasonal blasts — synchronized limited-time perks
          across the partner network with one frequency-capped joint SMS. */}
      <CoopCampaignsSection tenantId={tenantId} />

      {isLoading ? (
        <Skeleton className="h-24 w-full rounded-xl" />
      ) : (
        <div className="grid lg:grid-cols-2 gap-6 items-start">
          <div className="space-y-6">
            <ReceivedInvites invites={received} />
            <SentInvites invites={sent} />
            <PlatformInvitesList />
            <ActivePartnerships
              partnerships={active}
              expired={expired}
              disclaimer={perks?.disclaimer ?? null}
              tenantId={tenantId}
              disputes={disputes ?? []}
            />
          </div>
          <Directory tenantId={tenantId} partneredTenantIds={partneredTenantIds} />
        </div>
      )}

      <PartnerPerformanceTable />
      <MonthlyImpactReport />
    </div>
  );
}

// ── Partner performance breakdown ────────────────────────────────────────────

type PerfRange = '30d' | '90d' | 'all';
type PerfSortKey = 'impressions' | 'claims' | 'clientsSent' | 'clientsReceived' | 'revenueInfluenced';

function perfParams(range: PerfRange): ListCoopPartnerPerformanceParams | undefined {
  if (range === 'all') return undefined;
  const days = range === '30d' ? 30 : 90;
  return { from: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString() };
}

function PartnerPerformanceTable() {
  const [range, setRange] = useState<PerfRange>('all');
  const [sortKey, setSortKey] = useState<PerfSortKey>('revenueInfluenced');
  const [sortDesc, setSortDesc] = useState(true);
  const params = perfParams(range);
  const { data: rows, isLoading } = useListCoopPartnerPerformance(params, {
    query: { queryKey: getListCoopPartnerPerformanceQueryKey(params) },
  });

  const sorted = useMemo(() => {
    const list = [...(rows ?? [])];
    list.sort((a, b) => (sortDesc ? b[sortKey] - a[sortKey] : a[sortKey] - b[sortKey]));
    return list;
  }, [rows, sortKey, sortDesc]);

  const toggleSort = (key: PerfSortKey) => {
    if (key === sortKey) setSortDesc(d => !d);
    else { setSortKey(key); setSortDesc(true); }
  };

  const SortHeader = ({ label, k }: { label: string; k: PerfSortKey }) => (
    <th className="py-2 px-3 text-right font-medium">
      <button
        className={`inline-flex items-center gap-1 hover:text-foreground ${sortKey === k ? 'text-foreground' : 'text-muted-foreground'}`}
        onClick={() => toggleSort(k)}
        data-testid={`button-sort-${k}`}
      >
        {label} <ArrowUpDown className="w-3 h-3" />
      </button>
    </th>
  );

  return (
    <Card data-testid="card-coop-partner-performance">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-primary" /> Partner Performance
            </CardTitle>
            <CardDescription>
              What each collaboration is doing for you — impressions, perks claimed, clients
              exchanged, and estimated revenue influenced.
            </CardDescription>
          </div>
          <Select value={range} onValueChange={v => setRange(v as PerfRange)}>
            <SelectTrigger className="w-36" data-testid="select-perf-range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="30d">Last 30 days</SelectItem>
              <SelectItem value="90d">Last 90 days</SelectItem>
              <SelectItem value="all">All time</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-24 w-full rounded-lg" />
        ) : sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-perf-data">
            No partnerships to report on yet. Once you have accepted partnerships, their
            impressions, claims, and cross-over visits show up here.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="table-partner-performance">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="py-2 px-3 text-left font-medium">Partner</th>
                  <SortHeader label="Impressions" k="impressions" />
                  <SortHeader label="Claimed" k="claims" />
                  <SortHeader label="Sent" k="clientsSent" />
                  <SortHeader label="Received" k="clientsReceived" />
                  <SortHeader label="Revenue" k="revenueInfluenced" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((r: CoopPartnerPerformance) => (
                  <tr key={r.partnershipId} className="border-b last:border-0" data-testid={`row-perf-${r.partnershipId}`}>
                    <td className="py-2 px-3">
                      <div className="font-medium">{r.partnerName}</div>
                      <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                        {r.perkTitle}
                        {!r.isActive && <Badge variant="outline" className="text-[9px] px-1 py-0">Inactive</Badge>}
                      </div>
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums" data-testid={`cell-impressions-${r.partnershipId}`}>{r.impressions}</td>
                    <td className="py-2 px-3 text-right tabular-nums" data-testid={`cell-claims-${r.partnershipId}`}>{r.claims}</td>
                    <td className="py-2 px-3 text-right tabular-nums" data-testid={`cell-sent-${r.partnershipId}`}>{r.clientsSent}</td>
                    <td className="py-2 px-3 text-right tabular-nums" data-testid={`cell-received-${r.partnershipId}`}>{r.clientsReceived}</td>
                    <td className="py-2 px-3 text-right tabular-nums font-medium" data-testid={`cell-revenue-${r.partnershipId}`}>
                      ${r.revenueInfluenced.toFixed(2)}
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

// ── Monthly impact report ────────────────────────────────────────────────────

function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleString('en-US', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

function MonthlyImpactReport() {
  const { data: reports, isLoading } = useListCoopMonthlyReports({
    query: { queryKey: getListCoopMonthlyReportsQueryKey() },
  });
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const report: CoopMonthlyReport | undefined =
    (reports ?? []).find(r => r.month === selectedMonth) ?? (reports ?? [])[0];

  const stat = (
    icon: ReactNode, label: string, value: string, testid: string,
  ) => (
    <div className="border rounded-lg p-4" data-testid={testid}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">{icon} {label}</div>
      <div className="text-2xl font-bold tabular-nums mt-1">{value}</div>
    </div>
  );

  return (
    <Card data-testid="card-coop-monthly-report">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-primary" /> Monthly Impact Report
            </CardTitle>
            <CardDescription>
              Your automated co-op summary — generated after each month closes and sent to you as a
              notification.
            </CardDescription>
          </div>
          {(reports ?? []).length > 0 && (
            <Select value={report?.month ?? ''} onValueChange={setSelectedMonth}>
              <SelectTrigger className="w-44" data-testid="select-report-month">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(reports ?? []).map(r => (
                  <SelectItem key={r.month} value={r.month}>{monthLabel(r.month)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-24 w-full rounded-lg" />
        ) : !report ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-monthly-report">
            No monthly report yet — your first co-op impact summary arrives after the first full
            month of tracked activity.
          </p>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-testid={`report-month-${report.month}`}>
            {stat(<Eye className="w-3.5 h-3.5" />, 'Perk impressions', String(report.impressions), 'stat-report-impressions')}
            {stat(<Ticket className="w-3.5 h-3.5" />, 'Perks claimed', String(report.claims), 'stat-report-claims')}
            {stat(<Users className="w-3.5 h-3.5" />, 'Cross-over visits', String(report.crossoverVisits), 'stat-report-crossover')}
            {stat(<DollarSign className="w-3.5 h-3.5" />, 'Revenue influenced', `$${report.revenueInfluenced.toFixed(2)}`, 'stat-report-revenue')}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Received invites ─────────────────────────────────────────────────────────

function ReceivedInvites({ invites }: { invites: CoopPartnership[] }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const respond = useRespondToCoopInvite();

  const act = (invite: CoopPartnership, action: 'accept' | 'decline') => {
    respond.mutate(
      { id: invite.id, data: { action } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            predicate: q => typeof q.queryKey[0] === 'string' && q.queryKey[0].includes('/api/coop/'),
          });
          toast({
            title: action === 'accept' ? 'Partnership accepted' : 'Invite declined',
            description:
              action === 'accept'
                ? 'The perk is now live on both businesses\u2019 checkout, receipts, and customer passes.'
                : 'The perk will not appear anywhere.',
          });
        },
        onError: (err: unknown) => {
          const e = err as { data?: { message?: string }; message?: string };
          toast({
            title: 'Could not respond',
            description: e?.data?.message ?? e?.message ?? 'Please try again.',
            variant: 'destructive',
          });
        },
      },
    );
  };

  return (
    <Card data-testid="card-coop-received-invites">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Bell className="w-4 h-4 text-primary" /> Invites Received
          {invites.length > 0 && <Badge data-testid="badge-received-count">{invites.length}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {invites.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-received-invites">
            No incoming invites right now.
          </p>
        ) : (
          invites.map(p => (
            <div key={p.id} className="border rounded-lg p-3 space-y-2" data-testid={`row-received-invite-${p.id}`}>
              <div className="text-sm font-semibold">{p.hostTenantName} wants to partner with you</div>
              <div className="text-sm">{p.perkTitle}</div>
              {p.perkDescription && <div className="text-xs text-muted-foreground">{p.perkDescription}</div>}
              {p.mutualRewardTerms && (
                <div className="text-xs text-muted-foreground">
                  <span className="font-medium">Mutual terms:</span> {p.mutualRewardTerms}
                </div>
              )}
              <div className="flex gap-2 pt-1">
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={respond.isPending}
                  onClick={() => act(p, 'accept')}
                  data-testid={`button-accept-invite-${p.id}`}
                >
                  <Check className="w-3.5 h-3.5" /> Accept &amp; Launch
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  disabled={respond.isPending}
                  onClick={() => act(p, 'decline')}
                  data-testid={`button-decline-invite-${p.id}`}
                >
                  <X className="w-3.5 h-3.5" /> Decline
                </Button>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

// ── Sent invites ─────────────────────────────────────────────────────────────

function SentInvites({ invites }: { invites: CoopPartnership[] }) {
  return (
    <Card data-testid="card-coop-sent-invites">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Send className="w-4 h-4 text-muted-foreground" /> Invites Sent
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {invites.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-sent-invites">
            No pending invites you've sent.
          </p>
        ) : (
          invites.map(p => (
            <div key={p.id} className="border rounded-lg p-3 flex items-center justify-between gap-3" data-testid={`row-sent-invite-${p.id}`}>
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">To {p.partnerTenantName}</div>
                <div className="text-xs text-muted-foreground truncate">{p.perkTitle}</div>
              </div>
              <Badge variant="secondary" className="shrink-0">Pending</Badge>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

// ── Active partnerships ──────────────────────────────────────────────────────

function perkWindowLabel(p: CoopPartnership): string | null {
  const fmt = (iso: string) => new Date(iso).toLocaleDateString();
  if (p.perkStartsAt && p.perkEndsAt) return `${fmt(p.perkStartsAt)} – ${fmt(p.perkEndsAt)}`;
  if (p.perkStartsAt) return `From ${fmt(p.perkStartsAt)}`;
  if (p.perkEndsAt) return `Through ${fmt(p.perkEndsAt)}`;
  return null;
}

function ActivePartnerships({
  partnerships, expired, disclaimer, tenantId, disputes,
}: {
  partnerships: CoopPartnership[];
  expired: CoopPartnership[];
  disclaimer: string | null;
  tenantId: number;
  disputes: CoopDispute[];
}) {
  const [reportTarget, setReportTarget] = useState<CoopPartnership | null>(null);
  const activeDisputeFor = (partnershipId: number) =>
    disputes.find(d => d.partnershipId === partnershipId && (d.status === 'open' || d.status === 'escalated')) ?? null;
  return (
    <Card data-testid="card-coop-active-partnerships">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Handshake className="w-4 h-4 text-emerald-600" /> Active Partnerships
        </CardTitle>
        <CardDescription>
          These perks are live on checkout, receipts, and customer passes for both businesses.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {partnerships.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-active-partnerships">
            No active partnerships yet — send an invite from the directory.
          </p>
        ) : (
          partnerships.map(p => {
            const otherName = p.hostTenantId === tenantId ? p.partnerTenantName : p.hostTenantName;
            const window = perkWindowLabel(p);
            const scheduled = p.perkStartsAt != null && new Date(p.perkStartsAt).getTime() > Date.now();
            const dispute = activeDisputeFor(p.id);
            return (
              <div key={p.id} className="border rounded-lg p-3 space-y-1" data-testid={`row-active-partnership-${p.id}`}>
                <div className="flex items-center gap-2 text-sm font-medium">
                  <ArrowLeftRight className="w-3.5 h-3.5 text-muted-foreground" /> {otherName}
                  {p.disputeSuspended ? (
                    <Badge variant="destructive" className="ml-auto" data-testid={`badge-partnership-suspended-${p.id}`}>Suspended</Badge>
                  ) : scheduled ? (
                    <Badge variant="secondary" className="ml-auto" data-testid={`badge-partnership-scheduled-${p.id}`}>Scheduled</Badge>
                  ) : (
                    <Badge className="ml-auto" data-testid={`badge-partnership-live-${p.id}`}>Live</Badge>
                  )}
                </div>
                <div className="text-sm">{p.perkTitle}</div>
                {p.mutualRewardTerms && (
                  <div className="text-xs text-muted-foreground">
                    <span className="font-medium">Mutual terms:</span> {p.mutualRewardTerms}
                  </div>
                )}
                {window && (
                  <div className="text-xs text-muted-foreground flex items-center gap-1" data-testid={`text-perk-window-${p.id}`}>
                    <CalendarClock className="w-3 h-3" /> {window}
                  </div>
                )}
                <div className="text-xs text-muted-foreground font-mono flex items-center gap-1">
                  <Ticket className="w-3 h-3" /> {p.redemptionCode}
                </div>
                <DisputeStatus
                  partnership={p}
                  dispute={dispute}
                  tenantId={tenantId}
                  onReport={() => setReportTarget(p)}
                />
              </div>
            );
          })
        )}
        {expired.length > 0 && (
          <div className="pt-2 space-y-2" data-testid="list-expired-partnerships">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Expired
            </div>
            {expired.map(p => {
              const otherName = p.hostTenantId === tenantId ? p.partnerTenantName : p.hostTenantName;
              return (
                <div key={p.id} className="border rounded-lg p-3 space-y-1 opacity-60" data-testid={`row-expired-partnership-${p.id}`}>
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <ArrowLeftRight className="w-3.5 h-3.5 text-muted-foreground" /> {otherName}
                    <Badge variant="outline" className="ml-auto" data-testid={`badge-partnership-expired-${p.id}`}>Expired</Badge>
                  </div>
                  <div className="text-sm">{p.perkTitle}</div>
                  {p.perkEndsAt && (
                    <div className="text-xs text-muted-foreground flex items-center gap-1">
                      <CalendarClock className="w-3 h-3" /> Ended {new Date(p.perkEndsAt).toLocaleDateString()}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {disclaimer && (partnerships.length > 0 || expired.length > 0) && (
          <p className="text-[10px] leading-snug text-muted-foreground pt-2 border-t" data-testid="text-hub-perk-disclaimer">
            {disclaimer}
          </p>
        )}
      </CardContent>
      <ReportPartnerIssueDialog
        tenantId={tenantId}
        target={reportTarget}
        onClose={() => setReportTarget(null)}
      />
    </Card>
  );
}

// ── Dispute status + reporting ───────────────────────────────────────────────

function businessDaysLeftLabel(deadlineIso: string): string {
  const ms = new Date(deadlineIso).getTime() - Date.now();
  if (ms <= 0) return 'Grace period ended — pending automatic suspension';
  const days = Math.ceil(ms / (24 * 60 * 60 * 1000));
  return `Grace period: ${days} day${days === 1 ? '' : 's'} left to resolve (until ${new Date(deadlineIso).toLocaleDateString()})`;
}

/**
 * Per-partnership dispute surface: the "Report Partner Issue" entry point on
 * healthy partnerships, and the grace-period countdown / suspended notice /
 * withdraw option once a dispute exists. Both parties see the status.
 */
function DisputeStatus({
  partnership, dispute, tenantId, onReport,
}: {
  partnership: CoopPartnership;
  dispute: CoopDispute | null;
  tenantId: number;
  onReport: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const withdraw = useWithdrawCoopDispute();

  if (!dispute) {
    return (
      <div className="pt-1.5">
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 text-destructive hover:text-destructive"
          onClick={onReport}
          data-testid={`button-report-issue-${partnership.id}`}
        >
          <Flag className="w-3.5 h-3.5" /> Report Partner Issue
        </Button>
      </div>
    );
  }

  const iAmReporter = dispute.reportingTenantId === tenantId;
  const doWithdraw = () => {
    withdraw.mutate(
      { id: dispute.id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            predicate: q => typeof q.queryKey[0] === 'string' && q.queryKey[0].includes('/api/coop/'),
          });
          toast({ title: 'Dispute withdrawn', description: 'The partnership is fully restored.' });
        },
        onError: (err: unknown) => {
          const e = err as { data?: { message?: string }; message?: string };
          toast({
            title: 'Could not withdraw',
            description: e?.data?.message ?? e?.message ?? 'Please try again.',
            variant: 'destructive',
          });
        },
      },
    );
  };

  return (
    <div
      className="mt-1.5 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-2.5 text-xs space-y-1.5"
      data-testid={`dispute-status-${partnership.id}`}
    >
      <div className="flex items-start gap-1.5 font-medium">
        {dispute.status === 'escalated' ? (
          <PauseCircle className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" />
        ) : (
          <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
        )}
        <span data-testid={`text-dispute-summary-${partnership.id}`}>
          {iAmReporter
            ? `You reported: ${dispute.category}`
            : `${dispute.reportingTenantName} reported: ${dispute.category}`}
        </span>
      </div>
      {dispute.status === 'open' ? (
        <p className="text-muted-foreground" data-testid={`text-dispute-grace-${partnership.id}`}>
          {businessDaysLeftLabel(dispute.graceDeadlineAt)}. If unresolved, the shared perk will be
          paused automatically.
        </p>
      ) : (
        <p className="text-destructive font-medium" data-testid={`text-dispute-suspended-${partnership.id}`}>
          The grace period expired without resolution — this perk is paused and the partnership is
          hidden until a platform admin reviews it.
        </p>
      )}
      {iAmReporter && dispute.status === 'open' && (
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 h-7"
          disabled={withdraw.isPending}
          onClick={doWithdraw}
          data-testid={`button-withdraw-dispute-${partnership.id}`}
        >
          <Undo2 className="w-3 h-3" /> Withdraw dispute
        </Button>
      )}
    </div>
  );
}

function ReportPartnerIssueDialog({
  tenantId, target, onClose,
}: {
  tenantId: number;
  target: CoopPartnership | null;
  onClose: () => void;
}) {
  const [category, setCategory] = useState<string>('');
  const [details, setDetails] = useState('');
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createDispute = useCreateCoopDispute();

  const reset = () => { setCategory(''); setDetails(''); };
  const otherName = target
    ? (target.hostTenantId === tenantId ? target.partnerTenantName : target.hostTenantName)
    : '';

  const submit = () => {
    if (!target || !category) return;
    createDispute.mutate(
      {
        data: {
          partnershipId: target.id,
          category: category as CoopDisputeCreateCategory,
          ...(details.trim() ? { details: details.trim() } : {}),
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            predicate: q => typeof q.queryKey[0] === 'string' && q.queryKey[0].includes('/api/coop/'),
          });
          toast({
            title: 'Issue reported',
            description: `${otherName} has been alerted. They have 7 business days to resolve it before the perk is paused.`,
          });
          onClose();
          reset();
        },
        onError: (err: unknown) => {
          const e = err as { data?: { message?: string }; message?: string };
          toast({
            title: 'Could not file the report',
            description: e?.data?.message ?? e?.message ?? 'Please try again.',
            variant: 'destructive',
          });
        },
      },
    );
  };

  return (
    <Dialog open={target != null} onOpenChange={o => { if (!o) { onClose(); reset(); } }}>
      <DialogContent data-testid="dialog-report-issue">
        <DialogHeader>
          <DialogTitle>Report Partner Issue</DialogTitle>
          <DialogDescription>
            Report a problem with {otherName}. They'll be alerted and given 7 business days to
            resolve it — if it stays unresolved, the shared perk is paused automatically and the
            dispute goes to platform admins.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>What's the issue?</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger data-testid="select-dispute-category">
                <SelectValue placeholder="Choose a category" />
              </SelectTrigger>
              <SelectContent>
                {DISPUTE_CATEGORIES.map(c => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="dispute-details">Details (optional)</Label>
            <Textarea
              id="dispute-details"
              placeholder="What happened? Anything that helps your partner or the platform resolve this."
              value={details}
              onChange={e => setDetails(e.target.value)}
              data-testid="input-dispute-details"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="destructive"
            onClick={submit}
            disabled={!category || createDispute.isPending}
            data-testid="button-submit-dispute"
          >
            <Flag className="w-4 h-4 mr-1.5" /> File Report
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Scan Perk — camera QR validation of a customer's co-op pass ─────────────

function ScanPerkDialog() {
  const [open, setOpen] = useState(false);
  const [manual, setManual] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState('');
  const [manualPass, setManualPass] = useState('');
  const [result, setResult] = useState<CoopPerkRedeemResult | null>(null);
  const queryClient = useQueryClient();
  const redeem = useRedeemCoopPerk();
  const scannerRef = useRef<{ stop: () => Promise<void>; clear: () => void } | null>(null);
  const scanningRef = useRef(false);
  const regionId = 'coop-scan-region';

  const stopScanner = () => {
    const s = scannerRef.current;
    scannerRef.current = null;
    if (s) s.stop().then(() => s.clear()).catch(() => undefined);
  };

  const handlePayload = (payload: string) => {
    if (scanningRef.current) return;
    scanningRef.current = true;
    stopScanner();
    // Wallet passes (from the customer Local Perks app) encode a single
    // WPASS- token that carries its own single-use state — no pass ID needed.
    if (payload.trim().startsWith('WPASS-')) {
      submit(payload.trim());
      return;
    }
    // QR payload: "<redemptionCode>|<passCode>"; a bare code is accepted but
    // the server requires a pass instance, so route it to manual entry.
    const [code, passCode] = payload.split('|').map(s => s.trim());
    if (!code || !passCode) {
      setManual(true);
      setManualCode(code ?? '');
      setCameraError('That QR code is missing the pass details — enter them manually.');
      scanningRef.current = false;
      return;
    }
    submit(code, passCode);
  };

  const submit = (code: string, passCode?: string) => {
    redeem.mutate(
      { data: passCode ? { code, passCode } : { code } },
      {
        onSuccess: r => {
          setResult(r);
          queryClient.invalidateQueries({
            predicate: q => typeof q.queryKey[0] === 'string' && q.queryKey[0].includes('/api/coop/'),
          });
        },
        onError: () => {
          setResult({ valid: false, reason: 'Could not reach the server — try again.', partnership: null, redeemedAt: null });
        },
        onSettled: () => { scanningRef.current = false; },
      },
    );
  };

  // Start/stop the camera scanner while the dialog is open in camera mode.
  useEffect(() => {
    if (!open || manual || result != null) return;
    let cancelled = false;
    (async () => {
      try {
        const { Html5Qrcode } = await import('html5-qrcode');
        if (cancelled) return;
        const scanner = new Html5Qrcode(regionId);
        scannerRef.current = scanner;
        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 220, height: 220 } },
          decoded => handlePayload(decoded),
          () => undefined, // per-frame decode misses are normal
        );
      } catch {
        if (!cancelled) {
          setCameraError('Camera unavailable — use manual entry below.');
          setManual(true);
        }
      }
    })();
    return () => { cancelled = true; stopScanner(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, manual, result]);

  const reset = () => {
    stopScanner();
    setManual(false);
    setCameraError(null);
    setManualCode('');
    setManualPass('');
    setResult(null);
  };

  return (
    <Dialog open={open} onOpenChange={o => { setOpen(o); if (!o) reset(); }}>
      <Button className="gap-2" onClick={() => setOpen(true)} data-testid="button-scan-perk">
        <ScanLine className="w-4 h-4" /> Scan Perk
      </Button>
      <DialogContent data-testid="dialog-scan-perk">
        <DialogHeader>
          <DialogTitle>Scan a Co-Op Pass</DialogTitle>
          <DialogDescription>
            Point the camera at the QR code on the customer's pass. Each pass can be redeemed once.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div
            className={`rounded-lg border p-4 space-y-2 ${result.valid ? 'border-emerald-400 bg-emerald-500/10' : 'border-destructive/50 bg-destructive/10'}`}
            data-testid={result.valid ? 'result-scan-valid' : 'result-scan-invalid'}
          >
            <div className="flex items-center gap-2 font-semibold">
              {result.valid ? (
                <><Check className="w-5 h-5 text-emerald-600" /> Perk redeemed</>
              ) : (
                <><XCircle className="w-5 h-5 text-destructive" /> Not valid</>
              )}
            </div>
            {!result.valid && result.reason && (
              <p className="text-sm" data-testid="text-scan-reason">{result.reason}</p>
            )}
            {result.partnership && (
              <div className="text-sm space-y-0.5">
                <div className="font-medium">{result.partnership.perkTitle}</div>
                {result.partnership.perkDescription && (
                  <div className="text-muted-foreground">{result.partnership.perkDescription}</div>
                )}
                <div className="text-xs text-muted-foreground">
                  {result.partnership.hostTenantName} × {result.partnership.partnerTenantName}
                </div>
              </div>
            )}
            {result.valid && (
              <p className="text-xs text-muted-foreground">
                This pass is now locked — scanning it again will be rejected.
              </p>
            )}
            <Button size="sm" variant="outline" onClick={reset} data-testid="button-scan-again">
              Scan another
            </Button>
          </div>
        ) : manual ? (
          <div className="space-y-3">
            {cameraError && (
              <p className="text-sm text-muted-foreground" data-testid="text-camera-error">{cameraError}</p>
            )}
            <div className="space-y-2">
              <Label htmlFor="scan-manual-code">Redemption code</Label>
              <Input
                id="scan-manual-code"
                placeholder="COOP-XXXXXXXX"
                className="font-mono"
                value={manualCode}
                onChange={e => setManualCode(e.target.value)}
                data-testid="input-manual-code"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="scan-manual-pass">Pass ID (printed under the QR code — not needed for WPASS- wallet tokens)</Label>
              <Input
                id="scan-manual-pass"
                placeholder="e.g. C123"
                className="font-mono"
                value={manualPass}
                onChange={e => setManualPass(e.target.value)}
                data-testid="input-manual-pass"
              />
            </div>
            <div className="flex gap-2">
              <Button
                onClick={() => submit(manualCode.trim(), manualPass.trim() || undefined)}
                disabled={!manualCode.trim() || (!manualPass.trim() && !manualCode.trim().startsWith('WPASS-')) || redeem.isPending}
                data-testid="button-manual-redeem"
              >
                Validate & Redeem
              </Button>
              <Button variant="outline" onClick={() => { setManual(false); setCameraError(null); }} data-testid="button-back-to-camera">
                Use camera
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div id={regionId} className="rounded-lg overflow-hidden bg-black/90 min-h-[240px]" data-testid="scan-camera-region" />
            <Button variant="outline" className="gap-2" onClick={() => setManual(true)} data-testid="button-manual-entry">
              <Keyboard className="w-4 h-4" /> Enter code manually
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Directory + perk builder ─────────────────────────────────────────────────

// ── Suggested Partners — automated matchmaking feed ─────────────────────────
// Ranked by complementary fit (category pairings, proximity, activity). Each
// card explains why the business was matched and offers a one-click invite
// with a pre-formatted, editable proposal. Dismissed suggestions stay hidden.
function SuggestedPartners({ tenantId }: { tenantId: number }) {
  const [inviteTarget, setInviteTarget] = useState<CoopSuggestion | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: suggestions, isLoading } = useListCoopSuggestions({
    query: { queryKey: getListCoopSuggestionsQueryKey() },
  });
  const dismiss = useDismissCoopSuggestion();

  const dismissSuggestion = (s: CoopSuggestion) => {
    dismiss.mutate(
      { tenantId: s.tenantId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCoopSuggestionsQueryKey() });
          toast({
            title: 'Suggestion dismissed',
            description: `${s.name} won't be suggested again.`,
          });
        },
        onError: () => {
          toast({ title: 'Could not dismiss suggestion', description: 'Please try again.', variant: 'destructive' });
        },
      },
    );
  };

  if (!isLoading && (suggestions ?? []).length === 0) return null;

  return (
    <Card className="border-primary/30" data-testid="card-coop-suggested-partners">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-primary" /> Suggested Partners
        </CardTitle>
        <CardDescription>
          Complementary local businesses picked for you — matched on category fit, distance, and
          customer activity. One click sends a ready-made partnership proposal.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="grid sm:grid-cols-2 gap-3">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-3">
            {(suggestions ?? []).map(s => (
              <div
                key={s.tenantId}
                className="border rounded-lg p-3 space-y-2 relative"
                data-testid={`card-suggested-partner-${s.tenantId}`}
              >
                <button
                  type="button"
                  className="absolute top-2 right-2 text-muted-foreground hover:text-foreground"
                  aria-label={`Dismiss ${s.name}`}
                  disabled={dismiss.isPending}
                  onClick={() => dismissSuggestion(s)}
                  data-testid={`button-dismiss-suggestion-${s.tenantId}`}
                >
                  <X className="w-4 h-4" />
                </button>
                <div className="pr-6">
                  <div className="text-sm font-semibold truncate">{s.name}</div>
                  <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap mt-0.5">
                    {s.category && <span className="capitalize">{s.category}</span>}
                    {(s.distanceMiles != null || s.city) && (
                      <span className="flex items-center gap-0.5">
                        <MapPin className="w-3 h-3" />
                        {s.distanceMiles != null ? `${s.distanceMiles} mi` : s.city}
                        {s.distanceMiles != null && s.city ? ` · ${s.city}` : ''}
                      </span>
                    )}
                  </div>
                </div>
                {s.reasons.length > 0 && (
                  <ul className="text-xs text-muted-foreground space-y-0.5" data-testid={`list-match-reasons-${s.tenantId}`}>
                    {s.reasons.map((r, i) => (
                      <li key={i} className="flex items-start gap-1">
                        <Check className="w-3 h-3 mt-0.5 text-primary shrink-0" /> {r}
                      </li>
                    ))}
                  </ul>
                )}
                <Button
                  size="sm"
                  className="w-full gap-1.5"
                  onClick={() => setInviteTarget(s)}
                  data-testid={`button-suggested-invite-${s.tenantId}`}
                >
                  <Send className="w-3.5 h-3.5" /> Send Partnership Invitation
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <PerkBuilderDialog
        tenantId={tenantId}
        target={inviteTarget ? { id: inviteTarget.tenantId, name: inviteTarget.name } : null}
        initial={inviteTarget?.proposal ?? null}
        onClose={() => setInviteTarget(null)}
      />
    </Card>
  );
}

function Directory({
  tenantId, partneredTenantIds,
}: {
  tenantId: number;
  partneredTenantIds: Set<number>;
}) {
  const [search, setSearch] = useState('');
  const [city, setCity] = useState<string>('all');
  const [category, setCategory] = useState<string>('all');
  const [inviteTarget, setInviteTarget] = useState<CoopDirectoryEntry | null>(null);
  const [platformInviteName, setPlatformInviteName] = useState<string | null>(null);
  const { toast } = useToast();

  // Fetch unfiltered and filter client-side so the city/category dropdowns
  // always show every available option.
  const { data: directory, isLoading } = useListCoopDirectory(undefined, {
    query: { queryKey: getListCoopDirectoryQueryKey(undefined) },
  });

  const cities = useMemo(
    () => [...new Set((directory ?? []).map(d => d.city).filter((c): c is string => !!c))].sort(),
    [directory],
  );
  const categories = useMemo(
    () => [...new Set((directory ?? []).map(d => d.category).filter((c): c is string => !!c))].sort(),
    [directory],
  );

  const filtered = (directory ?? [])
    .filter(d => !search.trim() || d.name.toLowerCase().includes(search.trim().toLowerCase()))
    .filter(d => city === 'all' || d.city === city)
    .filter(d => category === 'all' || d.category === category);

  const startInvite = (biz: CoopDirectoryEntry) => {
    if (biz.sameIndustry) {
      toast({ title: 'Pairing restricted', description: SAME_INDUSTRY_MESSAGE, variant: 'destructive' });
      return;
    }
    setInviteTarget(biz);
  };

  return (
    <Card data-testid="card-coop-directory">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Store className="w-4 h-4 text-primary" /> Business Directory
        </CardTitle>
        <CardDescription>Discover non-competing local businesses to partner with.</CardDescription>
        <div className="flex flex-col sm:flex-row gap-2 pt-2">
          <div className="relative flex-1">
            <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search businesses…"
              className="pl-8 h-9"
              data-testid="input-directory-search"
            />
          </div>
          <Select value={city} onValueChange={setCity}>
            <SelectTrigger className="h-9 sm:w-36" data-testid="select-directory-city">
              <SelectValue placeholder="Location" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All locations</SelectItem>
              {cities.map(c => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="h-9 sm:w-36" data-testid="select-directory-category">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {categories.map(c => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <div className="space-y-2"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>
        ) : filtered.length === 0 ? (
          search.trim() ? (
            <div className="text-center py-6 space-y-3" data-testid="state-business-not-found">
              <p className="text-sm font-medium">Business not found on the network</p>
              <p className="text-sm text-muted-foreground">
                "{search.trim()}" isn't on Get Next In Line yet. Invite them — when they join
                through your link, a partnership request is created automatically.
              </p>
              <Button
                className="gap-2"
                onClick={() => setPlatformInviteName(search.trim())}
                data-testid="button-invite-to-platform"
              >
                <UserPlus className="w-4 h-4" /> Invite to Get Next In Line &amp; Partner
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-6" data-testid="text-directory-empty">
              No businesses match your filters.
            </p>
          )
        ) : (
          filtered.map(biz => (
            <div
              key={biz.id}
              className="border rounded-lg p-3 flex items-center justify-between gap-3"
              data-testid={`row-directory-business-${biz.id}`}
            >
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{biz.name}</div>
                <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap mt-0.5">
                  {biz.category && <span className="capitalize">{biz.category}</span>}
                  {biz.city && (
                    <span className="flex items-center gap-0.5">
                      <MapPin className="w-3 h-3" /> {biz.city}
                    </span>
                  )}
                  {biz.distanceMiles != null && (
                    <span data-testid={`text-directory-distance-${biz.id}`}>
                      {biz.distanceMiles} mi away
                    </span>
                  )}
                </div>
                {biz.sameIndustry && (
                  <Badge
                    variant="outline"
                    className="mt-1 text-amber-600 border-amber-300"
                    data-testid={`badge-same-industry-${biz.id}`}
                  >
                    <AlertTriangle className="w-3 h-3 mr-1" /> Same industry — restricted
                  </Badge>
                )}
              </div>
              {partneredTenantIds.has(biz.id) ? (
                <Badge variant="secondary" className="shrink-0" data-testid={`badge-already-partnered-${biz.id}`}>
                  Invited / Partnered
                </Badge>
              ) : (
                <Button
                  size="sm"
                  variant={biz.sameIndustry ? 'outline' : 'default'}
                  className="shrink-0"
                  onClick={() => startInvite(biz)}
                  data-testid={`button-partner-up-${biz.id}`}
                >
                  Partner Up
                </Button>
              )}
            </div>
          ))
        )}
      </CardContent>

      <PerkBuilderDialog
        tenantId={tenantId}
        target={inviteTarget}
        onClose={() => setInviteTarget(null)}
      />
      <PlatformInviteDialog
        initialName={platformInviteName}
        onClose={() => setPlatformInviteName(null)}
      />
    </Card>
  );
}

function PerkBuilderDialog({
  tenantId, target, initial, onClose,
}: {
  tenantId: number;
  target: { id: number; name: string } | null;
  /** Pre-formatted proposal draft (Suggested Partners flow) — editable before sending. */
  initial?: { perkTitle: string; perkDescription: string; mutualRewardTerms: string } | null;
  onClose: () => void;
}) {
  const [perkTitle, setPerkTitle] = useState('');
  const [perkDescription, setPerkDescription] = useState('');
  const [mutualRewardTerms, setMutualRewardTerms] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');

  // Seed the form with the auto-generated proposal whenever a new target opens.
  const targetId = target?.id ?? null;
  useEffect(() => {
    if (targetId != null && initial) {
      setPerkTitle(initial.perkTitle);
      setPerkDescription(initial.perkDescription);
      setMutualRewardTerms(initial.mutualRewardTerms);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId]);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createInvite = useCreateCoopInvite();

  const windowInvalid =
    startsAt !== '' && endsAt !== '' && new Date(endsAt) <= new Date(startsAt);

  const close = () => {
    setPerkTitle('');
    setPerkDescription('');
    setMutualRewardTerms('');
    setStartsAt('');
    setEndsAt('');
    onClose();
  };

  const send = () => {
    if (!target) return;
    createInvite.mutate(
      {
        data: {
          partnerTenantId: target.id,
          perkTitle: perkTitle.trim(),
          ...(perkDescription.trim() ? { perkDescription: perkDescription.trim() } : {}),
          ...(mutualRewardTerms.trim() ? { mutualRewardTerms: mutualRewardTerms.trim() } : {}),
          ...(startsAt ? { perkStartsAt: new Date(startsAt).toISOString() } : {}),
          ...(endsAt ? { perkEndsAt: new Date(endsAt).toISOString() } : {}),
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            predicate: q => typeof q.queryKey[0] === 'string' && q.queryKey[0].includes('/api/coop/'),
          });
          toast({
            title: 'Invite sent',
            description: `${target.name} will see your proposal and can accept it from their hub.`,
          });
          close();
        },
        onError: (err: unknown) => {
          const e = err as { status?: number; data?: { code?: string; message?: string }; message?: string };
          const restricted = e?.status === 403 || e?.data?.code === 'SAME_INDUSTRY_RESTRICTED';
          toast({
            title: restricted ? 'Pairing restricted' : 'Could not send invite',
            description: restricted
              ? SAME_INDUSTRY_MESSAGE
              : e?.data?.message ?? e?.message ?? 'Please try again.',
            variant: 'destructive',
          });
        },
      },
    );
  };

  return (
    <Dialog open={target != null} onOpenChange={o => { if (!o) close(); }}>
      <DialogContent data-testid="dialog-perk-builder">
        <DialogHeader>
          <DialogTitle>Partner with {target?.name}</DialogTitle>
          <DialogDescription>
            Describe the perk your businesses will offer each other's customers. It goes live on
            both checkouts, receipts, and customer passes the moment they accept.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="coop-invite-perk">Perk description</Label>
            <Input
              id="coop-invite-perk"
              placeholder='e.g. "10% off your meal or service"'
              value={perkTitle}
              onChange={e => setPerkTitle(e.target.value)}
              data-testid="input-invite-perk-title"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="coop-invite-details">Details for staff (optional)</Label>
            <Textarea
              id="coop-invite-details"
              placeholder="Anything staff should know when honoring the perk"
              value={perkDescription}
              onChange={e => setPerkDescription(e.target.value)}
              data-testid="input-invite-perk-description"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="coop-invite-terms">Mutual reward terms</Label>
            <Textarea
              id="coop-invite-terms"
              placeholder='e.g. "Each business honors the perk for customers referred by the other"'
              value={mutualRewardTerms}
              onChange={e => setMutualRewardTerms(e.target.value)}
              data-testid="input-invite-mutual-terms"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="coop-invite-starts">Starts (optional)</Label>
              <Input
                id="coop-invite-starts"
                type="date"
                value={startsAt}
                onChange={e => setStartsAt(e.target.value)}
                data-testid="input-invite-perk-starts"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="coop-invite-ends">Ends (optional)</Label>
              <Input
                id="coop-invite-ends"
                type="date"
                value={endsAt}
                onChange={e => setEndsAt(e.target.value)}
                data-testid="input-invite-perk-ends"
              />
            </div>
          </div>
          {windowInvalid && (
            <p className="text-sm text-destructive" data-testid="text-invite-window-error">
              The end date must be after the start date.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            onClick={send}
            disabled={perkTitle.trim() === '' || windowInvalid || createInvite.isPending}
            className="gap-2"
            data-testid="button-send-partnership-invite"
          >
            <Send className="w-4 h-4" /> Send Partnership Invite
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Platform invites — invite off-platform businesses to join & partner ─────

function CopyRow({ label, value, testId }: { label: string; value: string; testId: string }) {
  const { toast } = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast({ title: 'Copied to clipboard' });
    } catch {
      toast({ title: 'Copy failed', description: 'Select and copy the text manually.', variant: 'destructive' });
    }
  };
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        <Button size="sm" variant="ghost" className="h-7 gap-1.5" onClick={copy} data-testid={`button-copy-${testId}`}>
          <Copy className="w-3.5 h-3.5" /> Copy
        </Button>
      </div>
      <div
        className="rounded-md border bg-muted/40 p-2 text-xs break-all whitespace-pre-wrap"
        data-testid={`text-${testId}`}
      >
        {value}
      </div>
    </div>
  );
}

function PlatformInviteDialog({
  initialName, onClose,
}: {
  initialName: string | null;
  onClose: () => void;
}) {
  const [businessName, setBusinessName] = useState('');
  const [contact, setContact] = useState('');
  const [created, setCreated] = useState<PlatformInvite | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createInvite = useCreatePlatformInvite();

  // Prefill from the failed search each time the dialog opens.
  const open = initialName != null;
  const nameValue = businessName || (initialName ?? '');

  const close = () => {
    setBusinessName('');
    setContact('');
    setCreated(null);
    onClose();
  };

  const generate = () => {
    createInvite.mutate(
      {
        data: {
          businessName: nameValue.trim(),
          ...(contact.trim() ? { contact: contact.trim() } : {}),
        },
      },
      {
        onSuccess: invite => {
          setCreated(invite);
          queryClient.invalidateQueries({ queryKey: getListPlatformInvitesQueryKey() });
        },
        onError: (err: unknown) => {
          const e = err as { data?: { message?: string }; message?: string };
          toast({
            title: 'Could not create the invite',
            description: e?.data?.message ?? e?.message ?? 'Please try again.',
            variant: 'destructive',
          });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) close(); }}>
      <DialogContent data-testid="dialog-platform-invite">
        <DialogHeader>
          <DialogTitle>Invite to Get Next In Line &amp; Partner</DialogTitle>
          <DialogDescription>
            {created
              ? 'Send them the link below — when they register through it, a partnership request from you is created automatically.'
              : 'Generate a unique trackable link and a ready-to-send message for a business that isn\u2019t on the platform yet.'}
          </DialogDescription>
        </DialogHeader>
        {created ? (
          <div className="space-y-4" data-testid="platform-invite-share-sheet">
            <CopyRow label="Invitation link" value={created.inviteUrl} testId="platform-invite-link" />
            <CopyRow label="SMS / email message" value={created.message} testId="platform-invite-message" />
            <p className="text-xs text-muted-foreground">
              You send this yourself — nothing is sent automatically. The link expires on{' '}
              {new Date(created.expiresAt).toLocaleDateString()}.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="platform-invite-name">Business name</Label>
              <Input
                id="platform-invite-name"
                value={nameValue}
                onChange={e => setBusinessName(e.target.value)}
                placeholder="e.g. Riverside Florist"
                data-testid="input-platform-invite-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="platform-invite-contact">Their phone or email (optional, for your own tracking)</Label>
              <Input
                id="platform-invite-contact"
                value={contact}
                onChange={e => setContact(e.target.value)}
                placeholder="e.g. (555) 010-1234"
                data-testid="input-platform-invite-contact"
              />
            </div>
          </div>
        )}
        <DialogFooter>
          {created ? (
            <Button onClick={close} data-testid="button-platform-invite-done">Done</Button>
          ) : (
            <Button
              onClick={generate}
              disabled={nameValue.trim() === '' || createInvite.isPending}
              className="gap-2"
              data-testid="button-generate-platform-invite"
            >
              <Link2 className="w-4 h-4" /> Generate Invitation Link
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const PLATFORM_INVITE_STATUS: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  sent: { label: 'Sent', variant: 'secondary' },
  clicked: { label: 'Clicked', variant: 'outline' },
  registered: { label: 'Registered', variant: 'default' },
  expired: { label: 'Expired', variant: 'destructive' },
};

function PlatformInvitesList() {
  const { data: invites } = useListPlatformInvites({
    query: { queryKey: getListPlatformInvitesQueryKey() },
  });
  if (!invites || invites.length === 0) return null;
  return (
    <Card data-testid="card-platform-invites">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <UserPlus className="w-4 h-4 text-muted-foreground" /> Platform Invites
        </CardTitle>
        <CardDescription>
          Off-platform businesses you invited to join Get Next In Line.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {invites.map(inv => {
          const s = PLATFORM_INVITE_STATUS[inv.status] ?? PLATFORM_INVITE_STATUS.sent;
          return (
            <div
              key={inv.id}
              className="border rounded-lg p-3 flex items-center justify-between gap-3"
              data-testid={`row-platform-invite-${inv.id}`}
            >
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{inv.invitedBusinessName}</div>
                {inv.invitedContact && (
                  <div className="text-xs text-muted-foreground truncate">{inv.invitedContact}</div>
                )}
              </div>
              <Badge variant={s.variant} className="shrink-0" data-testid={`badge-platform-invite-status-${inv.id}`}>
                {s.label}
              </Badge>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
