import React from 'react';
import { useGetSosReportsSummary } from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell
} from 'recharts';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/shared/StatCard';

/**
 * Reports & Analytics content — rendered as the "Reports" tab on the
 * Business Bookings page (the old standalone /sos/reports page redirects
 * there).
 */
export function ReportsContent() {
  const { data: summary, isLoading } = useGetSosReportsSummary();
  const automation = summary?.automation;

  const COLORS = ['hsl(var(--chart-1))', 'hsl(var(--chart-2))', 'hsl(var(--chart-3))', 'hsl(var(--chart-4))'];

  return (
    <div className="space-y-6" data-testid="reports-content">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Reports & Analytics</h2>
        <p className="text-muted-foreground text-sm mt-1">Business performance and AI efficiency metrics.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <StatCard title="Avg Wait Time" value={summary?.avgWaitMinutes ? `${summary.avgWaitMinutes}m` : '-'} loading={isLoading} />
        <StatCard title="Waitlist Slots Filled" value={summary?.slotsFilled} loading={isLoading} />
        <StatCard title="Waitlist Fill Rate" value={summary?.fillRate ? `${Math.round(summary.fillRate)}%` : '-'} loading={isLoading} />
        <StatCard title="Total Revenue" value={summary?.totalRevenue ? `$${summary.totalRevenue.toFixed(2)}` : '-'} loading={isLoading} />
      </div>

      {/* Tip pooling — collected at checkout vs distributed via the gratuity
          ledger. Kept separate from revenue: tips never inflate revenue. */}
      <div className="grid gap-6 md:grid-cols-3">
        <div className="grid gap-4 md:col-span-1 content-start">
          <StatCard title="Tips Collected" value={summary?.tips ? `$${summary.tips.collected.toFixed(2)}` : '-'} loading={isLoading} />
          <StatCard title="Tips Distributed" value={summary?.tips ? `$${summary.tips.distributed.toFixed(2)}` : '-'} loading={isLoading} />
        </div>
        <Card className="md:col-span-2" data-testid="card-tips-by-staff">
          <CardHeader>
            <CardTitle>Tips by Staff Member</CardTitle>
            <CardDescription>Pooled gratuities distributed this period — separate from commissions and service revenue.</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="w-full h-24" />
            ) : !summary?.tips || summary.tips.byStaff.length === 0 ? (
              <div className="text-sm text-muted-foreground text-center py-6">No tips distributed in this period.</div>
            ) : (
              <div className="space-y-2">
                {summary.tips.byStaff.map(s => (
                  <div key={s.staffId} className="flex items-center justify-between border-b last:border-0 pb-2 text-sm" data-testid={`tips-row-${s.staffId}`}>
                    <span className="font-medium">{s.name}</span>
                    <span className="font-semibold">${s.total.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="col-span-1">
          <CardHeader>
            <CardTitle>Visits by Day</CardTitle>
            <CardDescription>Customer volume over the past week</CardDescription>
          </CardHeader>
          <CardContent className="h-[300px]">
            {isLoading ? <Skeleton className="w-full h-full" /> : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={summary?.visitsByDay}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{fontSize: 12}} />
                  <YAxis axisLine={false} tickLine={false} tick={{fontSize: 12}} />
                  <Tooltip 
                    cursor={{fill: 'hsl(var(--muted))'}}
                    contentStyle={{borderRadius: '8px', border: '1px solid hsl(var(--border))'}}
                  />
                  <Bar dataKey="count" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card className="col-span-1">
          <CardHeader>
            <CardTitle>AI Call Outcomes</CardTitle>
            <CardDescription>How the receptionist handled inbound calls</CardDescription>
          </CardHeader>
          <CardContent className="h-[300px] flex items-center justify-center">
            {isLoading ? <Skeleton className="w-full h-full" /> : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={summary?.callOutcomes}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={90}
                    paddingAngle={5}
                    dataKey="count"
                    nameKey="outcome"
                    label={({ name, percent }) => `${name.replace('_', ' ')} (${(percent * 100).toFixed(0)}%)`}
                    labelLine={false}
                  >
                    {summary?.callOutcomes.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <div>
        <h2 className="text-xl font-semibold tracking-tight">Automation</h2>
        <p className="text-muted-foreground text-sm mt-1">Concierge reminders, rebooking nudges, and delivery outcomes over the past two weeks.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <StatCard title="Reminders Sent" value={automation?.remindersSent} loading={isLoading} />
        <StatCard title="Rebooking Nudges Sent" value={automation?.nudgesSent} loading={isLoading} />
        <StatCard title="Failed Messages" value={automation?.failedCount} loading={isLoading} />
        <StatCard title="Skipped Messages" value={automation?.skippedCount} loading={isLoading} />
      </div>

      <Card data-testid="card-failure-reasons">
        <CardHeader>
          <CardTitle>Why Messages Failed or Were Skipped</CardTitle>
          <CardDescription>Breakdown of failed and skipped automated messages over the past two weeks — fix the underlying cause, not just the count.</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="w-full h-24" />
          ) : !automation || automation.failureReasons.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-6">No failed or skipped messages in the past two weeks.</div>
          ) : (
            <div className="space-y-2">
              {automation.failureReasons.map((r, i) => (
                <div key={`${r.status}-${r.errorCode ?? 'none'}-${i}`} className="flex items-center justify-between border-b last:border-0 pb-2 text-sm" data-testid={`failure-reason-${r.status}-${r.errorCode ?? 'none'}`}>
                  <div className="flex items-center gap-2">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${r.status === 'failed' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'}`}>
                      {r.status === 'failed' ? 'Failed' : 'Skipped'}
                    </span>
                    <span className="font-medium">{r.label}</span>
                  </div>
                  <span className="font-semibold">{r.count}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="col-span-1">
          <CardHeader>
            <CardTitle>Messages by Day</CardTitle>
            <CardDescription>Automated messages over the past two weeks</CardDescription>
          </CardHeader>
          <CardContent className="h-[300px]">
            {isLoading ? <Skeleton className="w-full h-full" /> : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={automation?.messagesByDay}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{fontSize: 12}} />
                  <YAxis axisLine={false} tickLine={false} tick={{fontSize: 12}} allowDecimals={false} />
                  <Tooltip
                    cursor={{fill: 'hsl(var(--muted))'}}
                    contentStyle={{borderRadius: '8px', border: '1px solid hsl(var(--border))'}}
                  />
                  <Bar dataKey="count" fill="hsl(var(--chart-2))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card className="col-span-1">
          <CardHeader>
            <CardTitle>Delivery by Job Type</CardTitle>
            <CardDescription>Delivered, failed, and skipped counts per automation job</CardDescription>
          </CardHeader>
          <CardContent className="h-[300px]">
            {isLoading ? <Skeleton className="w-full h-full" /> : (
              automation && automation.byJobType.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={automation.byJobType.map((j) => ({ ...j, jobType: j.jobType.replace(/_/g, ' ') }))}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="jobType" axisLine={false} tickLine={false} tick={{fontSize: 12}} />
                    <YAxis axisLine={false} tickLine={false} tick={{fontSize: 12}} allowDecimals={false} />
                    <Tooltip
                      cursor={{fill: 'hsl(var(--muted))'}}
                      contentStyle={{borderRadius: '8px', border: '1px solid hsl(var(--border))'}}
                    />
                    <Bar dataKey="delivered" name="Delivered" stackId="s" fill="hsl(var(--chart-2))" />
                    <Bar dataKey="failed" name="Failed" stackId="s" fill="hsl(var(--destructive))" />
                    <Bar dataKey="skipped" name="Skipped" stackId="s" fill="hsl(var(--chart-4))" />
                    <Bar dataKey="pending" name="Pending" stackId="s" fill="hsl(var(--muted-foreground))" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                  No automated messages in the past two weeks.
                </div>
              )
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
