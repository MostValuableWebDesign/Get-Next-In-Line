import React, { useState } from 'react';
import { 
  useListSosAppointments, useCreateSosAppointment, useCancelSosAppointment,
  getListSosAppointmentsQueryKey 
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { Plus, X, Calendar as CalIcon, Bot, User, UserPlus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function CalendarPage() {
  const { data: appointments } = useListSosAppointments({});
  
  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Calendar</h1>
          <p className="text-muted-foreground text-sm mt-1">Manage appointments and schedule.</p>
        </div>
        <BookAppointmentDialog />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Upcoming Appointments</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {appointments?.map(apt => (
              <AppointmentRow key={apt.id} apt={apt} />
            ))}
            {appointments?.length === 0 && (
              <div className="text-center py-12 text-muted-foreground">No upcoming appointments.</div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function AppointmentRow({ apt }: { apt: any }) {
  const [open, setOpen] = useState(false);
  const cancel = useCancelSosAppointment();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleCancel = () => {
    cancel.mutate(
      { id: apt.id, data: {} },
      {
        onSuccess: (res: any) => {
          queryClient.invalidateQueries({ queryKey: getListSosAppointmentsQueryKey({}) });
          setOpen(false);
          toast({
            title: 'Appointment Cancelled',
            description: `Slot broadcast to ${res.waitlistNotified} waitlisted clients via SMS (${res.messagesSent} messages sent).`,
            variant: 'default',
          });
        }
      }
    );
  };

  const sources: Record<string, { icon: any, label: string, color: string }> = {
    staff: { icon: User, label: 'Staff', color: 'bg-blue-100 text-blue-800' },
    ai_receptionist: { icon: Bot, label: 'AI Receptionist', color: 'bg-purple-100 text-purple-800' },
    waitlist_fill: { icon: UserPlus, label: 'Waitlist Fill', color: 'bg-emerald-100 text-emerald-800' },
    self_book: { icon: CalIcon, label: 'Self Book', color: 'bg-gray-100 text-gray-800' }
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

function BookAppointmentDialog() {
  const [open, setOpen] = useState(false);
  const [customerId, setCustomerId] = useState("1");
  const [serviceType, setServiceType] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  
  const create = useCreateSosAppointment();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleSave = () => {
    // very basic date combination for demo
    const startsAt = new Date(`${date}T${time}`).toISOString();
    const dEnd = new Date(`${date}T${time}`);
    dEnd.setHours(dEnd.getHours() + 1);
    const endsAt = dEnd.toISOString();

    create.mutate(
      { data: { customerId: parseInt(customerId), serviceType, startsAt, endsAt, source: 'staff' } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSosAppointmentsQueryKey({}) });
          setOpen(false);
          toast({ title: 'Appointment Booked' });
        }
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button><Plus className="mr-2 h-4 w-4" /> Book Appointment</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Book Appointment</DialogTitle>
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
