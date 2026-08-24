import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  createCheckIn: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock('@workspace/api-client-react', () => ({
  useGetPublicCheckInConfig: hooks.getConfig,
  useCreatePublicCheckIn: hooks.createCheckIn,
}));

import PublicCheckInPage from '../public-checkin';

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
});