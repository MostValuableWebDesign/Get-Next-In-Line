import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Marketing Hub — generator/composer + approval inbox + history flows with
// the API client mocked out.

const respondMutate = vi.fn();
const dispatchMutate = vi.fn();
const createMutate = vi.fn();
const suggestMutate = vi.fn();

let campaigns: Array<Record<string, unknown>> = [];
let channels: Array<Record<string, unknown>> = [];

const templates = [
  { slug: 'instagram_square', label: 'Instagram Square', description: '', width: 1080, height: 1080, channel: 'instagram' },
  { slug: 'sms_blast', label: 'SMS Blast Text', description: '', width: null, height: null, channel: 'sms' },
];
const partnerships = [
  {
    id: 7, hostTenantId: 1, partnerTenantId: 2, perkTitle: 'Coffee + Yoga',
    status: 'accepted', isActive: true,
  },
];
const branding = {
  partnershipId: 7,
  perkTitle: 'Coffee + Yoga',
  host: { tenantId: 1, name: 'Bakery', logoUrl: '', primaryColor: '#112233', secondaryColor: '#445566' },
  partner: { tenantId: 2, name: 'Studio', logoUrl: '', primaryColor: '#223344', secondaryColor: '#556677' },
};

vi.mock('@workspace/api-client-react', () => ({
  useListCoopMarketingTemplates: () => ({ data: templates }),
  getListCoopMarketingTemplatesQueryKey: () => ['/api/coop/marketing/templates'],
  useGetCoopMarketingBranding: () => ({ data: branding }),
  getGetCoopMarketingBrandingQueryKey: () => ['/api/coop/marketing/branding'],
  useListCoopMarketingChannels: () => ({ data: channels }),
  getListCoopMarketingChannelsQueryKey: () => ['/api/coop/marketing/channels'],
  useCreateCoopMarketingChannel: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteCoopMarketingChannel: () => ({ mutate: vi.fn(), isPending: false }),
  useSuggestCoopMarketingCopy: () => ({ mutate: suggestMutate, isPending: false }),
  useListCoopMarketingCampaigns: () => ({ data: campaigns, isLoading: false }),
  getListCoopMarketingCampaignsQueryKey: () => ['/api/coop/marketing/campaigns'],
  useCreateCoopMarketingCampaign: () => ({ mutate: createMutate, isPending: false }),
  useRespondToCoopMarketingCampaign: () => ({ mutate: respondMutate, isPending: false }),
  useDispatchCoopMarketingCampaign: () => ({ mutate: dispatchMutate, isPending: false }),
  useGetCoopMarketingCampaignAnalytics: () => ({
    data: {
      entries: [
        {
          tenantId: 1, tenantName: 'Bakery', channel: 'sms', status: 'simulated',
          simulated: true, recipients: 3, delivered: 2, failed: 0, skipped: 1,
          impressions: 2, clicks: 5, linkCode: 'mkabc',
        },
      ],
      totals: { delivered: 2, failed: 0, clicks: 5, reach: 2, simulatedReach: 2 },
    },
    isLoading: false,
  }),
  getGetCoopMarketingCampaignAnalyticsQueryKey: (id: number) => ['/api/coop/marketing/campaigns', id, 'analytics'],
  useListCoopPartnerships: () => ({ data: partnerships }),
  getListCoopPartnershipsQueryKey: () => ['/api/coop/partnerships'],
}));

import { CoopMarketingSection } from '../coop-marketing-content';

