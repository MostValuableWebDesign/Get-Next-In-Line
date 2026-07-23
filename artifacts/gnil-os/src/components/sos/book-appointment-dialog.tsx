import React, { useState } from 'react';
import { useCreateSosAppointment, getListSosAppointmentsQueryKey, type SosCustomer } from '@workspace/api-client-react';
import { CustomerPicker } from '@/components/sos/customer-picker';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ServiceTypeInput } from '@/components/sos/service-type-input';
import { useToast } from '@/hooks/use-toast';
import { CustomerPlanBadges } from '@/components/sos/plan-benefits';
import { Plus } from 'lucide-react';

/**
 * Shared "book an appointment" dialog used by every staff entry point
 * (Business Bookings list and calendar views). One set of fields and
 * one save flow so behavior can't drift between pages.
 */
export function BookAppointmentDialog({
  triggerLabel = 'Book Appointment',
  open: openProp,
  onOpenChange,
  initialDate,
}: {
  triggerLabel?: string;
  /** Controlled open state — when provided, the built-in trigger button is hidden. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Pre-fills the date field (yyyy-mm-dd) each time the dialog opens. */
  initialDate?: string;
}) {
  const isControlled = openProp !== undefined;
  const [internalOpen, setInternalOpen] = useState(false);
  const open = isControlled ? openProp : internalOpen;
  const setOpen = (next: boolean) => {
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  };
  const [customer, setCustomer] = useState<SosCustomer | null>(null);
  const [serviceType, setServiceType] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');

  const create = useCreateSosAppointment();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Pre-fill the date whenever the dialog opens with an initialDate (e.g.
  // from clicking a day on the calendar grid).
  React.useEffect(() => {
    if (open && initialDate) setDate(initialDate);
  }, [open, initialDate]);


  const handleSave = () => {
    if (!customer) return;
    const startsAt = new Date(`${date}T${time}`).toISOString();
    const dEnd = new Date(`${date}T${time}`);
    dEnd.setHours(dEnd.getHours() + 1);

    create.mutate(
      { data: { customerId: customer.id, serviceType, startsAt, endsAt: dEnd.toISOString(), source: 'staff' } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSosAppointmentsQueryKey({}) });
          setOpen(false);
          toast({ title: 'Appointment Booked' });
        },
        onError: () => {
          toast({ title: "Couldn't book appointment", description: 'Please try again.', variant: 'destructive' });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!isControlled && (
        <DialogTrigger asChild>
          <Button data-testid="button-book-appointment">
            <Plus className="mr-2 h-4 w-4" /> {triggerLabel}
          </Button>
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Book Appointment</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>Customer</Label>
            <CustomerPicker value={customer} onChange={setCustomer} />
            <CustomerPlanBadges customerId={customer?.id ?? null} />
          </div>
          <div className="space-y-2">
            <Label>Service Type</Label>
            <ServiceTypeInput value={serviceType} onChange={setServiceType} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Date</Label>
              <Input type="date" value={date} onChange={e => setDate(e.target.value)} data-testid="input-date" />
            </div>
            <div className="space-y-2">
              <Label>Time</Label>
              <Input type="time" value={time} onChange={e => setTime(e.target.value)} data-testid="input-time" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            onClick={handleSave}
            disabled={create.isPending || !serviceType || !date || !time || !customer}
            data-testid="button-confirm-book"
          >
            Book
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
