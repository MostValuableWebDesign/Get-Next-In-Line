import React from 'react';
import { useLocation } from 'wouter';
import { useGetSosDashboard, useListSosMessages, useListSosCalls } from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { 
  Users, Activity, Clock, Calendar, 
  MessageSquare, Phone, DollarSign, ListOrdered, CheckCircle2, UserCheck
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';

export function DashboardPage() {
  const { data: dashboard, isLoading: isLoadingDash } = useGetSosDashboard();
  const { data: messages, isLoading: isLoadingMsgs } = useListSosMessages({ limit: 5 });
  const { data: calls, isLoading: isLoadingCalls } = useListSosCalls();

  const recentCalls = calls?.slice(0, 5) || [];
  const [, navigate] = useLocation();
  const openTimeline = (customerId: number | null | undefined) => {
    if (customerId != null) navigate(`/sos/customers?customer=${customerId}`);
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Command Center</h1>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></span>
          Live updating
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <KpiCard 
          title="In Service" 
          value={dashboard?.inService} 
          icon={Activity} 
          isLoading={isLoadingDash} 
        />
        <KpiCard 
          title="In Queue" 
          value={dashboard?.inQueue} 
          icon={Users} 
          isLoading={isLoadingDash} 
        />
        <KpiCard 
          title="Avg Wait" 
          value={dashboard?.avgWaitMinutes ? `${dashboard.avgWaitMinutes}m` : '0m'} 
          icon={Clock} 
          isLoading={isLoadingDash} 
        />
        <KpiCard 
          title="Waitlist" 
          value={dashboard?.waitlistWaiting} 
          icon={ListOrdered} 
          isLoading={isLoadingDash} 
        />
        <KpiCard 
          title="Resources" 
          value={dashboard ? `${dashboard.availableResources}/${dashboard.totalResources}` : '-'} 
          icon={CheckCircle2} 
          isLoading={isLoadingDash} 
        />
        <KpiCard 
          title="Appointments" 
          value={dashboard?.appointmentsToday} 
          icon={Calendar} 
          isLoading={isLoadingDash} 
        />
        <KpiCard 
          title="AI Calls" 
          value={dashboard?.callsHandledToday} 
          icon={Phone} 
          isLoading={isLoadingDash} 
        />
        <KpiCard 
          title="Revenue Today" 
          value={dashboard?.revenueToday ? `$${dashboard.revenueToday.toFixed(2)}` : '$0.00'} 
          icon={DollarSign} 
          isLoading={isLoadingDash} 
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <MessageSquare className="h-4 w-4" />
              Recent AI & SMS Activity
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {isLoadingMsgs ? (
              <div className="space-y-2"><Skeleton className="h-10 w-full"/><Skeleton className="h-10 w-full"/></div>
            ) : messages?.length === 0 ? (
              <div className="text-sm text-muted-foreground text-center py-4">No messages today</div>
            ) : (
              messages?.map(msg => (
                <div
                  key={msg.id}
                  className={`flex justify-between items-center text-sm p-2 rounded bg-muted/30 ${msg.customerId != null ? 'cursor-pointer hover:bg-muted/60 transition-colors' : ''}`}
                  onClick={() => openTimeline(msg.customerId)}
                  title={msg.customerId != null ? 'View customer timeline' : undefined}
                >
                  <div className="truncate pr-4 flex-1">
                    <span className="font-medium mr-2">{msg.customerName || msg.toNumber}</span>
                    <span className="text-muted-foreground">{msg.body}</span>
                  </div>
                  <div className="text-xs shrink-0 capitalize px-2 py-1 bg-secondary rounded text-secondary-foreground">
                    {msg.kind.replace('_', ' ')}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Phone className="h-4 w-4" />
              Recent AI Calls
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {isLoadingCalls ? (
              <div className="space-y-2"><Skeleton className="h-10 w-full"/><Skeleton className="h-10 w-full"/></div>
            ) : recentCalls.length === 0 ? (
              <div className="text-sm text-muted-foreground text-center py-4">No calls today</div>
            ) : (
              recentCalls.map(call => (
                <div
                  key={call.id}
                  className={`flex flex-col text-sm p-3 rounded bg-muted/30 gap-1 ${call.customerId != null ? 'cursor-pointer hover:bg-muted/60 transition-colors' : ''}`}
                  onClick={() => openTimeline(call.customerId)}
                  title={call.customerId != null ? 'View customer timeline' : undefined}
                >
                  <div className="flex justify-between items-center">
                    <span className="font-medium">{call.callerName || call.fromNumber}</span>
                    <Badge variant={call.outcome === 'booked' ? 'default' : 'secondary'} className="capitalize">
                      {call.outcome.replace('_', ' ')}
                    </Badge>
                  </div>
                  <div className="text-muted-foreground text-xs line-clamp-1">{call.intent}</div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function KpiCard({ title, value, icon: Icon, isLoading }: any) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-8 w-20" />
        ) : (
          <div className="text-2xl font-bold">{value !== undefined ? value : '-'}</div>
        )}
      </CardContent>
    </Card>
  );
}

function Badge({ children, variant = 'default', className = '' }: any) {
  const base = "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2";
  const variants = {
    default: "border-transparent bg-primary text-primary-foreground",
    secondary: "border-transparent bg-secondary text-secondary-foreground",
  };
  return <div className={`${base} ${variants[variant as keyof typeof variants]} ${className}`}>{children}</div>;
}
