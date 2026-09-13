import { useState, type ReactNode } from 'react';
import {
  useGetCoopSentimentSummary, getGetCoopSentimentSummaryQueryKey,
  useListCoopSentimentReports, getListCoopSentimentReportsQueryKey,
  type CoopSentimentReport, type CoopPartnershipSentiment,
} from '@workspace/api-client-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Heart, Star, MessageSquare, ThumbsUp, ThumbsDown, Sparkles, AlertTriangle,
  FileBarChart2, Repeat,
} from 'lucide-react';

/**
 * Co-Op Sentiment — merchant-facing cross-network customer feedback analytics.
 * After each co-op perk redemption the customer gets an SMS asking for a 1-5
 * rating, a Y/N "would you recommend", and comments; this view aggregates
 * those responses per accepted partnership and network-wide, highlights
 * trending themes, and lists the automated weekly/monthly insight reports.
 * All data is tenant-scoped server-side (business context resolves automatically
 * for /api/coop/ URLs).
 */
export function CoopSentimentContent({ tenantId }: { tenantId: number | null }) {
  if (tenantId == null) {
    return (
      <Card data-testid="card-sentiment-pick-business">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Co-op sentiment is unavailable until the app business configuration is complete.
        </CardContent>
      </Card>
    );
  }
  return <CoopSentimentInner key={tenantId} />;
}

