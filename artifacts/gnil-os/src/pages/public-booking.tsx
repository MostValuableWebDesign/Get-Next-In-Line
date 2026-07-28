import React, { useEffect, useState } from 'react';
import { useSearch } from 'wouter';
import {
  useGetPublicBookingConfig,
  useGetPublicBookingAvailability,
  useCreatePublicBooking,
  useListPublicBookingPerks, getListPublicBookingPerksQueryKey,
  type PublicBookingConfig,
  type PublicTimeSlot,
  type PublicBookingConfirmation,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Calendar, CheckCircle2, ChevronLeft, Clock, User, Scissors, Users,
} from 'lucide-react';

/**
 * Public, no-login booking flow: pick a service → optionally a staff
 * member → an available time slot → confirm with just name + phone/email.
 * Served at /book/:slug (slug = the business's subdomain) and, with
 * ?embed=1, as the compact variant rendered inside the embeddable iframe
 * widget on external websites.
 */

type Step = 'service' | 'staff' | 'time' | 'details' | 'done';

const fmtPrice = (p: number | null | undefined) =>
  p == null ? null : `$${p.toFixed(2)}`;

function todayYmd(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export default function PublicBookingPage({ slug }: { slug: string }) {
  const embed = new URLSearchParams(useSearch()).get('embed') === '1';
  const { data: config, isLoading, isError } = useGetPublicBookingConfig(slug);

  if (isLoading) {
    return (
      <PublicShell embed={embed}>
        <div className="space-y-3 p-4">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      </PublicShell>
    );
  }
  if (isError || !config) {
    return (
      <PublicShell embed={embed}>
        <div className="p-8 text-center space-y-2" data-testid="text-public-booking-not-found">
          <h1 className="text-xl font-semibold">Business not found</h1>
          <p className="text-sm text-muted-foreground">
            This booking link doesn't match any business. Double-check the address.
          </p>
        </div>
      </PublicShell>
    );
  }
  return (
    <PublicShell embed={embed}>
      <BookingFlow config={config} slug={slug} />
    </PublicShell>
  );
}

function PublicShell({ embed, children }: { embed: boolean; children: React.ReactNode }) {
  return (
    <div className={embed ? 'min-h-screen bg-background' : 'min-h-screen bg-slate-50'}>
      <div className={embed ? 'max-w-lg mx-auto' : 'max-w-lg mx-auto px-4 py-8'}>
        {children}
      </div>
    </div>
  );
}

function BookingFlow({ config, slug }: { config: PublicBookingConfig; slug: string }) {
  const [step, setStep] = useState<Step>('service');
  const [serviceId, setServiceId] = useState<number | null>(null);
  const [staffId, setStaffId] = useState<number | null>(null); // null = anyone
  const [date, setDate] = useState<string>(todayYmd());
  const [slot, setSlot] = useState<PublicTimeSlot | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [confirmation, setConfirmation] = useState<PublicBookingConfirmation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const service = config.services.find(s => s.id === serviceId) ?? null;
  const staff = config.staff.find(s => s.id === staffId) ?? null;

  const availability = useGetPublicBookingAvailability();
  const book = useCreatePublicBooking();

  // Refresh slots whenever the time step's inputs change.
  useEffect(() => {
    if (step !== 'time' || serviceId == null) return;
    setSlot(null);
    availability.mutate({
      slug,
      data: { serviceId, date, ...(staffId != null ? { resourceId: staffId } : {}) },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, serviceId, staffId, date, slug]);

  const slots = availability.data?.slots ?? [];

  const handleConfirm = () => {
    if (!service || !slot || !name.trim() || (!phone.trim() && !email.trim())) return;
    setError(null);
    book.mutate(
      {
        slug,
        data: {
          serviceId: service.id,
          startsAt: slot.startsAt,
          ...(staffId != null ? { resourceId: staffId } : {}),
          name: name.trim(),
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          ...(email.trim() ? { email: email.trim() } : {}),
        },
      },
      {
        onSuccess: (res) => {
          setConfirmation(res);
          setStep('done');
        },
        onError: (err: unknown) => {
          const msg =
            (err as { data?: { message?: string } })?.data?.message ??
            "Couldn't complete your booking. Please try another time slot.";
          setError(msg);
        },
      },
    );
  };

  const header = (
    <div className="text-center space-y-1 mb-6">
      <h1 className="text-2xl font-bold tracking-tight" data-testid="text-public-business-name">
        {config.businessName || config.brandName}
      </h1>
      <p className="text-sm text-muted-foreground">Book your appointment online</p>
      {config.capacityStatus && (
        <p
          className={`text-xs font-medium inline-flex items-center gap-1.5 ${
            config.capacityStatus === 'busy'
              ? 'text-red-600'
              : config.capacityStatus === 'moderate'
                ? 'text-amber-600'
                : 'text-emerald-600'
          }`}
          data-testid="text-public-capacity-status"
        >
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              config.capacityStatus === 'busy'
                ? 'bg-red-500'
                : config.capacityStatus === 'moderate'
                  ? 'bg-amber-500'
                  : 'bg-emerald-500'
            }`}
          />
          {config.capacityStatus === 'busy'
            ? 'Very busy right now — long wait likely'
            : config.capacityStatus === 'moderate'
              ? 'Moderately busy right now'
              : 'Open — plenty of availability'}
        </p>
      )}
    </div>
  );

  if (step === 'done' && confirmation) {
    const d = new Date(confirmation.startsAt);
    return (
      <div>
        {header}
        <Card data-testid="card-booking-confirmed">
          <CardContent className="pt-6 text-center space-y-3">
            <CheckCircle2 className="h-12 w-12 text-emerald-500 mx-auto" />
            <h2 className="text-lg font-semibold">You're booked!</h2>
            <div className="text-sm text-muted-foreground space-y-1">
              <p className="font-medium text-foreground">{confirmation.serviceType}</p>
              {confirmation.staffName && <p>with {confirmation.staffName}</p>}
              <p>
                {d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
                {' at '}
                {d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              </p>
              <p>at {confirmation.businessName}</p>
            </div>
            <Button
              variant="outline"
              className="mt-2"
              onClick={() => {
                setStep('service');
                setServiceId(null); setStaffId(null); setSlot(null);
                setName(''); setPhone(''); setEmail(''); setConfirmation(null);
              }}
              data-testid="button-book-another"
            >
              Book another appointment
            </Button>
          </CardContent>
        </Card>
        <ConfirmationPerks slug={slug} />
      </div>
    );
  }

  return (
    <div>
      {header}
      <StepBreadcrumb step={step} onBack={(s) => { setError(null); setStep(s); }} />

      {step === 'service' && (
        <div className="space-y-2" data-testid="list-public-services">
          {config.services.length === 0 ? (
            <Card><CardContent className="pt-6 text-center text-sm text-muted-foreground">
              This business hasn't published its service menu yet.
            </CardContent></Card>
          ) : (
            config.services.map(s => (
              <button
                key={s.id}
                className="w-full text-left"
                onClick={() => { setServiceId(s.id); setStep(config.staff.length > 0 ? 'staff' : 'time'); }}
                data-testid={`button-public-service-${s.id}`}
              >
                <Card className="hover:border-primary transition-colors">
                  <CardContent className="py-4 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{s.name}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {[s.durationMinutes ? `${s.durationMinutes} min` : null, s.description]
                          .filter(Boolean).join(' • ')}
                      </div>
                    </div>
                    {fmtPrice(s.price) && (
                      <span className="text-sm font-semibold shrink-0">{fmtPrice(s.price)}</span>
                    )}
                  </CardContent>
                </Card>
              </button>
            ))
          )}
        </div>
      )}

      {step === 'staff' && (
        <div className="space-y-2" data-testid="list-public-staff">
          <button className="w-full text-left" onClick={() => { setStaffId(null); setStep('time'); }} data-testid="button-public-staff-any">
            <Card className="hover:border-primary transition-colors">
              <CardContent className="py-4 flex items-center gap-3">
                <Users className="h-5 w-5 text-muted-foreground" />
                <div>
                  <div className="font-medium">No preference</div>
                  <div className="text-xs text-muted-foreground">First available {config.resourceLabel.toLowerCase()}</div>
                </div>
              </CardContent>
            </Card>
          </button>
          {config.staff.map(m => (
            <button key={m.id} className="w-full text-left" onClick={() => { setStaffId(m.id); setStep('time'); }} data-testid={`button-public-staff-${m.id}`}>
              <Card className="hover:border-primary transition-colors">
                <CardContent className="py-4 flex items-center gap-3">
                  <User className="h-5 w-5 text-muted-foreground" />
                  <div className="font-medium">{m.name}</div>
                </CardContent>
              </Card>
            </button>
          ))}
        </div>
      )}

      {step === 'time' && (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="public-date">Date</Label>
            <Input
              id="public-date"
              type="date"
              min={todayYmd()}
              max={todayYmd(90)}
              value={date}
              onChange={e => setDate(e.target.value)}
              data-testid="input-public-date"
            />
          </div>
          {availability.isPending ? (
            <div className="grid grid-cols-3 gap-2">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
            </div>
          ) : slots.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6" data-testid="text-public-no-slots">
              No open times on this day. Try another date.
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-2" data-testid="grid-public-slots">
              {slots.map(s => (
                <Button
                  key={s.startsAt}
                  variant="outline"
                  onClick={() => { setSlot(s); setStep('details'); }}
                  data-testid={`button-public-slot-${s.startsAt}`}
                >
                  {new Date(s.startsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}

      {step === 'details' && service && slot && (
        <div className="space-y-4">
          <Card>
            <CardContent className="py-4 text-sm space-y-1">
              <div className="flex items-center gap-2 font-medium">
                <Scissors className="h-4 w-4 text-muted-foreground" /> {service.name}
              </div>
              {staff && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <User className="h-4 w-4" /> {staff.name}
                </div>
              )}
              <div className="flex items-center gap-2 text-muted-foreground">
                <Calendar className="h-4 w-4" />
                {new Date(slot.startsAt).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
              </div>
              <div className="flex items-center gap-2 text-muted-foreground">
                <Clock className="h-4 w-4" />
                {new Date(slot.startsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              </div>
            </CardContent>
          </Card>
          <div className="space-y-2">
            <Label htmlFor="public-name">Your name</Label>
            <Input id="public-name" value={name} onChange={e => setName(e.target.value)} placeholder="Jane Doe" data-testid="input-public-name" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="public-phone">Phone</Label>
            <Input id="public-phone" type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="(555) 123-4567" data-testid="input-public-phone" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="public-email">Email</Label>
            <Input id="public-email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="jane@example.com" data-testid="input-public-email" />
            <p className="text-xs text-muted-foreground">We need a phone number or email to confirm your booking.</p>
          </div>
          {error && (
            <p className="text-sm text-destructive" data-testid="text-public-booking-error">{error}</p>
          )}
          <Button
            className="w-full"
            onClick={handleConfirm}
            disabled={book.isPending || !name.trim() || (!phone.trim() && !email.trim())}
            data-testid="button-public-confirm"
          >
            {book.isPending ? 'Booking…' : 'Confirm booking'}
          </Button>
        </div>
      )}
    </div>
  );
}

const STEP_ORDER: Step[] = ['service', 'staff', 'time', 'details'];
const STEP_LABELS: Record<string, string> = {
  service: 'Service', staff: 'Staff', time: 'Time', details: 'Your details',
};

function StepBreadcrumb({ step, onBack }: { step: Step; onBack: (s: Step) => void }) {
  const idx = STEP_ORDER.indexOf(step);
  if (idx <= 0) return <p className="text-sm font-medium mb-3">Choose a service</p>;
  return (
    <div className="flex items-center gap-2 mb-3">
      <Button variant="ghost" size="sm" onClick={() => onBack(STEP_ORDER[idx - 1])} data-testid="button-public-back">
        <ChevronLeft className="h-4 w-4 mr-1" /> Back
      </Button>
      <p className="text-sm font-medium">{STEP_LABELS[step]}</p>
    </div>
  );
}

/**
 * Partner perks shown on the post-booking confirmation screen. Featured
 * (sponsored) perks render highlighted above organic matches; when a boost
 * expires the perk falls back to organic placement automatically.
 */
function ConfirmationPerks({ slug }: { slug: string }) {
  const { data } = useListPublicBookingPerks(slug, {
    query: { queryKey: getListPublicBookingPerksQueryKey(slug) },
  });
  const perks = data?.perks ?? [];
  if (perks.length === 0) return null;
  return (
    <Card className="mt-4" data-testid="card-confirmation-perks">
      <CardContent className="pt-6 space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Neighborhood perks for you
        </h3>
        <div className="space-y-2">
          {perks.map(perk => (
            <div
              key={perk.id}
              className={`rounded-lg border p-3 text-sm ${
                perk.featured
                  ? 'border-amber-400/80 bg-amber-100/50 dark:bg-amber-900/20'
                  : ''
              }`}
              data-testid={`row-confirmation-perk-${perk.id}`}
            >
              {perk.featured && (
                <span
                  className="mb-1 inline-block text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400"
                  data-testid={`badge-confirmation-featured-${perk.id}`}
                >
                  ★ Featured partner
                </span>
              )}
              <div className="font-medium">{perk.perkTitle}</div>
              <div className="text-muted-foreground text-xs mt-0.5">
                Courtesy of {perk.partnerName}
                {perk.perkEndsAt && ` · through ${new Date(perk.perkEndsAt).toLocaleDateString()}`}
              </div>
            </div>
          ))}
        </div>
        {data?.disclaimer && (
          <p className="text-[10px] leading-snug text-muted-foreground border-t pt-2">
            {data.disclaimer}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
