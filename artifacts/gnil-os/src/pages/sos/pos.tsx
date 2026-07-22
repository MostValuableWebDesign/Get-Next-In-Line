import React, { useState } from 'react';
import { 
  useListSosVisits, useAdvanceSosVisit, getListSosVisitsQueryKey
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { Receipt, CheckCircle, Clock } from 'lucide-react';

export function PosPage() {
  const { data: visits } = useListSosVisits({ active: true });
  const advance = useAdvanceSosVisit();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const openTickets = visits?.filter(v => v.status === 'payment') || [];
  const inService = visits?.filter(v => v.status === 'in_service') || [];

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Point of Sale</h1>
        <p className="text-muted-foreground text-sm mt-1">Process payments and close out visits.</p>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <div className="space-y-4">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Receipt className="h-5 w-5 text-primary" /> Open Tickets
          </h2>
          {openTickets.length === 0 ? (
            <Card className="border-dashed bg-muted/20">
              <CardContent className="flex flex-col items-center justify-center h-32 text-muted-foreground text-sm">
                No open tickets waiting for payment.
              </CardContent>
            </Card>
          ) : (
            openTickets.map(ticket => (
              <TicketCard 
                key={ticket.id} 
                ticket={ticket} 
                onCheckout={(amount) => {
                  advance.mutate(
                    { id: ticket.id, data: { action: 'check_out', paymentAmount: amount } },
                    {
                      onSuccess: () => {
                        queryClient.invalidateQueries({ queryKey: getListSosVisitsQueryKey({ active: true }) });
                        toast({ title: 'Payment completed', description: `Checked out ${ticket.customerName}.` });
                      }
                    }
                  );
                }} 
              />
            ))
          )}
        </div>

        <div className="space-y-4">
          <h2 className="text-xl font-semibold flex items-center gap-2 text-muted-foreground">
            <Clock className="h-5 w-5" /> In Service (Upcoming)
          </h2>
          {inService.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center border rounded-lg bg-card/50">
              No active services.
            </div>
          ) : (
            inService.map(visit => (
              <div key={visit.id} className="p-4 border rounded-lg bg-card/50 flex justify-between items-center opacity-70 grayscale">
                <div>
                  <div className="font-medium">{visit.customerName}</div>
                  <div className="text-xs">{visit.serviceType}</div>
                </div>
                <div className="text-xs uppercase font-bold tracking-wide">In Service</div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function TicketCard({ ticket, onCheckout }: { ticket: any, onCheckout: (amt: number) => void }) {
  const [amount, setAmount] = useState(ticket.paymentAmount?.toString() || "");

  return (
    <Card className="border-primary/20 shadow-md">
      <CardContent className="p-5 flex flex-col gap-4">
        <div className="flex justify-between items-start">
          <div>
            <h3 className="font-bold text-lg">{ticket.customerName}</h3>
            <p className="text-sm text-muted-foreground">{ticket.serviceType} • {ticket.resourceName || 'No resource'}</p>
          </div>
          <div className="text-right">
            <div className="text-xs text-muted-foreground">Total Due</div>
            <div className="text-2xl font-bold">${parseFloat(amount || '0').toFixed(2)}</div>
          </div>
        </div>
        
        <div className="flex gap-4 items-end border-t pt-4">
          <div className="space-y-1.5 flex-1">
            <Label>Payment Amount</Label>
            <div className="relative">
              <span className="absolute left-3 top-2.5 text-muted-foreground">$</span>
              <Input 
                type="number" 
                className="pl-7 font-medium" 
                value={amount} 
                onChange={e => setAmount(e.target.value)} 
              />
            </div>
          </div>
          <Button 
            size="lg" 
            className="w-1/2" 
            disabled={!amount || parseFloat(amount) <= 0}
            onClick={() => onCheckout(parseFloat(amount))}
          >
            <CheckCircle className="mr-2 h-4 w-4" /> Charge & Complete
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