const campaign = (over: Partial<Record<string, unknown>>) => ({
  id: 10,
  name: 'Joint promo',
  partnershipId: 7,
  templateSlug: 'instagram_square',
  headline: 'Better Together',
  bodyText: '',
  smsText: '',
  assetPayload: {},
  channels: [{ tenantId: 1, channel: 'sms' }],
  scheduledAt: null,
  status: 'pending_approval',
  creatorTenantId: 2,
  creatorTenantName: 'Studio',
  isCreator: false,
  myApproval: 'pending',
  dispatchTriggeredAt: null,
  participants: [
    { tenantId: 2, tenantName: 'Studio', approval: 'approved', respondedAt: null },
    { tenantId: 1, tenantName: 'Bakery', approval: 'pending', respondedAt: null },
  ],
  createdAt: '2026-07-01T10:00:00Z',
  ...over,
});

function renderIt() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CoopMarketingSection tenantId={1} />
    </QueryClientProvider>,
  );
}

describe('CoopMarketingSection', () => {
  beforeEach(() => {
    respondMutate.mockClear();
    dispatchMutate.mockClear();
    createMutate.mockClear();
    campaigns = [];
    channels = [];
  });

  it('shows the empty state and channel connect controls', () => {
    renderIt();
    expect(screen.getByTestId('text-no-marketing-campaigns')).toBeInTheDocument();
    expect(screen.getByTestId('text-no-channels')).toBeInTheDocument();
    expect(screen.getByTestId('button-connect-channel')).toBeInTheDocument();
  });

  it('surfaces a pending campaign in the approval inbox with approve/decline', () => {
    campaigns = [campaign({})];
    renderIt();
    expect(screen.getByTestId('list-marketing-approvals')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('button-approve-marketing-10'));
    expect(respondMutate).toHaveBeenCalledWith({ id: 10, data: { action: 'approve' } });
    fireEvent.click(screen.getByTestId('button-decline-marketing-10'));
    expect(respondMutate).toHaveBeenCalledWith({ id: 10, data: { action: 'decline' } });
  });

  it('lets the creator send an approved immediate campaign', () => {
    campaigns = [
      campaign({
        isCreator: true, creatorTenantId: 1, myApproval: 'approved', status: 'scheduled',
        participants: [
          { tenantId: 1, tenantName: 'Bakery', approval: 'approved', respondedAt: null },
          { tenantId: 2, tenantName: 'Studio', approval: 'approved', respondedAt: null },
        ],
      }),
    ];
    renderIt();
    fireEvent.click(screen.getByTestId('button-dispatch-marketing-10'));
    expect(dispatchMutate).toHaveBeenCalledWith({ id: 10 });
  });

  it('shows the analytics ledger for a sent campaign with simulated reach flagged', () => {
    campaigns = [campaign({ status: 'sent', dispatchTriggeredAt: '2026-07-02T10:00:00Z' })];
    renderIt();
    fireEvent.click(screen.getByTestId('button-analytics-marketing-10'));
    const panel = screen.getByTestId('analytics-marketing-10');
    expect(panel).toHaveTextContent('Reach 2');
    expect(panel).toHaveTextContent('(2 simulated)');
    expect(panel).toHaveTextContent('5 clicks');
  });

  it('opens the generator, suggests copy, and creates a campaign with chosen channels', () => {
    renderIt();
    fireEvent.click(screen.getByTestId('button-open-marketing-generator'));
    expect(screen.getByTestId('select-marketing-partnership')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('button-suggest-copy'));
    expect(suggestMutate).toHaveBeenCalledWith({
      data: { partnershipId: 7, templateSlug: 'instagram_square', offerText: '' },
    });
    fireEvent.change(screen.getByTestId('input-marketing-name'), {
      target: { value: 'Fall promo' },
    });
    fireEvent.click(screen.getByTestId('checkbox-target-1-sms'));
    fireEvent.click(screen.getByTestId('button-create-marketing-campaign'));
    expect(createMutate).toHaveBeenCalledTimes(1);
    const arg = createMutate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(arg.data.name).toBe('Fall promo');
    expect(arg.data.partnershipId).toBe(7);
    expect(arg.data.channels).toEqual([{ tenantId: 1, channel: 'sms' }]);
    expect(arg.data.scheduledAt).toBeNull();
  });
});
