import { useMemo, useState } from 'react';
import {
  useListCoopCoverageShifts, getListCoopCoverageShiftsQueryKey,
  useListCoopCoveragePartnerStaff, getListCoopCoveragePartnerStaffQueryKey,
  useCreateCoopCoverageShift, useOfferCoopCoverageStaff, useAcceptCoopCoverageOffer,
  useCompleteCoopCoverageShift, useCancelCoopCoverageShift, useRateCoopCoverageShift,
  useGetCoopCoverageLedger, getGetCoopCoverageLedgerQueryKey,
  useListSosStaff,
  type CoopCoverageShift, type CoopCoverageOffer, type CoopCoverageStaffCard,
  type SosStaffMember,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { LicenseStatusBadge } from '@/components/sos/staff-content';
import {
  CalendarClock, Plus, Star, Users, ClipboardList, ShieldCheck,
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Co-op Shift Coverage — labor-sharing marketplace inside the Co-Op hub.
// Post open shifts to accepted partners, offer eligible licensed staff,
// accept one offer, complete with hours, and rate the covering staff member.
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<CoopCoverageShift['status'], string> = {
  open: 'bg-blue-600 hover:bg-blue-600',
  offered: 'bg-amber-600 hover:bg-amber-600',
  confirmed: 'bg-emerald-600 hover:bg-emerald-600',
  completed: 'bg-slate-600 hover:bg-slate-600',
  cancelled: 'bg-slate-400 hover:bg-slate-400',
};

function StatusBadge({ status }: { status: CoopCoverageShift['status'] }) {
  return <Badge className={`text-[10px] capitalize ${STATUS_STYLES[status]}`}>{status}</Badge>;
}

function fmtWindow(shift: CoopCoverageShift): string {
  const s = new Date(shift.startsAt);
  const e = new Date(shift.endsAt);
  const day = s.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const t = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${t(s)} – ${t(e)}`;
}

function RatingStars({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-0.5 text-amber-500">
      <Star className="h-3 w-3 fill-current" />
      <span className="text-xs font-medium">{value.toFixed(1)}</span>
    </span>
  );
}

/**
 * Client-side mirror of the server's eligibility rules so the offer dialog
 * can explain *why* a staff member can't be offered. The server re-enforces
 * every rule — this is feedback, not enforcement.
 */
function ineligibilityReason(staff: SosStaffMember, shift: CoopCoverageShift): string | null {
  if (!staff.isActive) return 'Deactivated';
  if (!staff.coopCoverageEnabled) return 'Not marked available for co-op coverage';
  if (staff.licenseStatus === 'expired') return 'License expired';
  if (staff.licenseStatus === 'unverified') return 'License not verified';
  if ((staff.licenseState ?? '').toUpperCase() !== shift.requiredLicenseState.toUpperCase())
    return `Licensed in ${staff.licenseState ?? 'no state'}; shift requires ${shift.requiredLicenseState}`;
  const skill = shift.requiredSkill.trim().toLowerCase();
  if (!staff.skills.some(s => s.trim().toLowerCase() === skill))
    return `Missing required skill "${shift.requiredSkill}"`;
  return null;
}

export function ShiftCoverageSection({ tenantId }: { tenantId: number }) {
  const { data: shifts } = useListCoopCoverageShifts({
    query: { queryKey: getListCoopCoverageShiftsQueryKey() },
  });
  const { data: partnerStaff } = useListCoopCoveragePartnerStaff({
    query: { queryKey: getListCoopCoveragePartnerStaffQueryKey() },
  });
  const { data: ledger } = useGetCoopCoverageLedger({
    query: { queryKey: getGetCoopCoverageLedgerQueryKey() },
  });
  const [postOpen, setPostOpen] = useState(false);

  const mine = (shifts ?? []).filter(s => s.isMine);
  const partnerShifts = (shifts ?? []).filter(
    s => !s.isMine && (s.status === 'open' || s.status === 'offered'),
  );

  return (
    <Card data-testid="coop-coverage-section">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarClock className="h-4 w-4 text-primary" /> Shift Coverage
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Share vetted, licensed staff with your accepted co-op partners when someone is
            short-staffed. Rates are tracked for the agreement — never settled here.
          </p>
        </div>
        <Button size="sm" onClick={() => setPostOpen(true)} data-testid="btn-post-shift">
          <Plus className="mr-2 h-3.5 w-3.5" /> Post Shift
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Partner open-shift board */}
        <section>
          <h4 className="text-sm font-medium flex items-center gap-1.5 mb-2">
            <ClipboardList className="h-3.5 w-3.5 text-muted-foreground" /> Partner shifts needing coverage
          </h4>
          {partnerShifts.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="text-no-partner-shifts">
              No open shifts from your partners right now.
            </p>
          ) : (
            <div className="space-y-2">
              {partnerShifts.map(s => <PartnerShiftRow key={s.id} shift={s} />)}
            </div>
          )}
        </section>

        {/* My posted shifts + incoming offers */}
        <section>
          <h4 className="text-sm font-medium flex items-center gap-1.5 mb-2">
            <Users className="h-3.5 w-3.5 text-muted-foreground" /> My posted shifts
          </h4>
          {mine.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="text-no-my-shifts">
              You haven't posted any coverage shifts.
            </p>
          ) : (
            <div className="space-y-2">
              {mine.map(s => <MyShiftRow key={s.id} shift={s} />)}
            </div>
          )}
        </section>

        {/* Partner coverage-ready staff */}
        <section>
          <h4 className="text-sm font-medium flex items-center gap-1.5 mb-2">
            <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" /> Coverage-ready staff at partners
          </h4>
          {(partnerStaff?.length ?? 0) === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="text-no-partner-staff">
              No partner staff are opted into co-op coverage yet.
            </p>
          ) : (
            <div className="grid sm:grid-cols-2 gap-2">
              {partnerStaff!.map(c => <PartnerStaffCard key={c.staffId} card={c} />)}
            </div>
          )}
        </section>

        {/* Coverage ledger */}
        <CoverageLedger
          posted={ledger?.posted ?? []}
          covered={ledger?.covered ?? []}
        />
      </CardContent>

      <PostShiftDialog open={postOpen} onOpenChange={setPostOpen} />
    </Card>
  );
}

// ── invalidation helper ──────────────────────────────────────────────────────

function useInvalidateCoverage() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: getListCoopCoverageShiftsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetCoopCoverageLedgerQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListCoopCoveragePartnerStaffQueryKey() });
  };
}

// ── post-shift dialog ────────────────────────────────────────────────────────

function PostShiftDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const invalidate = useInvalidateCoverage();
  const create = useCreateCoopCoverageShift();
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('17:00');
  const [requiredSkill, setRequiredSkill] = useState('');
  const [requiredLicenseState, setRequiredLicenseState] = useState('');
  const [rate, setRate] = useState('');
  const [notes, setNotes] = useState('');

  const valid = date && startTime && endTime && requiredSkill.trim() && rate !== '' && Number(rate) >= 0;

  const handlePost = () => {
    create.mutate(
      {
        data: {
          startsAt: new Date(`${date}T${startTime}`).toISOString(),
          endsAt: new Date(`${date}T${endTime}`).toISOString(),
          requiredSkill: requiredSkill.trim(),
          ...(requiredLicenseState.trim() ? { requiredLicenseState: requiredLicenseState.trim().toUpperCase() } : {}),
          offeredHourlyRate: Number(rate),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
      },
      {
        onSuccess: () => {
          invalidate();
          onOpenChange(false);
          toast({ title: 'Shift posted', description: 'Your accepted co-op partners can now offer staff.' });
        },
        onError: (err: any) => {
          toast({ title: 'Could not post shift', description: err?.response?.data?.message || err?.message, variant: 'destructive' });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Post an Open Shift</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-2">
              <Label>Date</Label>
              <Input type="date" value={date} onChange={e => setDate(e.target.value)} data-testid="input-shift-date" />
            </div>
            <div className="space-y-2">
              <Label>Start</Label>
              <Input type="time" value={startTime} onChange={e => setStartTime(e.target.value)} data-testid="input-shift-start" />
            </div>
            <div className="space-y-2">
              <Label>End</Label>
              <Input type="time" value={endTime} onChange={e => setEndTime(e.target.value)} data-testid="input-shift-end" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-2 col-span-1">
              <Label>Required skill</Label>
              <Input value={requiredSkill} onChange={e => setRequiredSkill(e.target.value)} placeholder="fades" data-testid="input-shift-skill" />
            </div>
            <div className="space-y-2">
              <Label>License state</Label>
              <Input
                value={requiredLicenseState}
                onChange={e => setRequiredLicenseState(e.target.value)}
                placeholder="Your state"
                maxLength={2}
                data-testid="input-shift-state"
              />
            </div>
            <div className="space-y-2">
              <Label>Hourly rate</Label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-muted-foreground">$</span>
                <Input type="number" min="0" className="pl-7" value={rate} onChange={e => setRate(e.target.value)} placeholder="35" data-testid="input-shift-rate" />
              </div>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Notes (optional)</Label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Busy Saturday — walk-ins heavy from 11am." rows={2} data-testid="input-shift-notes" />
          </div>
          <p className="text-xs text-muted-foreground">
            Broadcasts only to accepted, active co-op partners. Leave the license state blank to use
            your business's own state — covering staff must hold a verified, unexpired license there.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handlePost} disabled={!valid || create.isPending} data-testid="btn-confirm-post-shift">
            Post Shift
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── partner shift row + offer dialog ─────────────────────────────────────────

function PartnerShiftRow({ shift }: { shift: CoopCoverageShift }) {
  const [offerOpen, setOfferOpen] = useState(false);
  const myOffer = shift.offers[0]; // partners only ever see their own offers

  return (
    <div className="border rounded-md p-3" data-testid={`partner-shift-${shift.id}`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium flex items-center gap-2 flex-wrap">
            {shift.tenantName} <StatusBadge status={shift.status} />
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {fmtWindow(shift)} • {shift.requiredSkill} • {shift.requiredLicenseState} license •{' '}
            ${shift.offeredHourlyRate.toFixed(2)}/hr
          </div>
          {shift.notes && <div className="text-xs text-muted-foreground mt-0.5 italic">{shift.notes}</div>}
          {myOffer && (
            <div className="text-xs mt-1">
              Your offer: {myOffer.staffName} — <span className="capitalize">{myOffer.status}</span>
            </div>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={() => setOfferOpen(true)} data-testid={`btn-offer-staff-${shift.id}`}>
          Offer Staff
        </Button>
      </div>
      <OfferStaffDialog shift={shift} open={offerOpen} onOpenChange={setOfferOpen} />
    </div>
  );
}

function OfferStaffDialog({
  shift, open, onOpenChange,
}: { shift: CoopCoverageShift; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const invalidate = useInvalidateCoverage();
  const { data: staff } = useListSosStaff();
  const offer = useOfferCoopCoverageStaff();
  const [staffId, setStaffId] = useState('');
  const [note, setNote] = useState('');

  const options = useMemo(
    () => (staff ?? []).map(s => ({ staff: s, reason: ineligibilityReason(s, shift) })),
    [staff, shift],
  );
  const selected = options.find(o => o.staff.id === Number(staffId));

  const handleOffer = () => {
    offer.mutate(
      { id: shift.id, data: { staffId: Number(staffId), ...(note.trim() ? { note: note.trim() } : {}) } },
      {
        onSuccess: () => {
          invalidate();
          onOpenChange(false);
          toast({ title: 'Staff offered', description: `${shift.tenantName} will review your offer.` });
        },
        onError: (err: any) => {
          toast({ title: 'Could not offer staff', description: err?.response?.data?.message || err?.message, variant: 'destructive' });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Offer staff to {shift.tenantName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="text-xs text-muted-foreground">
            {fmtWindow(shift)} • requires <strong>{shift.requiredSkill}</strong> with a verified{' '}
            <strong>{shift.requiredLicenseState}</strong> license • ${shift.offeredHourlyRate.toFixed(2)}/hr
          </div>
          <div className="space-y-2">
            <Label>Staff member</Label>
            <Select value={staffId} onValueChange={setStaffId}>
              <SelectTrigger data-testid="select-offer-staff">
                <SelectValue placeholder="Choose a team member" />
              </SelectTrigger>
              <SelectContent>
                {options.map(({ staff: s, reason }) => (
                  <SelectItem key={s.id} value={String(s.id)} disabled={reason != null}>
                    {s.name}{reason ? ` — ${reason}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selected?.reason && (
              <p className="text-xs text-destructive" data-testid="text-offer-ineligible-reason">
                {selected.reason}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label>Note (optional)</Label>
            <Input value={note} onChange={e => setNote(e.target.value)} placeholder="Maya has covered weekend rushes before." data-testid="input-offer-note" />
          </div>
          <p className="text-xs text-muted-foreground">
            Only staff marked available for co-op coverage with a verified, unexpired,{' '}
            {shift.requiredLicenseState}-state license and the required skill can be offered.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={handleOffer}
            disabled={!selected || selected.reason != null || offer.isPending}
            data-testid="btn-confirm-offer"
          >
            Send Offer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── my shift row (incoming offers, lifecycle actions) ────────────────────────

function MyShiftRow({ shift }: { shift: CoopCoverageShift }) {
  const { toast } = useToast();
  const invalidate = useInvalidateCoverage();
  const accept = useAcceptCoopCoverageOffer();
  const complete = useCompleteCoopCoverageShift();
  const cancel = useCancelCoopCoverageShift();
  const [hours, setHours] = useState('');
  const [completeOpen, setCompleteOpen] = useState(false);

  const onError = (title: string) => (err: any) =>
    toast({ title, description: err?.response?.data?.message || err?.message, variant: 'destructive' });

  const pending = shift.offers.filter(o => o.status === 'pending');
  const winner = shift.acceptedOfferId != null
    ? shift.offers.find(o => o.id === shift.acceptedOfferId) ?? null
    : null;

  return (
    <div className="border rounded-md p-3 space-y-2" data-testid={`my-shift-${shift.id}`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium flex items-center gap-2 flex-wrap">
            {shift.requiredSkill} coverage <StatusBadge status={shift.status} />
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {fmtWindow(shift)} • {shift.requiredLicenseState} license • ${shift.offeredHourlyRate.toFixed(2)}/hr
            {shift.hoursWorked != null && ` • ${shift.hoursWorked} hrs recorded`}
          </div>
          {winner && (
            <div className="text-xs mt-0.5">
              Covered by <strong>{winner.staffName}</strong> from {winner.offeringTenantName}
            </div>
          )}
        </div>
        <div className="flex gap-1 shrink-0">
          {shift.status === 'confirmed' && (
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setCompleteOpen(true)} data-testid={`btn-complete-shift-${shift.id}`}>
              Complete
            </Button>
          )}
          {(shift.status === 'open' || shift.status === 'offered' || shift.status === 'confirmed') && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() =>
                cancel.mutate(
                  { id: shift.id },
                  { onSuccess: () => { invalidate(); toast({ title: 'Shift cancelled' }); }, onError: onError('Could not cancel') },
                )
              }
              disabled={cancel.isPending}
              data-testid={`btn-cancel-shift-${shift.id}`}
            >
              Cancel
            </Button>
          )}
        </div>
      </div>

      {pending.length > 0 && (
        <div className="space-y-1.5 border-t pt-2">
          <div className="text-xs font-medium">Offers ({pending.length})</div>
          {pending.map(o => (
            <div key={o.id} className="flex items-center justify-between gap-2 text-xs" data-testid={`offer-row-${o.id}`}>
              <div>
                <span className="font-medium">{o.staffName}</span> from {o.offeringTenantName}
                {' '}<LicenseStatusBadge status={o.licenseStatus} />
                {o.averageRating != null && <span className="ml-1"><RatingStars value={o.averageRating} /></span>}
                {o.note && <span className="text-muted-foreground italic"> — “{o.note}”</span>}
              </div>
              <Button
                size="sm"
                className="h-6 text-xs"
                onClick={() =>
                  accept.mutate(
                    { id: o.id },
                    { onSuccess: () => { invalidate(); toast({ title: 'Offer accepted', description: `${o.staffName} is confirmed for this shift.` }); }, onError: onError('Could not accept offer') },
                  )
                }
                disabled={accept.isPending}
                data-testid={`btn-accept-offer-${o.id}`}
              >
                Accept
              </Button>
            </div>
          ))}
        </div>
      )}

      <Dialog open={completeOpen} onOpenChange={setCompleteOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Complete shift</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label>Hours worked</Label>
            <Input type="number" min="0" step="0.25" value={hours} onChange={e => setHours(e.target.value)} placeholder="8" data-testid="input-hours-worked" />
            <p className="text-xs text-muted-foreground">
              Recorded on the shared ledger with the agreed ${shift.offeredHourlyRate.toFixed(2)}/hr rate.
              No payment is processed.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCompleteOpen(false)}>Cancel</Button>
            <Button
              onClick={() =>
                complete.mutate(
                  { id: shift.id, data: { hoursWorked: Number(hours) } },
                  {
                    onSuccess: () => { invalidate(); setCompleteOpen(false); toast({ title: 'Shift completed', description: 'You can now rate the covering staff member in the ledger.' }); },
                    onError: onError('Could not complete shift'),
                  },
                )
              }
              disabled={hours === '' || Number(hours) < 0 || complete.isPending}
              data-testid="btn-confirm-complete"
            >
              Record Completion
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── partner staff cards ──────────────────────────────────────────────────────

function PartnerStaffCard({ card }: { card: CoopCoverageStaffCard }) {
  return (
    <div className="border rounded-md p-3" data-testid={`partner-staff-card-${card.staffId}`}>
      <div className="text-sm font-medium flex items-center gap-2 flex-wrap">
        {card.staffName}
        <LicenseStatusBadge status={card.licenseStatus} />
        {card.averageRating != null && <RatingStars value={card.averageRating} />}
      </div>
      <div className="text-xs text-muted-foreground mt-0.5">
        {card.tenantName}{card.licenseState ? ` • licensed in ${card.licenseState}` : ''}
        {card.ratingCount > 0 && ` • ${card.ratingCount} cross-store rating${card.ratingCount === 1 ? '' : 's'}`}
      </div>
      {(card.skills.length > 0 || card.certifications.length > 0) && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {card.skills.map(s => <Badge key={`sk-${s}`} variant="secondary" className="text-[10px]">{s}</Badge>)}
          {card.certifications.map(c => <Badge key={`ct-${c}`} variant="outline" className="text-[10px]">{c}</Badge>)}
        </div>
      )}
    </div>
  );
}

// ── coverage ledger with rating entry ────────────────────────────────────────

function CoverageLedger({ posted, covered }: { posted: CoopCoverageShift[]; covered: CoopCoverageShift[] }) {
  const settled = [
    ...posted.map(s => ({ shift: s, role: 'posted' as const })),
    ...covered.map(s => ({ shift: s, role: 'covered' as const })),
  ].filter(({ shift }) => shift.status === 'completed' || shift.status === 'cancelled' || shift.status === 'confirmed');

  if (settled.length === 0) {
    return (
      <section>
        <h4 className="text-sm font-medium mb-2">Coverage ledger</h4>
        <p className="text-xs text-muted-foreground" data-testid="text-empty-ledger">
          Confirmed and completed shifts appear here with rates, hours, and ratings.
        </p>
      </section>
    );
  }

  return (
    <section data-testid="coverage-ledger">
      <h4 className="text-sm font-medium mb-2">Coverage ledger</h4>
      <div className="space-y-2">
        {settled
          .sort((a, b) => new Date(b.shift.startsAt).getTime() - new Date(a.shift.startsAt).getTime())
          .map(({ shift, role }) => <LedgerRow key={`${role}-${shift.id}`} shift={shift} role={role} />)}
      </div>
    </section>
  );
}

function LedgerRow({ shift, role }: { shift: CoopCoverageShift; role: 'posted' | 'covered' }) {
  const { toast } = useToast();
  const invalidate = useInvalidateCoverage();
  const rate = useRateCoopCoverageShift();
  const [rateOpen, setRateOpen] = useState(false);
  const [stars, setStars] = useState('5');
  const [comment, setComment] = useState('');

  const winner = shift.acceptedOfferId != null
    ? shift.offers.find((o: CoopCoverageOffer) => o.id === shift.acceptedOfferId) ?? null
    : null;
  const canRate = role === 'posted' && shift.status === 'completed' && shift.rating == null;

  return (
    <div className="border rounded-md p-3 flex items-center justify-between gap-3" data-testid={`ledger-row-${shift.id}`}>
      <div>
        <div className="text-sm font-medium flex items-center gap-2 flex-wrap">
          {role === 'posted' ? `Coverage at your shop` : `Your staff at ${shift.tenantName}`}
          <StatusBadge status={shift.status} />
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          {fmtWindow(shift)} • {shift.requiredSkill} • ${shift.offeredHourlyRate.toFixed(2)}/hr
          {shift.hoursWorked != null && ` • ${shift.hoursWorked} hrs`}
          {winner && ` • ${winner.staffName} (${winner.offeringTenantName})`}
        </div>
        {shift.rating && (
          <div className="text-xs mt-0.5 flex items-center gap-1">
            <RatingStars value={shift.rating.rating} />
            {shift.rating.comment && <span className="text-muted-foreground italic">“{shift.rating.comment}”</span>}
          </div>
        )}
      </div>
      {canRate && (
        <Button size="sm" variant="outline" className="h-7 text-xs shrink-0" onClick={() => setRateOpen(true)} data-testid={`btn-rate-shift-${shift.id}`}>
          Rate Staff
        </Button>
      )}

      <Dialog open={rateOpen} onOpenChange={setRateOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rate {winner?.staffName ?? 'covering staff'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-2">
              <Label>Rating</Label>
              <Select value={stars} onValueChange={setStars}>
                <SelectTrigger data-testid="select-rating">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[5, 4, 3, 2, 1].map(n => (
                    <SelectItem key={n} value={String(n)}>{'★'.repeat(n)}{'☆'.repeat(5 - n)} ({n})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Comment (optional)</Label>
              <Textarea value={comment} onChange={e => setComment(e.target.value)} rows={2} placeholder="Great with walk-ins, clients loved her." data-testid="input-rating-comment" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRateOpen(false)}>Cancel</Button>
            <Button
              onClick={() =>
                rate.mutate(
                  { id: shift.id, data: { rating: Number(stars), ...(comment.trim() ? { comment: comment.trim() } : {}) } },
                  {
                    onSuccess: () => { invalidate(); setRateOpen(false); toast({ title: 'Rating recorded', description: 'It now counts toward their cross-store average.' }); },
                    onError: (err: any) => toast({ title: 'Could not record rating', description: err?.response?.data?.message || err?.message, variant: 'destructive' }),
                  },
                )
              }
              disabled={rate.isPending}
              data-testid="btn-confirm-rating"
            >
              Submit Rating
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
