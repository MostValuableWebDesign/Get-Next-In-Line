import React from 'react';
import { useGetSosReportsSummary } from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell
} from 'recharts';
import { Skeleton } from '@/components/ui/skeleton';

export function ReportsPage() {
  const { data: summary, isLoading } = useGetSosReportsSummary();
  const automation = summary?.automation;

  const COLORS = ['hsl(var(--chart-1))', 'hsl(var(--chart-2))', 'hsl(var(--chart-3))', 'hsl(var(--chart-4))'];

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Reports & Analytics</h1>
        <p className="text-muted-foreground text-sm mt-1">Business performance and AI efficiency metrics.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <MetricCard title="Avg Wait Time" value={summary?.avgWaitMinutes ? `${summary.avgWaitMinutes}m` : '-'} loading={isLoading} />
        <MetricCard title="Waitlist Slots Filled" value={summary?.slotsFilled} loading={isLoading} />
        <MetricCard title="Waitlist Fill Rate" value={summary?.fillRate ? `${Math.round(summary.fillRate)}%` : '-'} loading={isLoading} />
        <MetricCard title="Total Revenue" value={summary?.totalRevenue ? `$${summary.totalRevenue.toFixed(2)}` : '-'} loading={isLoading} />
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
        <MetricCard title="Reminders Sent" value={automation?.remindersSent} loading={isLoading} />
        <MetricCard title="Rebooking Nudges Sent" value={automation?.nudgesSent} loading={isLoading} />
        <MetricCard title="Failed Messages" value={automation?.failedCount} loading={isLoading} />
        <MetricCard title="Skipped Messages" value={automation?.skippedCount} loading={isLoading} />
      </div>

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

function MetricCard({ title, value, loading }: any) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? <Skeleton className="h-8 w-20" /> : <div className="text-3xl font-bold">{value ?? 0}</div>}
      </CardContent>
    </Card>
  );
}
