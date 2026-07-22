import React, { useMemo, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import {
  useListSosAppointments, getListSosAppointmentsQueryKey,
  useListSosVisits, useMarkSosAppointmentNoShow, useCancelSosAppointment,
  useGetSosDashboard,
  type SosAppointment,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BookAppointmentDialog } from '@/components/sos/book-appointment-dialog';
import { OpenTicketsPanel } from '@/components/sos/open-tickets-panel';
import { ReportsContent } from '@/pages/sos/reports';
import {
  Calendar as CalIcon, ArrowRight, Receipt, Clock, History, List as ListIcon,
  Users, BarChart3, ShieldCheck, UserX, Crown, X, Bot, User, UserPlus,
  Activity, ListOrdered, CheckCircle2, Phone, DollarSign,
} from 'lucide-react';

/**
 * Business Bookings — the single hub for booking/transactional workflows.
 * List and Calendar views of appointments (the old standalone Calendar page
 * redirects here), plus the one place open tickets are checked out.
 */
const BOOKINGS_TABS = ['list', 'calendar', 'reports'] as const;

export function BookingsPage() {
  // Tab state lives in the URL (?tab=) so /sos/bookings?tab=reports deep
  // links — including the redirect from the old /sos/reports page — work.
  const searchString = useSearch();
  const [, setLocation] = useLocation();
  const rawTab = new URLSearchParams(searchString).get('tab');
  const activeTab = (BOOKINGS_TABS as readonly string[]).includes(rawTab ?? '') ? rawTab! : 'list';

  const { data: appointments, isLoading: isLoadingAppointments } = useListSosAppointments({});
  const { data: visits, isLoading: isLoadingVisits } = useListSosVisits({ active: true });
  const { data: dashboard, isLoading: isLoadingDash } = useGetSosDashboard();

  const now = Date.now();
  const { upcoming, past } = useMemo(() => {
    const all = appointments ?? [];
    return {
      upcoming: all.filter(a => new Date(a.startsAt).getTime() >= now && a.status !== 'cancelled' && a.status !== 'no_show'),
      past: all.filter(a => new Date(a.startsAt).getTime() < now || a.status === 'cancelled' || a.status === 'no_show'),
    };
  }, [appointments, now]);

  const inService = visits?.filter(v => v.status === 'in_service') || [];
  const openTickets = visits?.filter(v => v.status === 'payment') || [];

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Business Bookings</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Appointments and checkout activity in one place.
          </p>
        </div>
        <BookAppointmentDialog />
      </div>

      {/* Live business KPIs — folded in from the retired standalone SOS Dashboard */}
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4" data-testid="grid-sos-kpis">
        <KpiStat title="In Service" value={dashboard?.inService} icon={Activity} isLoading={isLoadingDash} />
        <KpiStat title="In Queue" value={dashboard?.inQueue} icon={Users} isLoading={isLoadingDash} />
        <KpiStat
          title="Avg Wait"
          value={dashboard?.avgWaitMinutes ? `${dashboard.avgWaitMinutes}m` : '0m'}
          icon={Clock}
          isLoading={isLoadingDash}
        />
        <KpiStat title="Waitlist" value={dashboard?.waitlistWaiting} icon={ListOrdered} isLoading={isLoadingDash} />
        <KpiStat
          title="Resources"
          value={dashboard ? `${dashboard.availableResources}/${dashboard.totalResources}` : '-'}
          icon={CheckCircle2}
          isLoading={isLoadingDash}
        />
        <KpiStat title="Appointments" value={dashboard?.appointmentsToday} icon={CalIcon} isLoading={isLoadingDash} />
        <KpiStat title="AI Calls" value={dashboard?.callsHandledToday} icon={Phone} isLoading={isLoadingDash} />
        <KpiStat
          title="Revenue Today"
          value={dashboard?.revenueToday ? `$${dashboard.revenueToday.toFixed(2)}` : '$0.00'}
          icon={DollarSign}
          isLoading={isLoadingDash}
        />
      </div>

      {/* Jump links to the other operational views */}
      <div className="grid sm:grid-cols-2 gap-4">
        <JumpLinkCard
          href="/sos/customers"
          icon={Users}
          title="Customers"
          description="Manage client records, preferences, and timelines"
        />
        <JumpLinkCard
          href="/sos/customers?tab=plans"
          icon={Crown}
          title="Membership Plans"
          description="Manage plans, packages, and loyalty credit passes (in Customers)"
        />
      </div>

      {/* Appointments — list / calendar views, plus Reports (the old
          standalone /sos/reports page, now a tab here) */}
      <Tabs
        value={activeTab}
        onValueChange={(tab) => {
          // Keep the URL in sync so refresh/back and deep links stay correct
          setLocation(tab === 'list' ? '/sos/bookings' : `/sos/bookings?tab=${tab}`, { replace: true });
        }}
        className="space-y-4"
      >
        <TabsList data-testid="tabs-bookings-view">
          <TabsTrigger value="list" data-testid="tab-list-view">
            <ListIcon className="h-4 w-4 mr-1.5" /> List
          </TabsTrigger>
          <TabsTrigger value="calendar" data-testid="tab-calendar-view">
            <CalIcon className="h-4 w-4 mr-1.5" /> Calendar
          </TabsTrigger>
          <TabsTrigger value="reports" data-testid="tab-reports">
            <BarChart3 className="h-4 w-4 mr-1.5" /> Reports
          </TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="mt-0">
          <div className="grid lg:grid-cols-2 gap-6 items-start">
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <CalIcon className="h-4 w-4 text-primary" /> Upcoming Appointments
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {isLoadingAppointments ? (
                    <div className="space-y-2"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>
                  ) : upcoming.length === 0 ? (
                    <div className="text-sm text-muted-foreground text-center py-6">No upcoming appointments.</div>
                  ) : (
                    upcoming.map(apt => <AppointmentLine key={apt.id} apt={apt} />)
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base text-muted-foreground">
                    <History className="h-4 w-4" /> Past & Cancelled
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {isLoadingAppointments ? (
                    <Skeleton className="h-14 w-full" />
                  ) : past.length === 0 ? (
                    <div className="text-sm text-muted-foreground text-center py-6">No past appointments.</div>
                  ) : (
                    past.slice(0, 8).map(apt => <AppointmentLine key={apt.id} apt={apt} muted />)
                  )}
                </CardContent>
              </Card>
            </div>
            <TicketsColumn isLoadingVisits={isLoadingVisits} openTickets={openTickets} inService={inService} />
          </div>
        </TabsContent>

        <TabsContent value="calendar" className="mt-0">
          <div className="grid lg:grid-cols-2 gap-6 items-start">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <CalIcon className="h-4 w-4 text-primary" /> Schedule
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {isLoadingAppointments ? (
                  <div className="space-y-2"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div>
                ) : (appointments?.length ?? 0) === 0 ? (
                  <div className="text-center py-12 text-muted-foreground">No upcoming appointments.</div>
                ) : (
                  appointments!.map(apt => <CalendarAppointmentRow key={apt.id} apt={apt} />)
                )}
              </CardContent>
            </Card>
            <TicketsColumn isLoadingVisits={isLoadingVisits} openTickets={openTickets} inService={inService} />
          </div>
        </TabsContent>

        <TabsContent value="reports" className="mt-0">
          <ReportsContent />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Transactional (tickets) column shown next to the List and Calendar views. */
function TicketsColumn({
  isLoadingVisits, openTickets, inService,
}: {
  isLoadingVisits: boolean;
  openTickets: { id: number }[];
  inService: { id: number; customerName: string; serviceType: string }[];
}) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold flex items-center gap-2 mb-3">
          <Receipt className="h-4 w-4 text-primary" /> Awaiting Payment
          {!isLoadingVisits && openTickets.length > 0 && (
            <Badge variant="secondary" data-testid="badge-awaiting-payment-count">
              {openTickets.length} open ticket{openTickets.length === 1 ? '' : 's'}
            </Badge>
          )}
        </h2>
        {isLoadingVisits ? <Skeleton className="h-32 w-full" /> : <OpenTicketsPanel />}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base text-muted-foreground">
            <Clock className="h-4 w-4" /> In Service
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoadingVisits ? (
            <Skeleton className="h-14 w-full" />
          ) : inService.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-6">No active services.</div>
          ) : (
            inService.map(v => (
              <div key={v.id} className="flex items-center justify-between p-3 border rounded-lg bg-card/50">
                <div className="min-w-0">
                  <div className="font-medium truncate">{v.customerName}</div>
                  <div className="text-xs text-muted-foreground truncate">{v.serviceType}</div>
                </div>
                <span className="text-xs uppercase font-bold tracking-wide text-muted-foreground">In Service</span>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function KpiStat({
  title, value, icon: Icon, isLoading,
}: {
  title: string;
  value: string | number | undefined;
  icon: React.ComponentType<{ className?: string }>;
  isLoading: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
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

function JumpLinkCard({
  href, icon: Icon, title, description,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
}) {
  return (
    <Link href={href} className="group">
      <Card className="hover:border-primary/40 transition-colors cursor-pointer h-full">
        <CardContent className="p-4 flex items-center gap-3">
          <Icon className="h-5 w-5 text-primary shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-semibold">{title}</div>
            <div className="text-xs text-muted-foreground">{description}</div>
          </div>
          <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
        </CardContent>
      </Card>
    </Link>
  );
}

const DEPOSIT_BADGE_STYLES: Record<string, string> = {
  held: 'border-sky-500/40 text-sky-600 bg-sky-500/5',
  released: 'border-emerald-500/40 text-emerald-600 bg-emerald-500/5',
  captured: 'border-amber-500/40 text-amber-600 bg-amber-500/5',
};

function DepositBadge({ deposit }: { deposit: NonNullable<SosAppointment['deposit']> }) {
  const label =
    deposit.status === 'held'
      ? `$${deposit.depositAmount.toFixed(2)} held`
      : deposit.status === 'released'
        ? 'Deposit released'
        : `$${deposit.feeAmount.toFixed(2)} fee captured`;
  return (
    <Badge
      variant="outline"
      className={`text-[10px] shrink-0 gap-1 ${DEPOSIT_BADGE_STYLES[deposit.status] ?? ''}`}
      title={deposit.outcomeReason ?? undefined}
      data-testid="badge-deposit-status"
    >
      <ShieldCheck className="h-3 w-3" /> {label}
    </Badge>
  );
}

function AppointmentLine({ apt, muted = false }: { apt: SosAppointment; muted?: boolean }) {
  const dStart = new Date(apt.startsAt);
  const dEnd = new Date(apt.endsAt);
  const markNoShow = useMarkSosAppointmentNoShow();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleNoShow = () => {
    markNoShow.mutate(
      { id: apt.id },
      {
        onSuccess: (updated) => {
          queryClient.invalidateQueries({ queryKey: getListSosAppointmentsQueryKey({}) });
          toast({
            title: 'Marked as no-show',
            description: updated.deposit?.outcomeReason ?? 'No deposit was held for this appointment.',
          });
        },
        onError: () => {
          toast({ title: "Couldn't mark no-show", description: 'Please try again.', variant: 'destructive' });
        },
      },
    );
  };

  return (
    <div className={`p-3 border rounded-lg space-y-2 ${muted ? 'opacity-70' : ''}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4 min-w-0">
          <div className="flex flex-col text-center w-14 shrink-0 border-r pr-4">
            <span className="text-[10px] uppercase font-bold text-muted-foreground">
              {dStart.toLocaleDateString([], { weekday: 'short' })}
            </span>
            <span className="text-lg font-bold leading-tight">{dStart.getDate()}</span>
          </div>
          <div className="min-w-0">
            <div className="font-medium truncate">{apt.customerName}</div>
            <div className="text-xs text-muted-foreground truncate">
              {apt.serviceType} • {dStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – {dEnd.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {apt.status === 'booked' && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-amber-600"
              onClick={handleNoShow}
              disabled={markNoShow.isPending}
              data-testid={`button-mark-no-show-${apt.id}`}
            >
              <UserX className="h-3.5 w-3.5 mr-1" /> No-show
            </Button>
          )}
          <Badge variant="outline" className="text-[10px] capitalize shrink-0">
            {apt.status === 'no_show' ? 'no-show' : apt.status}
          </Badge>
        </div>
      </div>
      {apt.deposit && (
        <div className="flex items-center gap-2 pl-[4.5rem]">
          <DepositBadge deposit={apt.deposit} />
          {apt.deposit.outcomeReason && (
            <span className="text-[11px] text-muted-foreground truncate" data-testid="text-deposit-reason">
              {apt.deposit.outcomeReason}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Calendar-view row — detailed schedule entry with source badge and cancellation (from the old Calendar page). */
function CalendarAppointmentRow({ apt }: { apt: SosAppointment }) {
  const [open, setOpen] = useState(false);
  const cancel = useCancelSosAppointment();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleCancel = () => {
    cancel.mutate(
      { id: apt.id },
      {
        onSuccess: (res: any) => {
          queryClient.invalidateQueries({ queryKey: getListSosAppointmentsQueryKey({}) });
          setOpen(false);
          toast({
            title: 'Appointment Cancelled',
            description: `Slot broadcast to ${res.waitlistNotified} waitlisted clients via SMS (${res.messagesSent} messages sent).`,
            variant: 'default',
          });
        },
      },
    );
  };

  const sources: Record<string, { icon: any, label: string, color: string }> = {
    staff: { icon: User, label: 'Staff', color: 'bg-blue-100 text-blue-800' },
    ai_receptionist: { icon: Bot, label: 'AI Receptionist', color: 'bg-purple-100 text-purple-800' },
    waitlist_fill: { icon: UserPlus, label: 'Waitlist Fill', color: 'bg-emerald-100 text-emerald-800' },
    self_book: { icon: CalIcon, label: 'Self Book', color: 'bg-gray-100 text-gray-800' },
  };
  const source = sources[apt.source] || sources.staff;
  const SourceIcon = source.icon;

  const dStart = new Date(apt.startsAt);
  const dEnd = new Date(apt.endsAt);

  return (
    <div className="flex items-center justify-between p-4 border rounded-lg hover:border-primary/30 transition-colors">
      <div className="flex items-center gap-6">
        <div className="flex flex-col text-center w-20 border-r pr-6">
          <span className="text-xs uppercase font-bold text-muted-foreground">{dStart.toLocaleDateString([], { weekday: 'short' })}</span>
          <span className="text-2xl font-bold">{dStart.getDate()}</span>
          <span className="text-xs text-muted-foreground">{dStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        <div>
          <div className="font-semibold text-lg">{apt.customerName}</div>
          <div className="text-sm text-muted-foreground">{apt.serviceType} • {dStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - {dEnd.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
          <div className="mt-2 flex items-center gap-2">
            <Badge variant="secondary" className={`${source.color} border-transparent text-[10px]`}>
              <SourceIcon className="w-3 h-3 mr-1" /> {source.label}
            </Badge>
            <Badge variant="outline" className="text-[10px]">{apt.status}</Badge>
          </div>
        </div>
      </div>

      {apt.status === 'booked' && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button variant="ghost" className="text-destructive hover:bg-destructive/10 hover:text-destructive">
              <X className="w-4 h-4 mr-2" /> Cancel
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Cancel Appointment?</DialogTitle>
              <DialogDescription>
                If there are matching clients on the waitlist, the AI will automatically broadcast this open slot to them via SMS.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Keep Appointment</Button>
              <Button variant="destructive" onClick={handleCancel}>Confirm Cancellation</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
