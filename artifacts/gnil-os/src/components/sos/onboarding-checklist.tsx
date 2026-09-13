import React from 'react';
import { Link } from 'wouter';
import {
  useGetSosOnboarding,
  getGetSosOnboardingQueryKey,
} from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CheckCircle2, Circle, ExternalLink, Rocket } from 'lucide-react';

/**
 * First-run onboarding checklist for a newly approved business.
 *
 * Server-derived steps (services, staff, hours) come from
 * GET /api/sos/onboarding — completing the underlying action anywhere in the
 * app checks the step off automatically. The "view your booking page" step
 * is client-tracked (per tenant, localStorage) since a page view leaves no
 * server-side record. The whole card disappears once every step is done, so
 * established businesses with data never see it.
 */

const viewedKey = (tenantId: number) => `gnil-onboarding-viewed-booking-${tenantId}`;

export function OnboardingChecklist({
  tenantId,
  bookingSlug,
}: {
  tenantId: number;
  bookingSlug: string | null;
}) {
  const { data: onboarding } = useGetSosOnboarding({
    query: {
      // Key includes the tenant so switching businesses refetches; the
      queryKey: [...getGetSosOnboardingQueryKey(), { tenant: tenantId }],
      // Steps complete elsewhere in the app (services/staff tabs, settings),
      // so keep the done/not-done state live while the checklist is visible.
      refetchInterval: 15_000,
      refetchOnWindowFocus: true,
    },
  });

  const [viewedBookingPage, setViewedBookingPage] = React.useState(
    () => localStorage.getItem(viewedKey(tenantId)) === '1',
  );
  React.useEffect(() => {
    setViewedBookingPage(localStorage.getItem(viewedKey(tenantId)) === '1');
  }, [tenantId]);

  if (!onboarding) return null;
  if (onboarding.complete && viewedBookingPage) return null;

  const bookingUrl = bookingSlug
    ? `${window.location.origin}${import.meta.env.BASE_URL}book/${bookingSlug}`
    : null;

  const steps = [
    {
      key: 'service',
      done: onboarding.addServiceDone,
      title: 'Add your first service',
      description: 'What can customers book? Name it and set a price.',
      action: (
        <Button asChild size="sm" variant="outline" data-testid="button-onboarding-add-service">
          <Link href={`/sos/bookings?tab=services&tenant=${tenantId}`}>Add service</Link>
        </Button>
      ),
    },
    {
      key: 'staff',
      done: onboarding.addStaffDone,
      title: 'Add your staff',
      description: 'Add at least one team member who serves customers.',
      action: (
        <Button asChild size="sm" variant="outline" data-testid="button-onboarding-add-staff">
          <Link href={`/sos/bookings?tab=staff&tenant=${tenantId}`}>Add staff</Link>
        </Button>
      ),
    },
    {
      key: 'hours',
      done: onboarding.confirmHoursDone,
      title: 'Confirm your hours',
      description: 'Save your open and close times — they control which booking slots customers see.',
      action: (
        <Button asChild size="sm" variant="outline" data-testid="button-onboarding-confirm-hours">
          <Link href={`/tenants/${tenantId}/settings#online-booking`}>Set hours</Link>
        </Button>
      ),
    },
    {
      key: 'booking-page',
      done: viewedBookingPage,
      title: 'View your public booking page',
      description: 'See what customers see — then share the link anywhere.',
      action: bookingUrl ? (
        <Button asChild size="sm" variant="outline" data-testid="button-onboarding-view-booking-page">
          <a
            href={bookingUrl}
            target="_blank"
            rel="noreferrer"
            onClick={() => {
              localStorage.setItem(viewedKey(tenantId), '1');
              setViewedBookingPage(true);
            }}
          >
            <ExternalLink className="h-3.5 w-3.5 mr-1.5" /> View page
          </a>
        </Button>
      ) : null,
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;

  return (
    <Card className="border-primary/40" data-testid="card-onboarding-checklist">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            <Rocket className="h-4 w-4 text-primary" /> Get set up for bookings
          </span>
          <span className="text-sm font-normal text-muted-foreground" data-testid="text-onboarding-progress">
            {doneCount} of {steps.length} done
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {steps.map((step) => (
          <div
            key={step.key}
            className="flex items-center justify-between gap-3 p-3 border rounded-lg"
            data-testid={`row-onboarding-${step.key}`}
          >
            <div className="flex items-start gap-3 min-w-0">
              {step.done ? (
                <CheckCircle2
                  className="h-5 w-5 text-primary shrink-0 mt-0.5"
                  data-testid={`icon-onboarding-done-${step.key}`}
                />
              ) : (
                <Circle className="h-5 w-5 text-muted-foreground/50 shrink-0 mt-0.5" />
              )}
              <div className="min-w-0">
                <div className={`text-sm font-medium ${step.done ? 'line-through text-muted-foreground' : ''}`}>
                  {step.title}
                </div>
                <p className="text-xs text-muted-foreground">{step.description}</p>
              </div>
            </div>
            {!step.done && <div className="shrink-0">{step.action}</div>}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
