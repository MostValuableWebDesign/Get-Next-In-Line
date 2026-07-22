import React from 'react';
import { Link } from 'wouter';
import { useListSosVisits } from '@workspace/api-client-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Receipt, Clock, ArrowRight } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Point of Sale — in-service overview. Open tickets awaiting payment are
 * checked out on the Business Bookings page (the single tickets panel);
 * this page links there instead of duplicating it.
 */
export function PosPage() {
  const { data: visits, isLoading } = useListSosVisits({ active: true });

  const openTickets = visits?.filter(v => v.status === 'payment') || [];
  const inService = visits?.filter(v => v.status === 'in_service') || [];

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Point of Sale</h1>
        <p className="text-muted-foreground text-sm mt-1">Track visits in progress. Payments are processed from Business Bookings.</p>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <div className="space-y-4">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Receipt className="h-5 w-5 text-primary" /> Awaiting Payment
          </h2>
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <Card className={openTickets.length > 0 ? 'border-primary/20 shadow-md' : 'border-dashed bg-muted/20'}>
              <CardContent className="p-5 flex flex-col items-start gap-3" data-testid="card-awaiting-payment-summary">
                {openTickets.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No open tickets waiting for payment.</p>
                ) : (
                  <>
                    <div>
                      <div className="text-2xl font-bold">{openTickets.length}</div>
                      <p className="text-sm text-muted-foreground">
                        open ticket{openTickets.length === 1 ? '' : 's'} waiting for checkout
                        {' — '}
                        {openTickets.map(t => t.customerName).join(', ')}
                      </p>
                    </div>
                    <Link href="/sos/bookings">
                      <Button data-testid="button-checkout-in-bookings">
                        Check out in Business Bookings <ArrowRight className="ml-2 h-4 w-4" />
                      </Button>
                    </Link>
                  </>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <h2 className="text-xl font-semibold flex items-center gap-2 text-muted-foreground">
            <Clock className="h-5 w-5" /> In Service (Upcoming)
          </h2>
          {isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : inService.length === 0 ? (
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
