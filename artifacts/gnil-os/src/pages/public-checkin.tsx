import React, { useState } from 'react';
import {
  useCreatePublicCheckIn,
  useGetPublicCheckInConfig,
  type PublicCheckInConfig,
  type PublicCheckInConfirmation,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { CheckCircle2, Clock3, MessageSquareText, Users } from 'lucide-react';
import { PRIVACY_POLICY_URL } from './privacy-policy';

const TERMS_URL = 'https://www.getnextinline.com/terms';

function smsConsentText(businessName: string) {
  return `I agree to receive transactional text messages from ${businessName} and Get Next In Line about my digital check-in and queue status. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. Consent is not a condition of purchase.`;
}

/**
 * Public, no-login digital queue check-in flow. This is intentionally a
 * standalone CTA at /check-in/:slug so a customer—and an A2P reviewer—can
 * see the optional SMS consent disclosure before submitting a queue visit.
 */
export default function PublicCheckInPage({ slug }: { slug: string }) {
  const { data: config, isLoading, isError } = useGetPublicCheckInConfig(slug);

  if (isLoading) {
    return (
      <PublicCheckInShell>
        <div className="space-y-4 p-5">
          <Skeleton className="h-7 w-2/3" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </PublicCheckInShell>
    );
  }

  if (isError || !config) {
    return (
      <PublicCheckInShell>
        <div className="space-y-2 p-8 text-center" data-testid="text-public-checkin-not-found">
          <h1 className="text-xl font-semibold">Business not found</h1>
          <p className="text-sm text-muted-foreground">
            This check-in link doesn't match an active business. Double-check the address.
          </p>
        </div>
      </PublicCheckInShell>
    );
  }

  return (
    <PublicCheckInShell>
      <CheckInFlow config={config} slug={slug} />
    </PublicCheckInShell>
  );
}

function PublicCheckInShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="mx-auto max-w-lg">
        {children}
        <footer className="pb-2 pt-6 text-center text-xs text-muted-foreground">
          <a
            href={PRIVACY_POLICY_URL}
            className="underline underline-offset-2 transition-colors hover:text-foreground"
            data-testid="link-public-checkin-privacy-footer"
          >
            Privacy Policy
          </a>
          <span aria-hidden="true"> · </span>
          <a
            href={TERMS_URL}
            className="underline underline-offset-2 transition-colors hover:text-foreground"
            data-testid="link-public-checkin-terms-footer"
          >
            Terms
          </a>
        </footer>
      </div>
    </main>
  );
}

