import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getStatus: vi.fn(),
  createCheckIn: vi.fn(),
  mutate: vi.fn(),
}));
const TRACKING_TOKEN = 'GgVdXhy3SITVEJ2hlFdmd-QHPucA-aOs72a3jJp3a5I';

vi.mock('@workspace/api-client-react', () => ({
  useGetPublicCheckInConfig: hooks.getConfig,
  useGetPublicCheckInStatus: hooks.getStatus,
  getGetPublicCheckInStatusQueryKey: (slug: string, visitId: number) => [
    `/api/public/check-in/${slug}/status/${visitId}`,
  ],
  useCreatePublicCheckIn: hooks.createCheckIn,
}));

import PublicCheckInPage, {
  PublicCheckInStatusPage,
  PublicCheckInStatusUnavailablePage,
} from '../public-checkin';

const config = {
  slug: 'review-shop',
  brandName: 'Get Next In Line',
  businessName: 'Review Shop',
  capacityStatus: 'available' as const,
  services: [
    {
      id: 88,
      name: 'Queue Service',
      category: null,
      description: 'A service reviewers can choose.',
      price: null,
      durationMinutes: 30,
    },
  ],
};

beforeEach(() => {
  hooks.mutate.mockReset();
  hooks.getConfig.mockReturnValue({ data: config, isLoading: false, isError: false });
  hooks.getStatus.mockReturnValue({
    data: {
      visitId: 41,
      serviceType: 'Queue Service',
      businessName: 'Review Shop',
      status: 'checked_in',
      queuePosition: 2,
      estimatedWaitMinutes: 30,
      checkedInAt: '2026-08-25T12:00:00.000Z',
      trackingUrl: `https://www.getnextinline.com/check-in/review-shop/status/41#${TRACKING_TOKEN}`,
    },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  });
  hooks.createCheckIn.mockReturnValue({ mutate: hooks.mutate, isPending: false });
});

describe('PublicCheckInPage', () => {
  it('shows an unchecked, optional SMS opt-in with required disclosures and legal links', () => {
    render(<PublicCheckInPage slug="review-shop" />);

    expect(screen.getByTestId('text-public-checkin-business-name')).toHaveTextContent('Review Shop');
    const checkbox = screen.getByTestId('checkbox-public-checkin-sms-consent');
    expect(checkbox).toHaveAttribute('data-state', 'unchecked');
    expect(screen.getByText(/Optional SMS queue updates/i)).toBeVisible();
    expect(screen.getByText(/transactional text messages/i)).toBeVisible();
    expect(screen.getByText(/Message frequency varies/i)).toBeVisible();
    expect(screen.getByText(/Message and data rates may apply/i)).toBeVisible();
    expect(screen.getByText(/Reply STOP to opt out or HELP for help/i)).toBeVisible();
    expect(screen.getByTestId('link-public-checkin-sms-privacy')).toHaveAttribute(
      'href',
      'https://www.getnextinline.com/privacy',
    );
    expect(screen.getByTestId('link-public-checkin-sms-terms')).toHaveAttribute(
      'href',
      'https://www.getnextinline.com/terms',
    );
  });

  it('submits the selected service and affirmative consent only after the customer completes the form', async () => {
    const user = userEvent.setup();
    render(<PublicCheckInPage slug="review-shop" />);

    const submit = screen.getByTestId('button-public-checkin-submit');
    expect(submit).toBeDisabled();
    expect(screen.getByTestId('text-public-checkin-form-help')).toHaveTextContent(/enter your name/i);
    expect(screen.getByTestId('text-public-checkin-form-help')).toHaveTextContent(/enter your mobile number/i);

    await user.click(screen.getByTestId('button-public-checkin-service-88'));
    await user.type(screen.getByTestId('input-public-checkin-name'), 'Queue Reviewer');
    await user.type(screen.getByTestId('input-public-checkin-phone'), '+15551234567');
    await user.click(screen.getByTestId('checkbox-public-checkin-sms-consent'));
    await user.click(submit);

    expect(hooks.mutate).toHaveBeenCalledWith(
      {
        slug: 'review-shop',
        data: {
          serviceId: 88,
          name: 'Queue Reviewer',
          phone: '+15551234567',
          partySize: 1,
          smsOptIn: true,
        },
      },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
  });

  it('shows the queue position, wait estimate, and tracking link after a successful check-in', async () => {
    const user = userEvent.setup();
    hooks.mutate.mockImplementationOnce((_variables, options) => {
      options.onSuccess({
        visitId: 41,
        serviceType: 'Queue Service',
        businessName: 'Review Shop',
        checkedInAt: '2026-08-25T12:00:00.000Z',
        queuePosition: 2,
        estimatedWaitMinutes: 30,
        trackingUrl: `https://www.getnextinline.com/check-in/review-shop/status/41#${TRACKING_TOKEN}`,
      });
    });

    render(<PublicCheckInPage slug="review-shop" />);

    await user.type(screen.getByTestId('input-public-checkin-name'), 'Queue Reviewer');
    await user.type(screen.getByTestId('input-public-checkin-phone'), '+15551234567');
    await user.click(screen.getByTestId('button-public-checkin-submit'));

    expect(screen.getByTestId('card-public-checkin-queue-details')).toHaveTextContent('#2');
    expect(screen.getByTestId('card-public-checkin-queue-details')).toHaveTextContent(/About 30 min/i);
    expect(screen.getByTestId('link-public-checkin-track-status')).toHaveAttribute(
      'href',
      `https://www.getnextinline.com/check-in/review-shop/status/41#${TRACKING_TOKEN}`,
    );
  });

  it('renders the refreshable public queue status page', () => {
    render(<PublicCheckInStatusPage slug="review-shop" visitId={41} token={TRACKING_TOKEN} />);

    expect(screen.getByTestId('card-public-checkin-status')).toHaveTextContent(/You’re checked in/i);
    expect(screen.getByTestId('card-public-checkin-queue-details')).toHaveTextContent('#2');
    expect(screen.getByRole('button', { name: /refresh status/i })).toBeEnabled();
  });

  it('keeps incomplete tracking links on a public not-found screen', () => {
    render(<PublicCheckInStatusUnavailablePage />);

    expect(screen.getByRole('heading', { name: /check-in not found/i })).toBeVisible();
    expect(screen.getByText(/incomplete or no longer available/i)).toBeVisible();
  });
});