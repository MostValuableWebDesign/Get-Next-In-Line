import React, { useState } from 'react';
import {
  useListSosCustomers, useCreateSosCustomer, useGetSosCustomer, useGetSosCustomerTimeline,
  getListSosCustomersQueryKey, getGetSosCustomerQueryKey, getGetSosCustomerTimelineQueryKey,
  useGetSosCustomerPlans, getGetSosCustomerPlansQueryKey,
} from '@workspace/api-client-react';
import type { SosTimelineEntry } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Search, Plus, Phone, Mail, MessageSquare, Sparkles, CalendarClock, PhoneIncoming, Bot, Crown,
} from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { PLAN_ICONS, planStatusBadgeClass, CancelPlanButton } from '@/components/sos/plan-benefits';
import { usePartnerPerks, PartnerPerksBlock } from '@/components/sos/partner-perks';

/**
 * Customer CRM content — rendered as the "Customers" tab on Business
 * Bookings (the old standalone /sos/customers page redirects there).
 * `initialCustomerId` supports deep links (?customer=<id>) that auto-open
 * the customer detail dialog.
 */
export function CustomersContent({ initialCustomerId }: { initialCustomerId?: number | null }) {
  const [search, setSearch] = useState('');
  const [detailId, setDetailId] = useState<number | null>(initialCustomerId ?? null);
  const { data: customers } = useListSosCustomers({ search: search || undefined });

  return (
    <div className="space-y-4" data-testid="customers-content">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Customers</h2>
          <p className="text-muted-foreground text-sm mt-1">Manage client records, preferences, and timelines.</p>
        </div>
        <AddCustomerDialog />
      </div>

      <Card>
        <CardHeader className="py-4">
          <div className="relative w-72">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search customers..."
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </CardHeader>
        <div className="border-t">
          <table className="w-full text-sm text-left">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Name</th>
                <th className="px-6 py-3 font-medium">Contact</th>
                <th className="px-6 py-3 font-medium">Messaging</th>
                <th className="px-6 py-3 font-medium">Marketing</th>
                <th className="px-6 py-3 font-medium">Visits</th>
                <th className="px-6 py-3 font-medium">Last Visit</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {customers?.map(c => (
                <tr
                  key={c.id}
                  className="hover:bg-muted/30 transition-colors cursor-pointer"
                  onClick={() => setDetailId(c.id)}
                >
                  <td className="px-6 py-4 font-medium">{c.name}</td>
                  <td className="px-6 py-4 text-muted-foreground">
                    {c.phone && <div className="flex items-center gap-1.5"><Phone className="w-3 h-3"/> {c.phone}</div>}
                    {c.email && <div className="flex items-center gap-1.5 mt-1"><Mail className="w-3 h-3"/> {c.email}</div>}
                    {!c.phone && !c.email && '-'}
                  </td>
                  <td className="px-6 py-4">
                    {c.smsOptIn ? (
                      <span className="inline-flex items-center gap-1.5 text-emerald-600 bg-emerald-50 px-2 py-1 rounded text-xs font-medium border border-emerald-200">
                        <MessageSquare className="w-3 h-3" /> SMS Subscribed
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-xs">Opted out</span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    {c.marketing ? (
                      <div className="space-y-1">
                        <span className="inline-flex items-center gap-1.5 text-violet-700 bg-violet-50 px-2 py-1 rounded text-xs font-medium border border-violet-200">
                          <Sparkles className="w-3 h-3" /> Concierge linked
                        </span>
                        {c.marketing.nextVisitAt && (
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <CalendarClock className="w-3 h-3" />
                            Next: {new Date(c.marketing.nextVisitAt).toLocaleDateString()}
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted-foreground text-xs">Not linked</span>
                    )}
                  </td>
                  <td className="px-6 py-4">{c.visitCount}</td>
                  <td className="px-6 py-4 text-muted-foreground">
                    {c.lastVisitAt ? new Date(c.lastVisitAt).toLocaleDateString() : 'Never'}
                  </td>
                </tr>
              ))}
              {customers?.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-muted-foreground">
                    No customers found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <CustomerDetailDialog customerId={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-right">{value ?? '—'}</span>
    </div>
  );
}

function CustomerDetailDialog({ customerId, onClose }: { customerId: number | null; onClose: () => void }) {
  const { data: c } = useGetSosCustomer(customerId ?? 0, {
    query: {
      queryKey: getGetSosCustomerQueryKey(customerId ?? 0),
      enabled: customerId != null,
    },
  });
  const m = c?.marketing ?? null;

  return (
    <Dialog open={customerId != null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{c?.name ?? 'Customer'}</DialogTitle>
        </DialogHeader>
        {c && (
          <div className="space-y-4">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Operations</h3>
              <div className="divide-y rounded-md border px-3 py-1">
                <DetailRow label="Phone" value={c.phone} />
                <DetailRow label="Email" value={c.email} />
                <DetailRow label="SMS opt-in" value={c.smsOptIn ? 'Subscribed' : 'Opted out'} />
                <DetailRow label="Visits" value={c.visitCount} />
                <DetailRow
                  label="Last visit"
                  value={c.lastVisitAt ? new Date(c.lastVisitAt).toLocaleDateString() : 'Never'}
                />
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Marketing</h3>
                {m && (
                  <Badge variant="outline" className="text-violet-700 border-violet-200 bg-violet-50">
                    <Sparkles className="w-3 h-3 mr-1" /> From linked concierge profile
                  </Badge>
                )}
              </div>
              {m ? (
                <div className="divide-y rounded-md border px-3 py-1">
                  <DetailRow label="Preferred channel" value={m.preferredChannel.toUpperCase()} />
                  <DetailRow
                    label="Next visit"
                    value={m.nextVisitAt ? new Date(m.nextVisitAt).toLocaleString() : null}
                  />
                  <DetailRow
                    label="Visit cadence"
                    value={m.averageCycleDays != null ? `Every ~${m.averageCycleDays} days` : null}
                  />
                  <DetailRow label="Concierge SMS opt-in" value={m.smsOptIn ? 'Subscribed' : 'Opted out'} />
                </div>
              ) : (
                <p className="text-sm text-muted-foreground border rounded-md px-3 py-3">
                  No linked concierge profile. A link is created automatically when a
                  concierge client profile matches this customer's phone number.
                </p>
              )}
            </div>
            <CustomerPlansSection customerId={c.id} />
            <CustomerTimeline customerId={c.id} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const TXN_LABELS: Record<string, string> = {
  purchase: 'Purchased',
  renewal: 'Renewed',
  redemption: 'Credit redeemed',
  discount: 'Discount applied',
  cancellation: 'Cancelled',
};

function CustomerPlansSection({ customerId }: { customerId: number }) {
  const { data, isLoading } = useGetSosCustomerPlans(customerId, {
    query: { queryKey: getGetSosCustomerPlansQueryKey(customerId) },
  });
  // Live co-op partner perks ride along on the customer's digital pass —
  // deployed automatically while a partnership is accepted and active.
  const { perks, flashPerks, disclaimer } = usePartnerPerks();

  return (
    <div className="space-y-3">
      <PartnerPerksBlock
        perks={perks}
        flashPerks={flashPerks}
        disclaimer={disclaimer}
        passCode={`C${customerId}`}
        title="Partner Perks on this pass"
      />
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
        Memberships & Credits
      </h3>
      {isLoading ? (
        <Skeleton className="h-12 w-full" />
      ) : !data || data.plans.length === 0 ? (
        <p className="text-sm text-muted-foreground border rounded-md px-3 py-3">
          No plans yet. Sell a membership, package, or pass from the POS ticket.
        </p>
      ) : (
        <div className="space-y-2">
          {data.plans.map(p => {
            const Icon = PLAN_ICONS[p.planType] ?? Crown;
            return (
              <div key={p.id} className="border rounded-md px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium flex items-center gap-1.5">
                    <Icon className="w-3.5 h-3.5 text-amber-600" /> {p.planName}
                  </span>
                  <span className={`px-2 py-0.5 rounded text-xs font-medium border capitalize ${planStatusBadgeClass(p.status)}`}>
                    {p.status.replace(/_/g, ' ')}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    {p.planType === 'membership'
                      ? `${p.discountPercent}% off • $${p.price.toFixed(2)}/${p.billingInterval === 'yearly' ? 'yr' : 'mo'}${p.renewsAt ? ` • renews ${new Date(p.renewsAt).toLocaleDateString()}` : ''}`
                      : `${p.remainingCredits ?? 0} credits remaining`}
                  </span>
                  <CancelPlanButton plan={p} />
                </div>
              </div>
            );
          })}
          {data.transactions.length > 0 && (
            <div className="border rounded-md px-3 py-2 max-h-40 overflow-y-auto">
              <div className="text-xs font-semibold text-muted-foreground mb-1">Plan history</div>
              <div className="space-y-1">
                {data.transactions.map(t => (
                  <div key={t.id} className="flex justify-between gap-2 text-xs">
                    <span>
                      {TXN_LABELS[t.transactionType] ?? t.transactionType} — {t.planName}
                      {t.creditsDelta != null && t.creditsDelta < 0 && ' (−1 credit)'}
                      {t.amount != null && ` ($${t.amount.toFixed(2)})`}
                    </span>
                    <span className="text-muted-foreground shrink-0">
                      {new Date(t.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const CHANNEL_META: Record<
  string,
  { label: string; icon: React.ComponentType<{ className?: string }>; badgeClass: string }
> = {
  ai_call: { label: 'AI call', icon: PhoneIncoming, badgeClass: 'text-sky-700 border-sky-200 bg-sky-50' },
  sms: { label: 'Text', icon: MessageSquare, badgeClass: 'text-emerald-700 border-emerald-200 bg-emerald-50' },
  concierge: { label: 'Concierge', icon: Bot, badgeClass: 'text-violet-700 border-violet-200 bg-violet-50' },
};

function timelineLabel(e: SosTimelineEntry): string {
  if (e.channel === 'ai_call') return 'AI call';
  if (e.channel === 'concierge') {
    if (e.kind === 'send_reminder') return 'Reminder';
    if (e.kind === 'rebooking_nudge') return 'Rebooking nudge';
    return 'Concierge message';
  }
  if (e.direction === 'inbound') return 'Inbound text';
  return 'Staff/system text';
}

function statusBadgeClass(status: string): string {
  if (status === 'failed') return 'text-red-700 border-red-200 bg-red-50';
  if (status === 'skipped') return 'text-amber-700 border-amber-200 bg-amber-50';
  if (status === 'delivered' || status === 'sent' || status === 'booked')
    return 'text-emerald-700 border-emerald-200 bg-emerald-50';
  return 'text-muted-foreground border-border bg-muted/50';
}

function CustomerTimeline({ customerId }: { customerId: number }) {
  const { data: entries, isLoading } = useGetSosCustomerTimeline(customerId, {
    query: {
      queryKey: getGetSosCustomerTimelineQueryKey(customerId),
      refetchInterval: 15000,
    },
  });

  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
        Communications Timeline
      </h3>
      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : !entries || entries.length === 0 ? (
        <p className="text-sm text-muted-foreground border rounded-md px-3 py-3">
          No calls, texts, or automated messages yet for this customer.
        </p>
      ) : (
        <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
          {entries.map((e) => {
            const meta = CHANNEL_META[e.channel] ?? CHANNEL_META.sms;
            const Icon = meta.icon;
            return (
              <div key={e.id} className="border rounded-md px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium border ${meta.badgeClass}`}>
                    <Icon className="w-3 h-3" /> {timelineLabel(e)}
                  </span>
                  <span className={`px-2 py-0.5 rounded text-xs font-medium border capitalize ${statusBadgeClass(e.status)}`}>
                    {e.status.replace(/_/g, ' ')}
                  </span>
                </div>
                {e.body && <p className="mt-1.5 text-muted-foreground line-clamp-3">{e.body}</p>}
                <p className="mt-1 text-xs text-muted-foreground">
                  {new Date(e.timestamp).toLocaleString()}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AddCustomerDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [smsOptIn, setSmsOptIn] = useState(true);

  const create = useCreateSosCustomer();
  const queryClient = useQueryClient();

  const handleSave = () => {
    create.mutate(
      { data: { name, phone, email, smsOptIn } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSosCustomersQueryKey() });
          setOpen(false);
        }
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button data-testid="button-add-customer"><Plus className="mr-2 h-4 w-4" /> Add Customer</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add New Customer</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>Full Name *</Label>
            <Input value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Phone Number</Label>
            <Input value={phone} onChange={e => setPhone(e.target.value)} type="tel" />
          </div>
          <div className="space-y-2">
            <Label>Email</Label>
            <Input value={email} onChange={e => setEmail(e.target.value)} type="email" />
          </div>
          <div className="flex items-center space-x-2 pt-2">
            <Checkbox
              id="sms"
              checked={smsOptIn}
              onCheckedChange={(c) => setSmsOptIn(c as boolean)}
            />
            <Label htmlFor="sms" className="text-sm font-normal">
              Opt-in to SMS waitlist and appointment notifications
            </Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={!name}>Save Customer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
