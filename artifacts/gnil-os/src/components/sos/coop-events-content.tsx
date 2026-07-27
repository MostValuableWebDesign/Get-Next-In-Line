import { useMemo, useState } from 'react';
import {
  useListCoopEvents, getListCoopEventsQueryKey,
  useCreateCoopEvent, useRespondToCoopEvent,
  useGetCoopEvent, getGetCoopEventQueryKey,
  useCreateCoopEventExpense, useUpdateCoopEventParticipant,
  useTriggerCoopEventBroadcast, useCheckInCoopEvent,
  useListCoopPartnerships, getListCoopPartnershipsQueryKey,
  type CoopEvent, type CoopEventDetail, type CoopEventBroadcastResult,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import {
  CalendarDays, Check, MapPin, Megaphone, PartyPopper, QrCode, Receipt, Send,
  Ticket, Users, X,
} from 'lucide-react';

/**
 * Co-Op Community Event & Sponsorship Sync — merchant-facing Events area
 * inside the Local Co-Op Network hub.
 *
 * A host business plans a joint neighborhood event through the setup wizard
 * (details → invite partners → review), invited partners accept or decline,
 * and accepted participants share the event calendar. Each event carries an
 * internal expense ledger with even or weight-proportional splits and a
 * settlement summary, per-storefront + unified check-in QR passes with foot
 * traffic attribution, and a one-time joint announcement that goes out
 * through each participating business's own messaging channel.
 */
export function CoopEventsSection({ tenantId }: { tenantId: number }) {
  const { data: events, isLoading } = useListCoopEvents({
    query: { queryKey: getListCoopEventsQueryKey() },
  });

  const now = Date.now();
  const past = (events ?? []).filter(e => new Date(e.endsAt).getTime() <= now);
  const current = (events ?? []).filter(e => new Date(e.endsAt).getTime() > now);
  const invites = current.filter(e => e.myStatus === 'invited');
  const mine = current
    .filter(e => e.myStatus !== 'invited')
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());

  return (
    <Card data-testid="coop-events-section">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <PartyPopper className="w-4 h-4 text-primary" /> Community Events & Sponsorship Sync
        </CardTitle>
        <CardDescription>
          Plan joint neighborhood events with your co-op partners: pool sponsorship costs with
          automatic splitting, announce to everyone's customers at once, and track foot traffic
          back to each storefront.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <CheckInDialog />
        <CreateEventWizard tenantId={tenantId} />
        {isLoading ? (
          <Skeleton className="h-20 w-full rounded-lg" />
        ) : (
          <>
            {invites.length > 0 && (
              <div className="space-y-2" data-testid="list-event-invites">
                <h4 className="text-sm font-semibold">Event invitations</h4>
                {invites.map(e => <EventCard key={e.id} event={e} tenantId={tenantId} />)}
              </div>
            )}
            <div className="space-y-2" data-testid="list-events-upcoming">
              <h4 className="text-sm font-semibold">Shared event calendar</h4>
              {mine.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="text-no-events">
                  No joint events yet. Host one to bring the neighborhood together.
                </p>
              ) : (
                mine.map(e => <EventCard key={e.id} event={e} tenantId={tenantId} />)
              )}
            </div>
            {past.length > 0 && (
              <div className="space-y-2" data-testid="list-events-past">
                <h4 className="text-sm font-semibold text-muted-foreground">Past events</h4>
                {past.map(e => <EventCard key={e.id} event={e} tenantId={tenantId} past />)}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

const money = (n: number) => `$${n.toFixed(2)}`;

function EventCard({ event, tenantId, past = false }: { event: CoopEvent; tenantId: number; past?: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [detailOpen, setDetailOpen] = useState(false);

  const respond = useRespondToCoopEvent({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListCoopEventsQueryKey() }),
      onError: (err: unknown) =>
        toast({
          variant: 'destructive',
          title: 'Could not respond',
          description: (err as { data?: { message?: string } })?.data?.message ?? 'Please try again.',
        }),
    },
  });

  const accepted = event.participants.filter(p => p.status === 'accepted');

  return (
    <div
      className={`rounded-lg border p-3 space-y-2 ${past ? 'opacity-70' : ''}`}
      data-testid={`card-event-${event.id}`}
    >
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <div className="font-medium text-sm flex items-center gap-2">
            <PartyPopper className="w-3.5 h-3.5 text-primary" /> {event.name}
            {event.isHost && <Badge variant="secondary" className="text-[10px]">Hosting</Badge>}
            <Badge variant="outline" className="text-[10px]">{event.phase}</Badge>
          </div>
          {event.description && (
            <p className="text-xs text-muted-foreground mt-0.5">{event.description}</p>
          )}
        </div>
        <div className="text-right text-xs text-muted-foreground shrink-0">
          <div className="flex items-center gap-1 justify-end">
            <CalendarDays className="w-3 h-3" /> {fmt(event.startsAt)} → {fmt(event.endsAt)}
          </div>
          {event.location && (
            <div className="flex items-center gap-1 justify-end mt-0.5">
              <MapPin className="w-3 h-3" /> {event.location}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 text-xs" data-testid={`list-event-participants-${event.id}`}>
        {event.participants.map(p => (
          <Badge
            key={p.tenantId}
            variant={p.status === 'accepted' ? 'default' : 'outline'}
            className={p.status === 'declined' ? 'line-through opacity-60' : ''}
          >
            {p.tenantName}
            {p.status === 'accepted' ? ' ✓' : p.status === 'declined' ? ' ✕' : ' — invited'}
          </Badge>
        ))}
      </div>

      {event.myStatus === 'invited' && !past && (
        <div className="flex gap-2 pt-1">
          <Button
            size="sm"
            disabled={respond.isPending}
            onClick={() => respond.mutate({ id: event.id, data: { action: 'accept' } })}
            data-testid={`button-event-accept-${event.id}`}
          >
            <Check className="w-3.5 h-3.5 mr-1" /> Join event
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={respond.isPending}
            onClick={() => respond.mutate({ id: event.id, data: { action: 'decline' } })}
            data-testid={`button-event-decline-${event.id}`}
          >
            <X className="w-3.5 h-3.5 mr-1" /> Decline
          </Button>
        </div>
      )}

      {event.myStatus === 'accepted' && (
        <div className="pt-1">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setDetailOpen(true)}
            data-testid={`button-event-open-${event.id}`}
          >
            <Users className="w-3.5 h-3.5 mr-1" /> Open event
            {accepted.length > 1 && ` · ${accepted.length} businesses`}
          </Button>
          {detailOpen && (
            <EventDetailDialog
              eventId={event.id}
              tenantId={tenantId}
              open={detailOpen}
              onOpenChange={setDetailOpen}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── Event detail dialog: participants · ledger · passes · attendance ────────

function EventDetailDialog({
  eventId, tenantId, open, onOpenChange,
}: { eventId: number; tenantId: number; open: boolean; onOpenChange: (v: boolean) => void }) {
  const { data: detail, isLoading } = useGetCoopEvent(
    eventId,
    { query: { queryKey: getGetCoopEventQueryKey(eventId), enabled: open } },
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PartyPopper className="w-4 h-4 text-primary" /> {detail?.name ?? 'Event'}
          </DialogTitle>
          <DialogDescription>
            {detail?.location ? `${detail.location} · ` : ''}
            {detail ? `${fmt(detail.startsAt)} → ${fmt(detail.endsAt)}` : ''}
          </DialogDescription>
        </DialogHeader>
        {isLoading || !detail ? (
          <Skeleton className="h-48 w-full rounded-lg" />
        ) : (
          <Tabs defaultValue="participants">
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="participants" data-testid="tab-event-participants">Participants</TabsTrigger>
              <TabsTrigger value="ledger" data-testid="tab-event-ledger">Ledger</TabsTrigger>
              <TabsTrigger value="passes" data-testid="tab-event-passes">Passes</TabsTrigger>
              <TabsTrigger value="attendance" data-testid="tab-event-attendance">Attendance</TabsTrigger>
            </TabsList>
            <TabsContent value="participants">
              <ParticipantsTab detail={detail} tenantId={tenantId} />
            </TabsContent>
            <TabsContent value="ledger">
              <LedgerTab detail={detail} tenantId={tenantId} />
            </TabsContent>
            <TabsContent value="passes">
              <PassesTab detail={detail} />
            </TabsContent>
            <TabsContent value="attendance">
              <AttendanceTab detail={detail} />
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ParticipantsTab({ detail, tenantId }: { detail: CoopEventDetail; tenantId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [broadcastResult, setBroadcastResult] = useState<CoopEventBroadcastResult | null>(null);
  const [weights, setWeights] = useState<Record<number, string>>({});

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetCoopEventQueryKey(detail.id) });
    queryClient.invalidateQueries({ queryKey: getListCoopEventsQueryKey() });
  };

  const updateWeight = useUpdateCoopEventParticipant({
    mutation: {
      onSuccess: invalidate,
      onError: (err: unknown) =>
        toast({
          variant: 'destructive',
          title: 'Could not update share weight',
          description: (err as { data?: { message?: string } })?.data?.message ?? 'Please try again.',
        }),
    },
  });
  const broadcast = useTriggerCoopEventBroadcast({
    mutation: {
      onSuccess: (res: CoopEventBroadcastResult) => { setBroadcastResult(res); invalidate(); },
      onError: (err: unknown) =>
        toast({
          variant: 'destructive',
          title: 'Announcement not sent',
          description: (err as { data?: { message?: string } })?.data?.message ?? 'Please try again.',
        }),
    },
  });

  const accepted = detail.participants.filter(p => p.status === 'accepted');

  return (
    <div className="space-y-3 pt-2">
      <div className="space-y-1.5">
        {detail.participants.map(p => (
          <div
            key={p.tenantId}
            className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-sm"
            data-testid={`row-event-participant-${p.tenantId}`}
          >
            <span className="flex items-center gap-2">
              {p.tenantName}
              {p.tenantId === detail.hostTenantId && <Badge variant="secondary" className="text-[10px]">Host</Badge>}
              <Badge
                variant={p.status === 'accepted' ? 'default' : 'outline'}
                className={`text-[10px] ${p.status === 'declined' ? 'opacity-60' : ''}`}
              >
                {p.status}
              </Badge>
            </span>
            {detail.isHost && p.status === 'accepted' && (
              <span className="flex items-center gap-1.5 text-xs">
                <span className="text-muted-foreground">Cost share weight</span>
                <Input
                  className="h-7 w-16 text-xs"
                  value={weights[p.tenantId] ?? String(p.shareWeight)}
                  onChange={e => setWeights(w => ({ ...w, [p.tenantId]: e.target.value }))}
                  data-testid={`input-event-weight-${p.tenantId}`}
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2"
                  disabled={updateWeight.isPending || !(Number(weights[p.tenantId] ?? p.shareWeight) > 0)}
                  onClick={() =>
                    updateWeight.mutate({
                      id: detail.id,
                      tenantId: p.tenantId,
                      data: { shareWeight: Number(weights[p.tenantId] ?? p.shareWeight) },
                    })
                  }
                  data-testid={`button-event-weight-save-${p.tenantId}`}
                >
                  Save
                </Button>
              </span>
            )}
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Weights only affect expenses split proportionally. Pending or declined businesses never
        appear on event materials or customer announcements.
      </p>

      {detail.isHost && (
        <div className="space-y-1.5 border-t pt-3">
          {detail.broadcastTriggeredAt == null ? (
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                size="sm"
                variant="secondary"
                disabled={broadcast.isPending || accepted.length < 2 || detail.phase === 'ended'}
                onClick={() => broadcast.mutate({ id: detail.id })}
                data-testid={`button-event-broadcast-${detail.id}`}
              >
                <Send className="w-3.5 h-3.5 mr-1" /> Announce to all customers
              </Button>
              <span className="text-[11px] text-muted-foreground">
                One-time joint announcement — each business texts its own customers through its own
                channel.
              </span>
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground" data-testid={`text-event-broadcast-done-${detail.id}`}>
              Joint announcement sent {fmt(detail.broadcastTriggeredAt)}.
            </p>
          )}
          {broadcastResult && (
            <p className="text-xs" data-testid={`text-event-broadcast-summary-${detail.id}`}>
              <span className="font-medium text-emerald-600">{broadcastResult.sent} sent</span>
              {' · '}
              <span className="text-muted-foreground">
                {broadcastResult.skipped} skipped (opt-out/duplicate/no phone) of{' '}
                {broadcastResult.totalCandidates} customers across{' '}
                {broadcastResult.perTenant.length} businesses
              </span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function LedgerTab({ detail, tenantId }: { detail: CoopEventDetail; tenantId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [proportional, setProportional] = useState(false);

  const addExpense = useCreateCoopEventExpense({
    mutation: {
      onSuccess: () => {
        setDescription(''); setAmount('');
        queryClient.invalidateQueries({ queryKey: getGetCoopEventQueryKey(detail.id) });
      },
      onError: (err: unknown) =>
        toast({
          variant: 'destructive',
          title: 'Could not log expense',
          description: (err as { data?: { message?: string } })?.data?.message ?? 'Please try again.',
        }),
    },
  });

  const mySettlement = detail.settlement.find(s => s.tenantId === tenantId);

  return (
    <div className="space-y-3 pt-2">
      {mySettlement && (
        <div className="rounded-md border bg-muted/40 p-2.5 text-sm" data-testid="text-event-my-settlement">
          <span className="font-medium">Your position: </span>
          {mySettlement.net > 0 ? (
            <span className="text-emerald-600 font-medium">you're owed {money(mySettlement.net)}</span>
          ) : mySettlement.net < 0 ? (
            <span className="text-red-600 font-medium">you owe {money(-mySettlement.net)}</span>
          ) : (
            <span>settled up</span>
          )}
          <span className="text-muted-foreground"> — paid {money(mySettlement.paid)}, your share {money(mySettlement.owes)}</span>
        </div>
      )}

      <div className="flex items-end gap-2 flex-wrap">
        <div className="space-y-1 flex-1 min-w-32">
          <Label htmlFor={`exp-desc-${detail.id}`} className="text-xs">Shared cost</Label>
          <Input
            id={`exp-desc-${detail.id}`}
            placeholder="e.g. Street permit"
            value={description}
            onChange={e => setDescription(e.target.value)}
            data-testid="input-event-expense-desc"
          />
        </div>
        <div className="space-y-1 w-28">
          <Label htmlFor={`exp-amt-${detail.id}`} className="text-xs">Amount ($)</Label>
          <Input
            id={`exp-amt-${detail.id}`}
            type="number"
            min="0.01"
            step="0.01"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            data-testid="input-event-expense-amount"
          />
        </div>
        <label className="flex items-center gap-1.5 text-xs pb-2.5 cursor-pointer">
          <Checkbox
            checked={proportional}
            onCheckedChange={c => setProportional(c === true)}
            data-testid="checkbox-event-expense-proportional"
          />
          Split by weight
        </label>
        <Button
          size="sm"
          disabled={addExpense.isPending || !description.trim() || !(Number(amount) > 0)}
          onClick={() =>
            addExpense.mutate({
              id: detail.id,
              data: {
                description: description.trim(),
                amount: Number(amount),
                splitMethod: proportional ? 'proportional' : 'even',
              },
            })
          }
          data-testid="button-event-add-expense"
        >
          <Receipt className="w-3.5 h-3.5 mr-1" /> Log cost
        </Button>
      </div>

      {detail.expenses.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="text-event-no-expenses">
          No shared costs logged yet.
        </p>
      ) : (
        <div className="space-y-1.5" data-testid="list-event-expenses">
          {detail.expenses.map(exp => (
            <div key={exp.id} className="rounded-md border p-2.5 text-sm" data-testid={`row-event-expense-${exp.id}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{exp.description}</span>
                <span>{money(exp.amount)}</span>
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Paid by {exp.paidByTenantName} · split {exp.splitMethod === 'even' ? 'evenly' : 'by weight'}:{' '}
                {exp.shares.map(s => `${s.tenantName} ${money(s.amount)}`).join(' · ')}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="border-t pt-2 space-y-1" data-testid="list-event-settlement">
        <h5 className="text-xs font-semibold text-muted-foreground uppercase">Settlement summary</h5>
        {detail.settlement.map(s => (
          <div key={s.tenantId} className="flex items-center justify-between text-xs" data-testid={`row-event-settlement-${s.tenantId}`}>
            <span>{s.tenantName}</span>
            <span className={s.net > 0 ? 'text-emerald-600' : s.net < 0 ? 'text-red-600' : 'text-muted-foreground'}>
              paid {money(s.paid)} · share {money(s.owes)} · net {s.net >= 0 ? '+' : '−'}{money(Math.abs(s.net))}
            </span>
          </div>
        ))}
        <p className="text-[11px] text-muted-foreground pt-1">
          Internal ledger only — settle up between businesses however you prefer; no money moves
          through the platform.
        </p>
      </div>
    </div>
  );
}

function PassesTab({ detail }: { detail: CoopEventDetail }) {
  return (
    <div className="space-y-3 pt-2">
      <p className="text-xs text-muted-foreground">
        Print or display these at the event. Scans of a storefront's code credit that business's
        foot traffic; the unified code counts community-wide attendance.
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3" data-testid="list-event-passes">
        {detail.passes.map(pass => (
          <div
            key={pass.code}
            className="rounded-lg border p-3 flex flex-col items-center gap-2 text-center"
            data-testid={`card-event-pass-${pass.tenantId ?? 'unified'}`}
          >
            <QRCodeSVG value={pass.code} size={96} />
            <div className="text-xs font-medium flex items-center gap-1">
              {pass.tenantId == null ? (
                <><Ticket className="w-3 h-3" /> Unified event pass</>
              ) : (
                pass.tenantName
              )}
            </div>
            <code className="text-[10px] text-muted-foreground break-all">{pass.code}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

function AttendanceTab({ detail }: { detail: CoopEventDetail }) {
  const max = Math.max(1, ...detail.attendance.byStorefront.map(s => s.checkins));
  return (
    <div className="space-y-3 pt-2">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border p-3 text-center">
          <div className="text-2xl font-bold" data-testid="text-event-total-checkins">
            {detail.attendance.totalCheckins}
          </div>
          <div className="text-xs text-muted-foreground">Total community foot traffic</div>
        </div>
        <div className="rounded-lg border p-3 text-center">
          <div className="text-2xl font-bold" data-testid="text-event-unified-checkins">
            {detail.attendance.unifiedCheckins}
          </div>
          <div className="text-xs text-muted-foreground">Via unified event code</div>
        </div>
      </div>
      <div className="space-y-1.5" data-testid="list-event-storefront-stats">
        <h5 className="text-xs font-semibold text-muted-foreground uppercase">Per-storefront attribution</h5>
        {detail.attendance.byStorefront.map(s => (
          <div key={s.tenantId} className="space-y-0.5" data-testid={`row-event-stat-${s.tenantId}`}>
            <div className="flex items-center justify-between text-xs">
              <span>{s.tenantName}</span>
              <span className="font-medium">{s.checkins}</span>
            </div>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-primary rounded-full"
                style={{ width: `${(s.checkins / max) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Check-in dialog: record a scanned/typed pass code ───────────────────────

function CheckInDialog() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [attendeeName, setAttendeeName] = useState('');

  const checkIn = useCheckInCoopEvent({
    mutation: {
      onSuccess: res => {
        toast({
          title: 'Checked in',
          description: res.attributedTenantName
            ? `Credited to ${res.attributedTenantName} for "${res.eventName}".`
            : `Counted toward "${res.eventName}" community attendance.`,
        });
        setCode(''); setAttendeeName('');
        queryClient.invalidateQueries({ queryKey: getListCoopEventsQueryKey() });
      },
      onError: (err: unknown) =>
        toast({
          variant: 'destructive',
          title: 'Check-in failed',
          description: (err as { data?: { message?: string } })?.data?.message ?? 'Unknown code.',
        }),
    },
  });

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="button-event-checkin">
        <QrCode className="w-3.5 h-3.5 mr-1" /> Record event check-in
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Event check-in</DialogTitle>
            <DialogDescription>
              Enter the code from a scanned pass. Storefront codes credit that business; the
              unified code counts community-wide.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="checkin-code">Pass code</Label>
              <Input
                id="checkin-code"
                value={code}
                onChange={e => setCode(e.target.value)}
                placeholder="EVS-… or EVT-…"
                data-testid="input-event-checkin-code"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="checkin-name">Attendee name (optional)</Label>
              <Input
                id="checkin-name"
                value={attendeeName}
                onChange={e => setAttendeeName(e.target.value)}
                data-testid="input-event-checkin-name"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
            <Button
              disabled={checkIn.isPending || !code.trim()}
              onClick={() =>
                checkIn.mutate({
                  data: {
                    code: code.trim(),
                    ...(attendeeName.trim() ? { attendeeName: attendeeName.trim() } : {}),
                  },
                })
              }
              data-testid="button-event-checkin-submit"
            >
              <Check className="w-3.5 h-3.5 mr-1" /> Check in
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Event setup wizard: details → invite partners → review ──────────────────

function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function CreateEventWizard({ tenantId }: { tenantId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const { data: partnerships } = useListCoopPartnerships(
    { tenantId },
    { query: { queryKey: getListCoopPartnershipsQueryKey({ tenantId }) } },
  );
  // Current accepted, active partners — the only businesses an event may invite.
  const partners = useMemo(() => {
    const seen = new Map<number, string>();
    for (const p of partnerships ?? []) {
      if (p.status !== 'accepted' || !p.isActive || p.bannedAt != null) continue;
      const otherId = p.hostTenantId === tenantId ? p.partnerTenantId : p.hostTenantId;
      const otherName = p.hostTenantId === tenantId ? p.partnerTenantName : p.hostTenantName;
      seen.set(otherId, otherName);
    }
    return [...seen.entries()].map(([id, label]) => ({ id, label }));
  }, [partnerships, tenantId]);

  const reset = () => {
    setStep(0); setName(''); setDescription(''); setLocation('');
    setStartsAt(''); setEndsAt(''); setSelected(new Set());
  };

  const openWizard = () => {
    const start = new Date();
    start.setMinutes(0, 0, 0);
    start.setDate(start.getDate() + 7);
    start.setHours(10);
    const end = new Date(start.getTime() + 8 * 3_600_000);
    setStartsAt(toLocalInputValue(start));
    setEndsAt(toLocalInputValue(end));
    setOpen(true);
  };

  const create = useCreateCoopEvent({
    mutation: {
      onSuccess: () => {
        toast({ title: 'Event created', description: 'Your partners have been invited to join.' });
        queryClient.invalidateQueries({ queryKey: getListCoopEventsQueryKey() });
        setOpen(false);
        reset();
      },
      onError: (err: unknown) =>
        toast({
          variant: 'destructive',
          title: 'Could not create event',
          description: (err as { data?: { message?: string } })?.data?.message ?? 'Please try again.',
        }),
    },
  });

  const detailsValid = Boolean(name.trim() && startsAt && endsAt && new Date(startsAt) < new Date(endsAt));

  return (
    <>
      <Button size="sm" onClick={openWizard} disabled={partners.length === 0} data-testid="button-new-event">
        <Megaphone className="w-3.5 h-3.5 mr-1" /> Plan a community event
      </Button>
      {partners.length === 0 && (
        <p className="text-xs text-muted-foreground mt-1" data-testid="text-events-need-partner">
          You need at least one accepted, active partnership to host a joint event.
        </p>
      )}
      <Dialog open={open} onOpenChange={v => { setOpen(v); if (!v) reset(); }}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {step === 0 ? 'Event details' : step === 1 ? 'Invite partners' : 'Review & create'}
            </DialogTitle>
            <DialogDescription>
              Step {step + 1} of 3 — {step === 0
                ? 'name the event and set when and where it happens.'
                : step === 1
                  ? 'only accepted partners will appear on shared materials.'
                  : 'double-check everything before sending invites.'}
            </DialogDescription>
          </DialogHeader>

          {step === 0 && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="event-name">Event name</Label>
                <Input
                  id="event-name"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="e.g. Riverside Holiday Toy Drive"
                  data-testid="input-event-name"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="event-desc">Description</Label>
                <Textarea
                  id="event-desc"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="What's happening, and why customers should come"
                  rows={2}
                  data-testid="input-event-description"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="event-location">Location</Label>
                <Input
                  id="event-location"
                  value={location}
                  onChange={e => setLocation(e.target.value)}
                  placeholder="e.g. Riverside Plaza"
                  data-testid="input-event-location"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="event-start">Starts</Label>
                  <Input
                    id="event-start"
                    type="datetime-local"
                    value={startsAt}
                    onChange={e => setStartsAt(e.target.value)}
                    data-testid="input-event-start"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="event-end">Ends</Label>
                  <Input
                    id="event-end"
                    type="datetime-local"
                    value={endsAt}
                    onChange={e => setEndsAt(e.target.value)}
                    data-testid="input-event-end"
                  />
                </div>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-1.5">
              <Label>Invite your co-op partners</Label>
              <div className="space-y-1.5 max-h-48 overflow-y-auto rounded-md border p-2">
                {partners.map(p => (
                  <label key={p.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox
                      checked={selected.has(p.id)}
                      onCheckedChange={checked => {
                        setSelected(prev => {
                          const next = new Set(prev);
                          if (checked) next.add(p.id); else next.delete(p.id);
                          return next;
                        });
                      }}
                      data-testid={`checkbox-event-partner-${p.id}`}
                    />
                    {p.label}
                  </label>
                ))}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-2 text-sm" data-testid="event-wizard-review">
              <div><span className="font-medium">{name}</span></div>
              {description && <p className="text-muted-foreground text-xs">{description}</p>}
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <CalendarDays className="w-3 h-3" />
                {startsAt && fmt(new Date(startsAt).toISOString())} → {endsAt && fmt(new Date(endsAt).toISOString())}
                {location && <><MapPin className="w-3 h-3 ml-2" /> {location}</>}
              </div>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {partners.filter(p => selected.has(p.id)).map(p => (
                  <Badge key={p.id} variant="outline">{p.label}</Badge>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground pt-1">
                Invited partners must accept before they appear on the shared calendar, passes, or
                the customer announcement. You can broadcast the announcement any time after
                creating the event.
              </p>
            </div>
          )}

          <DialogFooter>
            {step > 0 && (
              <Button variant="outline" onClick={() => setStep(step - 1)} data-testid="button-event-wizard-back">
                Back
              </Button>
            )}
            {step < 2 ? (
              <Button
                disabled={step === 0 ? !detailsValid : selected.size === 0}
                onClick={() => setStep(step + 1)}
                data-testid="button-event-wizard-next"
              >
                Next
              </Button>
            ) : (
              <Button
                disabled={create.isPending}
                onClick={() =>
                  create.mutate({
                    data: {
                      name: name.trim(),
                      ...(description.trim() ? { description: description.trim() } : {}),
                      ...(location.trim() ? { location: location.trim() } : {}),
                      startsAt: new Date(startsAt).toISOString(),
                      endsAt: new Date(endsAt).toISOString(),
                      partnerTenantIds: [...selected],
                    },
                  })
                }
                data-testid="button-event-create"
              >
                Create & send invites
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