function CheckInFlow({ config, slug }: { config: PublicCheckInConfig; slug: string }) {
  const [serviceId, setServiceId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [partySize, setPartySize] = useState('1');
  const [smsOptIn, setSmsOptIn] = useState(false);
  const [confirmation, setConfirmation] = useState<PublicCheckInConfirmation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const checkIn = useCreatePublicCheckIn();

  const businessName = config.businessName || config.brandName;
  const selectedService = config.services.find((service) => service.id === serviceId);
  const validPartySize = Number.parseInt(partySize, 10);

  const submit = () => {
    if (!serviceId || !name.trim() || !phone.trim() || !Number.isInteger(validPartySize)) return;
    setError(null);
    checkIn.mutate(
      {
        slug,
        data: {
          serviceId,
          name: name.trim(),
          phone: phone.trim(),
          partySize: validPartySize,
          smsOptIn,
        },
      },
      {
        onSuccess: (result) => setConfirmation(result),
        onError: (err: unknown) => {
          const message =
            (err as { data?: { message?: string } })?.data?.message ??
            "We couldn't complete your check-in. Please try again.";
          setError(message);
        },
      },
    );
  };

  if (confirmation) {
    return (
      <section className="space-y-5">
        <CheckInHeader businessName={businessName} capacityStatus={config.capacityStatus} />
        <Card data-testid="card-public-checkin-confirmed">
          <CardContent className="space-y-3 pt-6 text-center">
            <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-500" />
            <h2 className="text-xl font-semibold">You're checked in!</h2>
            <p className="text-sm text-muted-foreground">
              You're in the queue for <span className="font-medium text-foreground">{confirmation.serviceType}</span> at{' '}
              {confirmation.businessName}.
            </p>
            {smsOptIn && (
              <p className="text-sm text-muted-foreground">
                We'll send transactional queue updates to your mobile number.
              </p>
            )}
            <Button
              variant="outline"
              onClick={() => {
                setConfirmation(null);
                setServiceId(null);
                setName('');
                setPhone('');
                setPartySize('1');
                setSmsOptIn(false);
              }}
              data-testid="button-public-checkin-another"
            >
              Check in another guest
            </Button>
          </CardContent>
        </Card>
      </section>
    );
  }

  return (
    <section className="space-y-5">
      <CheckInHeader businessName={businessName} capacityStatus={config.capacityStatus} />
      <Card>
        <CardContent className="space-y-5 pt-6">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">Join the queue</h2>
            <p className="text-sm text-muted-foreground">
              Enter your details below to check in before you arrive.
            </p>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">What are you here for?</legend>
            {config.services.length === 0 ? (
              <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                This business hasn't published services for online check-in yet.
              </p>
            ) : (
              <div className="grid gap-2" data-testid="list-public-checkin-services">
                {config.services.map((service) => (
                  <button
                    key={service.id}
                    type="button"
                    onClick={() => setServiceId(service.id)}
                    className={`rounded-md border px-3 py-3 text-left transition-colors ${
                      serviceId === service.id
                        ? 'border-primary bg-primary/5 ring-1 ring-primary'
                        : 'hover:border-primary/50'
                    }`}
                    aria-pressed={serviceId === service.id}
                    data-testid={`button-public-checkin-service-${service.id}`}
                  >
                    <span className="block font-medium">{service.name}</span>
                    {service.description && (
                      <span className="mt-0.5 block text-xs text-muted-foreground">{service.description}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="public-checkin-name">Your name</Label>
              <Input
                id="public-checkin-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Jane Doe"
                autoComplete="name"
                data-testid="input-public-checkin-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="public-checkin-party-size">Guests</Label>
              <Input
                id="public-checkin-party-size"
                type="number"
                min="1"
                max="20"
                value={partySize}
                onChange={(event) => setPartySize(event.target.value)}
                data-testid="input-public-checkin-party-size"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="public-checkin-phone">Mobile phone</Label>
            <Input
              id="public-checkin-phone"
              type="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="(555) 123-4567"
              autoComplete="tel"
              data-testid="input-public-checkin-phone"
            />
            <p className="text-xs text-muted-foreground">
              We use this to identify your queue check-in. SMS updates are optional below.
            </p>
          </div>

          <div className="flex items-start gap-3 rounded-md border border-slate-200 bg-slate-50 p-3">
            <Checkbox
              id="public-checkin-sms-consent"
              checked={smsOptIn}
              onCheckedChange={(checked) => setSmsOptIn(checked === true)}
              data-testid="checkbox-public-checkin-sms-consent"
            />
            <div className="space-y-1">
              <Label
                htmlFor="public-checkin-sms-consent"
                className="cursor-pointer text-xs font-normal leading-relaxed text-muted-foreground"
              >
                <span className="font-medium text-foreground">Optional SMS queue updates.</span>{' '}
                {smsConsentText(businessName)}{' '}
                <a
                  href={PRIVACY_POLICY_URL}
                  className="whitespace-nowrap text-primary underline underline-offset-2 hover:text-primary/80"
                  data-testid="link-public-checkin-sms-privacy"
                >
                  Privacy Policy
                </a>{' '}
                and{' '}
                <a
                  href={TERMS_URL}
                  className="whitespace-nowrap text-primary underline underline-offset-2 hover:text-primary/80"
                  data-testid="link-public-checkin-sms-terms"
                >
                  Terms
                </a>
                .
              </Label>
            </div>
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert" data-testid="text-public-checkin-error">
              {error}
            </p>
          )}

          <Button
            className="w-full"
            onClick={submit}
            disabled={
              !selectedService ||
              !name.trim() ||
              !phone.trim() ||
              !Number.isInteger(validPartySize) ||
              validPartySize < 1 ||
              validPartySize > 20 ||
              checkIn.isPending
            }
            data-testid="button-public-checkin-submit"
          >
            {checkIn.isPending ? 'Checking you in…' : 'Join the queue'}
          </Button>
        </CardContent>
      </Card>
    </section>
  );
}

function CheckInHeader({
  businessName,
  capacityStatus,
}: {
  businessName: string;
  capacityStatus: PublicCheckInConfig['capacityStatus'];
}) {
  const capacityCopy = {
    available: 'Open now — check in online',
    moderate: 'Moderately busy right now',
    busy: 'Very busy right now — a wait is likely',
  } as const;

  return (
    <header className="space-y-2 text-center">
      <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Users className="h-5 w-5" />
      </div>
      <h1 className="text-2xl font-bold tracking-tight" data-testid="text-public-checkin-business-name">
        {businessName}
      </h1>
      <p className="text-sm text-muted-foreground">Digital queue check-in</p>
      {capacityStatus && (
        <p className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Clock3 className="h-3.5 w-3.5" />
          {capacityCopy[capacityStatus]}
        </p>
      )}
      <p className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
        <MessageSquareText className="h-3.5 w-3.5" />
        SMS updates are optional.
      </p>
    </header>
  );
}