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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BookAppointmentDialog } from '@/components/sos/book-appointment-dialog';
import { OpenTicketsPanel } from '@/components/sos/open-tickets-panel';
import { ReportsContent } from '@/pages/sos/reports';
import { CustomersContent } from '@/components/sos/customers-content';
import { MembershipPlansContent } from '@/pages/sos/memberships';
import { AiReceptionistPage } from '@/pages/sos/ai-receptionist';
import {
  Calendar as CalIcon, ArrowRight, Receipt, Clock, History, List as ListIcon,
  Users, BarChart3, ShieldCheck, UserX, Crown, X, Bot, User, UserPlus,
  Activity, ListOrdered, CheckCircle2, Phone, DollarSign,
  ChevronLeft, ChevronRight,
} from 'lucide-react';

/**
 * Business Bookings — the single hub for booking/transactional workflows.
 * List and Calendar views of appointments (the old standalone Calendar page
 * redirects here), plus the one place open tickets are checked out.
 */
const BOOKINGS_TABS = ['list', 'calendar', 'reports', 'customers', 'plans', 'ai-receptionist'] as const;

export function BookingsPage() {
  // Tab state lives in the URL (?tab=) so /sos/bookings?tab=reports deep
  // links — including the redirects from the old /sos/reports,
  // /sos/customers, and /sos/memberships pages — work.
  const searchString = useSearch();
  const [, setLocation] = useLocation();
  const rawTab = new URLSearchParams(searchString).get('tab');
  const activeTab = (BOOKINGS_TABS as readonly string[]).includes(rawTab ?? '') ? rawTab! : 'list';

  // Deep links from the dashboard / old Customers page:
  // /sos/bookings?tab=customers&customer=<id> auto-opens the detail dialog.
  const initialCustomerId = React.useMemo(() => {
    const raw = new URLSearchParams(searchString).get('customer');
    const n = raw ? Number(raw) : NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

      {/* Jump links to the other tabs on this page */}
      <div className="grid sm:grid-cols-2 gap-4">
        <JumpLinkCard
          href="/sos/bookings?tab=customers"
          icon={Users}
          title="Customers"
          description="Manage client records, preferences, and timelines"
        />
        <JumpLinkCard
          href="/sos/bookings?tab=plans"
          icon={Crown}
          title="Membership Plans"
          description="Manage plans, packages, and loyalty credit passes"
        />
      </div>

      {/* Appointments — list / calendar views, plus Reports, Customers, and
          Plans (formerly the standalone /sos/reports, /sos/customers, and
          /sos/memberships pages, now tabs here) */}
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
          <TabsTrigger value="customers" data-testid="tab-customers">
            <Users className="h-4 w-4 mr-1.5" /> Customers
          </TabsTrigger>
          <TabsTrigger value="plans" data-testid="tab-membership-plans">
            <Crown className="h-4 w-4 mr-1.5" /> Plans
          </TabsTrigger>
          <TabsTrigger value="ai-receptionist" data-testid="tab-ai-receptionist">
            <Bot className="h-4 w-4 mr-1.5" /> AI Receptionist
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
          <div className="grid lg:grid-cols-3 gap-6 items-start">
            <div className="lg:col-span-2">
              <MonthCalendar appointments={appointments ?? []} isLoading={isLoadingAppointments} />
            </div>
            <TicketsColumn isLoadingVisits={isLoadingVisits} openTickets={openTickets} inService={inService} />
          </div>
        </TabsContent>

        <TabsContent value="reports" className="mt-0">
          <ReportsContent />
        </TabsContent>

        <TabsContent value="customers" className="mt-0">
          <CustomersContent initialCustomerId={initialCustomerId} />
        </TabsContent>

        <TabsContent value="plans" className="mt-0">
          <MembershipPlansContent />
        </TabsContent>

        <TabsContent value="ai-receptionist" className="mt-0">
          {/* Former standalone /sos/ai-receptionist page — config, call logs,
              inbound simulator, and SMS broadcast history, now a tab here.
              The old URL redirects to this tab. */}
          <AiReceptionistPage embedded />
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

/** Local date key (yyyy-mm-dd) — avoids UTC shifting from toISOString(). */
function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const CALENDAR_STATUS_STYLES: Record<string, string> = {
  booked: 'bg-primary/10 text-primary border-primary/20',
  completed: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/20',
  cancelled: 'bg-muted text-muted-foreground border-transparent line-through',
  no_show: 'bg-amber-500/10 text-amber-700 border-amber-500/20 line-through',
};

/** Month grid calendar — appointments on their days, click a day to book. */
function MonthCalendar({ appointments, isLoading }: { appointments: SosAppointment[]; isLoading: boolean }) {
  const today = new Date();
  const [monthStart, setMonthStart] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [bookDate, setBookDate] = useState<string | null>(null);
  const [detailApt, setDetailApt] = useState<SosAppointment | null>(null);

  const byDay = useMemo(() => {
    const map = new Map<string, SosAppointment[]>();
    for (const apt of appointments) {
      const key = toDateKey(new Date(apt.startsAt));
      const list = map.get(key) ?? [];
      list.push(apt);
      map.set(key, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
    }
    return map;
  }, [appointments]);

  // 6 fixed weeks starting on the Sunday on/before the 1st — stable grid height.
  const gridDays = useMemo(() => {
    const first = new Date(monthStart);
    first.setDate(1 - first.getDay());
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(first);
      d.setDate(first.getDate() + i);
      return d;
    });
  }, [monthStart]);

  const todayKey = toDateKey(today);
  const monthLabel = monthStart.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const shiftMonth = (delta: number) =>
    setMonthStart(m => new Date(m.getFullYear(), m.getMonth() + delta, 1));

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <CalIcon className="h-4 w-4 text-primary" />
            <span data-testid="text-calendar-month">{monthLabel}</span>
          </CardTitle>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" className="h-8 px-2" onClick={() => shiftMonth(-1)} data-testid="button-calendar-prev">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-3 text-xs"
              onClick={() => setMonthStart(new Date(today.getFullYear(), today.getMonth(), 1))}
              data-testid="button-calendar-today"
            >
              Today
            </Button>
            <Button variant="outline" size="sm" className="h-8 px-2" onClick={() => shiftMonth(1)} data-testid="button-calendar-next">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-96 w-full" />
        ) : (
          <div data-testid="grid-month-calendar">
            <div className="grid grid-cols-7 mb-1">
              {WEEKDAY_LABELS.map(d => (
                <div key={d} className="text-center text-[11px] uppercase font-bold text-muted-foreground py-1">{d}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 border-t border-l rounded-b-md overflow-hidden">
              {gridDays.map(day => {
                const key = toDateKey(day);
                const inMonth = day.getMonth() === monthStart.getMonth();
                const dayApts = byDay.get(key) ?? [];
                return (
                  <div
                    key={key}
                    role="button"
                    tabIndex={0}
                    onClick={() => setBookDate(key)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setBookDate(key); } }}
                    className={`min-h-24 border-r border-b p-1 text-left align-top cursor-pointer transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${inMonth ? '' : 'bg-muted/40 text-muted-foreground'}`}
                    data-testid={`cell-day-${key}`}
                    aria-label={`Book appointment on ${day.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })}`}
                  >
                    <div className={`text-xs font-semibold mb-1 h-5 w-5 flex items-center justify-center rounded-full ${key === todayKey ? 'bg-primary text-primary-foreground' : ''}`}>
                      {day.getDate()}
                    </div>
                    <div className="space-y-0.5">
                      {dayApts.slice(0, 3).map(apt => (
                        <button
                          key={apt.id}
                          type="button"
                          onClick={e => { e.stopPropagation(); setDetailApt(apt); }}
                          className={`w-full text-left text-[10px] leading-tight px-1 py-0.5 rounded border truncate block ${CALENDAR_STATUS_STYLES[apt.status] ?? CALENDAR_STATUS_STYLES.booked}`}
                          data-testid={`chip-appointment-${apt.id}`}
                          title={`${apt.customerName} — ${apt.serviceType}`}
                        >
                          {new Date(apt.startsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} {apt.customerName}
                        </button>
                      ))}
                      {dayApts.length > 3 && (
                        <div className="text-[10px] text-muted-foreground px-1">+{dayApts.length - 3} more</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>

      {/* Book on the clicked day — shared dialog pre-filled with that date */}
      <BookAppointmentDialog
        open={bookDate !== null}
        onOpenChange={o => { if (!o) setBookDate(null); }}
        initialDate={bookDate ?? undefined}
      />

      {/* Appointment detail (with cancellation) for a clicked appointment */}
      <AppointmentDetailDialog apt={detailApt} onClose={() => setDetailApt(null)} />
    </Card>
  );
}

/** Appointment detail dialog — source badge, times, and cancellation (from the old Calendar page rows). */
function AppointmentDetailDialog({ apt, onClose }: { apt: SosAppointment | null; onClose: () => void }) {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const cancel = useCancelSosAppointment();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleCancel = () => {
    if (!apt) return;
    cancel.mutate(
      { id: apt.id },
      {
        onSuccess: (res: any) => {
          queryClient.invalidateQueries({ queryKey: getListSosAppointmentsQueryKey({}) });
          setConfirmingCancel(false);
          onClose();
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
  const source = apt ? (sources[apt.source] || sources.staff) : sources.staff;
  const SourceIcon = source.icon;

  const dStart = apt ? new Date(apt.startsAt) : null;
  const dEnd = apt ? new Date(apt.endsAt) : null;

  return (
    <Dialog
      open={apt !== null}
      onOpenChange={o => { if (!o) { setConfirmingCancel(false); onClose(); } }}
    >
      <DialogContent data-testid="dialog-appointment-detail">
        {apt && dStart && dEnd && (
          <>
            <DialogHeader>
              <DialogTitle>{apt.customerName}</DialogTitle>
              <DialogDescription>
                {apt.serviceType} • {dStart.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })},{' '}
                {dStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – {dEnd.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className={`${source.color} border-transparent text-[10px]`}>
                <SourceIcon className="w-3 h-3 mr-1" /> {source.label}
              </Badge>
              <Badge variant="outline" className="text-[10px] capitalize">
                {apt.status === 'no_show' ? 'no-show' : apt.status}
              </Badge>
              {apt.deposit && <DepositBadge deposit={apt.deposit} />}
            </div>
            {confirmingCancel ? (
              <>
                <p className="text-sm text-muted-foreground">
                  If there are matching clients on the waitlist, the AI will automatically broadcast this open slot to them via SMS.
                </p>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setConfirmingCancel(false)}>Keep Appointment</Button>
                  <Button
                    variant="destructive"
                    onClick={handleCancel}
                    disabled={cancel.isPending}
                    data-testid="button-confirm-cancel-appointment"
                  >
                    Confirm Cancellation
                  </Button>
                </DialogFooter>
              </>
            ) : (
              <DialogFooter>
                <Button variant="outline" onClick={onClose}>Close</Button>
                {apt.status === 'booked' && (
                  <Button
                    variant="ghost"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setConfirmingCancel(true)}
                    data-testid="button-cancel-appointment"
                  >
                    <X className="w-4 h-4 mr-2" /> Cancel Appointment
                  </Button>
                )}
              </DialogFooter>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
