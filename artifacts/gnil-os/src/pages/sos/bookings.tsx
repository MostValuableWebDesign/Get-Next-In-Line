import React, { useMemo, useState } from 'react';
import { Link } from 'wouter';
import {
  useListSosAppointments, useCreateSosAppointment, getListSosAppointmentsQueryKey,
  useListSosVisits,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Plus, Calendar as CalIcon, CreditCard, ArrowRight, Receipt, Clock, History,
} from 'lucide-react';

/**
 * Business Bookings — consolidated view of booking/transactional workflows.
 * Composes the existing appointments (Calendar) and visits (POS) data,
 * with quick booking creation and links into the full Calendar and POS pages.
 */
export function BookingsPage() {
  const { data: appointments, isLoading: isLoadingAppointments } = useListSosAppointments({});
  const { data: visits, isLoading: isLoadingVisits } = useListSosVisits({ active: true });

  const now = Date.now();
  const { upcoming, past } = useMemo(() => {
    const all = appointments ?? [];
    return {
      upcoming: all.filter(a => new Date(a.startsAt).getTime() >= now && a.status !== 'cancelled'),
      past: all.filter(a => new Date(a.startsAt).getTime() < now || a.status === 'cancelled'),
    };
  }, [appointments, now]);

  const openTickets = visits?.filter(v => v.status === 'payment') || [];
  const inService = visits?.filter(v => v.status === 'in_service') || [];

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Business Bookings</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Appointments and checkout activity in one place.
          </p>
        </div>
        <QuickBookDialog />
      </div>

      {/* Jump links to the full operational views */}
      <div className="grid sm:grid-cols-2 gap-4">
        <Link href="/sos/calendar" className="group">
          <Card className="hover:border-primary/40 transition-colors cursor-pointer">
            <CardContent className="p-4 flex items-center gap-3">
              <CalIcon className="h-5 w-5 text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-semibold">Full Calendar</div>
                <div className="text-xs text-muted-foreground">Manage the complete schedule and cancellations</div>
              </div>
              <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
            </CardContent>
          </Card>
        </Link>
        <Link href="/sos/pos" className="group">
          <Card className="hover:border-primary/40 transition-colors cursor-pointer">
            <CardContent className="p-4 flex items-center gap-3">
              <CreditCard className="h-5 w-5 text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-semibold">Point of Sale</div>
                <div className="text-xs text-muted-foreground">Process payments and close out visits</div>
              </div>
              <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
            </CardContent>
          </Card>
        </Link>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Appointments */}
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

        {/* Transactional (POS) */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Receipt className="h-4 w-4 text-primary" /> Awaiting Payment
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {isLoadingVisits ? (
                <Skeleton className="h-14 w-full" />
              ) : openTickets.length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-6">No open tickets waiting for payment.</div>
              ) : (
                openTickets.map(v => (
                  <div key={v.id} className="flex items-center justify-between p-3 border rounded-lg">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{v.customerName}</div>
                      <div className="text-xs text-muted-foreground truncate">{v.serviceType}</div>
                    </div>
                    <Link href="/sos/pos">
                      <Button size="sm" variant="outline">
                        Check out <ArrowRight className="ml-1 h-3 w-3" />
                      </Button>
                    </Link>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

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
      </div>
    </div>
  );
}

function AppointmentLine({ apt, muted = false }: { apt: any; muted?: boolean }) {
  const dStart = new Date(apt.startsAt);
  const dEnd = new Date(apt.endsAt);
  return (
    <div className={`flex items-center justify-between p-3 border rounded-lg ${muted ? 'opacity-70' : ''}`}>
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
      <Badge variant="outline" className="text-[10px] capitalize shrink-0">{apt.status}</Badge>
    </div>
  );
}

/** Quick booking creation — same flow as the Calendar page's dialog. */
function QuickBookDialog() {
  const [open, setOpen] = useState(false);
  const [customerId, setCustomerId] = useState('1');
  const [serviceType, setServiceType] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');

  const create = useCreateSosAppointment();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleSave = () => {
    const startsAt = new Date(`${date}T${time}`).toISOString();
    const dEnd = new Date(`${date}T${time}`);
    dEnd.setHours(dEnd.getHours() + 1);

    create.mutate(
      { data: { customerId: parseInt(customerId), serviceType, startsAt, endsAt: dEnd.toISOString(), source: 'staff' } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSosAppointmentsQueryKey({}) });
          setOpen(false);
          toast({ title: 'Appointment Booked' });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button><Plus className="mr-2 h-4 w-4" /> Quick Book</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Quick Book Appointment</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>Customer ID</Label>
            <Input value={customerId} onChange={e => setCustomerId(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Service Type</Label>
            <Input value={serviceType} onChange={e => setServiceType(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Date</Label>
              <Input type="date" value={date} onChange={e => setDate(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Time</Label>
              <Input type="time" value={time} onChange={e => setTime(e.target.value)} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={!serviceType || !date || !time}>Book</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