function StatCard({ icon, label, value, sub, testId }: {
  icon: ReactNode; label: string; value: string; sub?: string; testId: string;
}) {
  return (
    <div className="border rounded-lg p-4" data-testid={testId}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">{icon} {label}</div>
      <div className="text-2xl font-bold tabular-nums mt-1">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

function fmtRating(r: number | null): string {
  return r == null ? '—' : `${r.toFixed(1)}/5`;
}
function fmtNps(n: number | null): string {
  return n == null ? '—' : `${n > 0 ? '+' : ''}${n}`;
}
function fmtRepeat(r: number | null): string {
  return r == null ? '—' : `${Math.round(r * 100)}%`;
}

function CoopSentimentInner() {
  const { data: summary, isLoading } = useGetCoopSentimentSummary({
    query: { queryKey: getGetCoopSentimentSummaryQueryKey() },
  });

  return (
    <div className="space-y-6" data-testid="coop-sentiment-view">
      <Card data-testid="card-sentiment-network">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Heart className="w-4 h-4 text-primary" /> Network Sentiment
          </CardTitle>
          <CardDescription>
            Post-redemption customer feedback across every accepted partnership you participate in —
            collected automatically by SMS after each perk redemption.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading || !summary ? (
            <Skeleton className="h-24 w-full rounded-lg" />
          ) : (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <StatCard icon={<Star className="w-3.5 h-3.5" />} label="Average rating"
                value={fmtRating(summary.networkAvgRating)} testId="stat-sentiment-rating" />
              <StatCard icon={<ThumbsUp className="w-3.5 h-3.5" />} label="Network NPS"
                value={fmtNps(summary.networkNps)} sub="would-recommend score" testId="stat-sentiment-nps" />
              <StatCard icon={<MessageSquare className="w-3.5 h-3.5" />} label="Responses"
                value={String(summary.totalResponses)} testId="stat-sentiment-responses" />
              <StatCard icon={<ThumbsDown className="w-3.5 h-3.5" />} label="Sentiment mix"
                value={`${summary.positive}/${summary.neutral}/${summary.negative}`}
                sub="positive / neutral / negative" testId="stat-sentiment-mix" />
            </div>
          )}

          {summary && (summary.praiseThemes.length > 0 || summary.frictionThemes.length > 0) && (
            <div className="grid sm:grid-cols-2 gap-3 mt-4">
              <div className="border rounded-lg p-4" data-testid="block-praise-themes">
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
                  <Sparkles className="w-3.5 h-3.5" /> Recurring praise
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {summary.praiseThemes.length === 0
                    ? <span className="text-sm text-muted-foreground">None yet</span>
                    : summary.praiseThemes.map(t => (
                        <Badge key={t} variant="secondary" data-testid={`badge-praise-${t}`}>{t}</Badge>
                      ))}
                </div>
              </div>
              <div className="border rounded-lg p-4" data-testid="block-friction-themes">
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
                  <AlertTriangle className="w-3.5 h-3.5" /> Emerging friction
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {summary.frictionThemes.length === 0
                    ? <span className="text-sm text-muted-foreground">None detected</span>
                    : summary.frictionThemes.map(t => (
                        <Badge key={t} variant="outline" data-testid={`badge-friction-${t}`}>{t}</Badge>
                      ))}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-sentiment-partnerships">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Sentiment by Partnership</CardTitle>
          <CardDescription>
            How customers rate each pairing — plus how often they come back (repeat-visit rate from
            perk redemption history).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading || !summary ? (
            <Skeleton className="h-24 w-full rounded-lg" />
          ) : summary.partnerships.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="text-no-sentiment-partnerships">
              No accepted partnerships yet — sentiment tracking starts once you're in an active co-op pairing.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Partner</TableHead>
                  <TableHead>Perk</TableHead>
                  <TableHead className="text-right">Responses</TableHead>
                  <TableHead className="text-right">Avg rating</TableHead>
                  <TableHead className="text-right">NPS</TableHead>
                  <TableHead className="text-right"><span className="inline-flex items-center gap-1"><Repeat className="w-3 h-3" /> Repeat rate</span></TableHead>
                  <TableHead className="text-right">+ / = / −</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.partnerships.map((p: CoopPartnershipSentiment) => (
                  <TableRow key={p.partnershipId} data-testid={`row-sentiment-${p.partnershipId}`}>
                    <TableCell className="font-medium">{p.partnerName}</TableCell>
                    <TableCell className="text-muted-foreground max-w-56 truncate">{p.perkTitle}</TableCell>
                    <TableCell className="text-right tabular-nums">{p.responses}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtRating(p.avgRating)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNps(p.nps)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtRepeat(p.repeatVisitRate)}</TableCell>
                    <TableCell className="text-right tabular-nums">{p.positive} / {p.neutral} / {p.negative}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <SentimentReports />
    </div>
  );
}

function reportLabel(r: CoopSentimentReport): string {
  if (r.periodType === 'monthly') {
    return new Date(`${r.periodKey}-01T00:00:00Z`).toLocaleString('en-US', {
      month: 'long', year: 'numeric', timeZone: 'UTC',
    });
  }
  return `Week ${r.periodKey.split('-W')[1] ?? r.periodKey} · ${r.periodKey.slice(0, 4)}`;
}

function SentimentReports() {
  const { data: reports, isLoading } = useListCoopSentimentReports({
    query: { queryKey: getListCoopSentimentReportsQueryKey() },
  });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const report = (reports ?? []).find(r => r.id === selectedId) ?? (reports ?? [])[0];

  return (
    <Card data-testid="card-sentiment-reports">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <FileBarChart2 className="w-4 h-4 text-primary" /> Insight Reports
            </CardTitle>
            <CardDescription>
              Automated weekly and monthly rankings of your partnerships by satisfaction and
              repeat-visit rate, with plain-language recommendations.
            </CardDescription>
          </div>
          {(reports ?? []).length > 0 && (
            <Select value={report ? String(report.id) : ''} onValueChange={v => setSelectedId(Number(v))}>
              <SelectTrigger className="w-60" data-testid="select-sentiment-report">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(reports ?? []).map(r => (
                  <SelectItem key={r.id} value={String(r.id)}>
                    {r.periodType === 'weekly' ? 'Weekly' : 'Monthly'} — {reportLabel(r)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-24 w-full rounded-lg" />
        ) : !report ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-sentiment-reports">
            No insight reports yet — your first report is generated automatically after the first
            week or month with customer feedback.
          </p>
        ) : (
          <div data-testid={`sentiment-report-${report.periodType}-${report.periodKey}`}>
            <p className="text-sm leading-relaxed" data-testid="text-report-summary">{report.summary}</p>
            {report.rankings.length > 0 && (
              <Table className="mt-4">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">#</TableHead>
                    <TableHead>Partner</TableHead>
                    <TableHead className="text-right">Responses</TableHead>
                    <TableHead className="text-right">Avg rating</TableHead>
                    <TableHead className="text-right">NPS</TableHead>
                    <TableHead className="text-right">Repeat rate</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.rankings.map((r, i) => (
                    <TableRow key={r.partnershipId} data-testid={`row-report-rank-${i + 1}`}>
                      <TableCell className="tabular-nums text-muted-foreground">{i + 1}</TableCell>
                      <TableCell className="font-medium">{r.partnerName}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.responses}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtRating(r.avgRating)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNps(r.nps)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtRepeat(r.repeatVisitRate)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
