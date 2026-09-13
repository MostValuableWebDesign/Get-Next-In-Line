import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mutate = vi.fn();

const settings = {
  id: 1,
  businessName: 'Sunrise Clinic',
  industryType: 'Clinic',
  resourceLabel: 'Room',
  aiReceptionistEnabled: true,
  waitlistAutoFillEnabled: false,
  smsFromNumber: '+15551234567',
  smsMode: 'simulated' as const,
  smsActiveFromNumber: null,
  smsInboundWebhookUrl: null,
  smsInboundReady: false,
  updatedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
};

vi.mock('@workspace/api-client-react', () => ({
  useGetSosSettings: () => ({ data: settings, isLoading: false }),
  useUpdateSosSettings: () => ({ mutate, isPending: false }),
  getGetSosSettingsQueryKey: () => ['/api/sos/settings'],
  // Live Twilio webhook console check shown in the SMS section.
  useGetSosTwilioWebhookStatus: () => ({ data: undefined, isLoading: false }),
  getGetSosTwilioWebhookStatusQueryKey: () => ['/api/sos/twilio/webhook-status'],
  // "Send test text" control in the SMS section.
  useSendSosTestSms: () => ({ mutate: vi.fn(), isPending: false }),
  useConfigureSosTwilioWebhook: () => ({ mutate: vi.fn(), isPending: false }),
  useGetCoopTaxonomy: () => ({ data: [], isLoading: false }),
  getGetCoopTaxonomyQueryKey: () => ['/api/coop/taxonomy'],
  // Product Catalog section (folded into Configuration) — empty registry.
  useGetConnectorRegistry: () => ({ data: [], isLoading: false }),
  useGetModulesPricing: () => ({ data: [], isLoading: false }),
}));

import Settings from '../Settings';

function renderSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Settings />
    </QueryClientProvider>,
  );
}

/** The payload of the last mutate call. */
function lastPayload(): Record<string, unknown> {
  expect(mutate).toHaveBeenCalledTimes(1);
  return mutate.mock.calls[0][0].data;
}

describe('Settings per-section partial save', () => {
  beforeEach(() => {
    mutate.mockClear();
  });

  it('renders the unified Configuration screen', () => {
    renderSettings();
    expect(screen.getByText('Configuration')).toBeInTheDocument();
    expect(screen.getByTestId('section-profile')).toBeInTheDocument();
    expect(screen.getByTestId('section-sos-operations')).toBeInTheDocument();
    expect(screen.getByTestId('section-sms')).toBeInTheDocument();
    // Global AI Receptionist setup moved to the unified AI Receptionist view.
    expect(screen.queryByTestId('section-ai-receptionist')).not.toBeInTheDocument();
  });

  it('Save Profile sends only the business-profile fields', () => {
    renderSettings();
    fireEvent.change(screen.getByTestId('input-business-name'), {
      target: { value: 'New Name' },
    });
    fireEvent.click(screen.getByTestId('button-save-profile'));
    expect(lastPayload()).toEqual({
      businessName: 'New Name',
      industryType: 'Clinic',
      resourceLabel: 'Room',
    });
  });

  it('Save SOS Operations sends only waitlistAutoFillEnabled', () => {
    renderSettings();
    fireEvent.click(screen.getByTestId('switch-waitlist-autofill'));
    fireEvent.click(screen.getByTestId('button-save-sos-operations'));
    expect(lastPayload()).toEqual({ waitlistAutoFillEnabled: true });
  });

  it('Save SMS Settings sends only smsFromNumber', () => {
    renderSettings();
    fireEvent.change(screen.getByTestId('input-sms-from-number'), {
      target: { value: '+15559998888' },
    });
    fireEvent.click(screen.getByTestId('button-save-sms'));
    expect(lastPayload()).toEqual({ smsFromNumber: '+15559998888' });
  });

  it('unsaved edits in another section are not sent by a different Save', () => {
    renderSettings();
    // Edit the profile but save only the SMS section.
    fireEvent.change(screen.getByTestId('input-business-name'), {
      target: { value: 'Unsaved Edit' },
    });
    fireEvent.click(screen.getByTestId('button-save-sms'));
    const payload = lastPayload();
    expect(payload).not.toHaveProperty('businessName');
    expect(Object.keys(payload)).toEqual(['smsFromNumber']);
  });
});
