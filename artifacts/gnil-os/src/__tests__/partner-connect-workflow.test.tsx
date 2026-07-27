/**
 * Partner card integration workflow (connect → authorize → active):
 *  - a card with a partnerId launches the PartnerConnectDialog instead of the
 *    checkout flow, walking the handshake: Connect → Authorize Connection;
 *  - the CTA reflects live connection state (Activate Module / Continue
 *    Activation / Manage Connection) and shows the connection status badge;
 *  - the dialog surfaces last-sync info, audit history, and Disconnect when
 *    active — and never renders credential material.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StaticPlaceholderPage } from '@/components/static-page';

const modules = [
  {
    id: 20,
    name: 'Global Team & HR Management',
    category: 'Partner-Direct Integrations',
    categorySlug: 'partners',
    description: 'partner module',
    isActive: true,
    wholesalePrice: 0,
    partnerBrand: 'Deel',
  },
];

let statusData: any = {
  partnerId: 'deel',
  moduleId: 20,
  moduleName: modules[0].name,
  partnerBrand: 'Deel',
  status: 'not_connected',
  lastSyncAt: null,
  connectedAt: null,
  lastError: null,
  events: [],
};

const connectMutate = vi.fn();
const authorizeMutate = vi.fn();
const disconnectMutate = vi.fn();

vi.mock('@workspace/api-client-react', () => ({
  useListModules: () => ({ data: modules, isLoading: false }),
  useGetPartnerConnectionStatus: () => ({ data: statusData, isLoading: false }),
  getGetPartnerConnectionStatusQueryKey: (id: string) => ['partner-status', id],
  getListPartnerConnectionsQueryKey: () => ['partner-connections'],
  useConnectPartner: () => ({ mutate: connectMutate, isPending: false }),
  useCompletePartnerAuthorization: () => ({ mutate: authorizeMutate, isPending: false }),
  useDisconnectPartner: () => ({ mutate: disconnectMutate, isPending: false }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

// Checkout dialog is out of scope here; assert it is NOT the activation path.
vi.mock('@/components/checkout/CheckoutSimulationDialog', () => ({
  CheckoutSimulationDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="checkout-dialog" /> : null,
}));

function renderCard(connectionStatus: string) {
  return render(
    <StaticPlaceholderPage
      title="Team Management"
      description="desc"
      partner="Deel"
      features={['A', 'B']}
      moduleName={modules[0].name}
      available
      partnerId="deel"
      connectionStatus={connectionStatus}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  statusData = { ...statusData, status: 'not_connected', events: [], lastError: null };
});

describe('partner integration workflow', () => {
  it('Activate Module opens the connection dialog (not checkout) and starts the handshake', async () => {
    renderCard('not_connected');
    const btn = screen.getByTestId('btn-activate-team-management');
    expect(btn).toHaveTextContent('Activate Module');

    await userEvent.click(btn);
    expect(screen.queryByTestId('checkout-dialog')).toBeNull();
    expect(screen.getByTestId('partner-connect-dialog')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('btn-partner-connect'));
    expect(connectMutate).toHaveBeenCalledWith(
      { partnerId: 'deel' },
      expect.anything(),
    );
  });

  it('reflects pending state on the CTA and status badge', () => {
    statusData = { ...statusData, status: 'pending' };
    renderCard('pending');
    expect(screen.getByTestId('btn-activate-team-management')).toHaveTextContent('Continue Activation');
    expect(screen.getByTestId('badge-connection-pending')).toBeInTheDocument();
  });

  it('active state shows Manage Connection, sync info, history, and Disconnect', async () => {
    statusData = {
      ...statusData,
      status: 'active',
      connectedAt: '2026-07-27T10:00:00.000Z',
      lastSyncAt: '2026-07-27T11:00:00.000Z',
      events: [
        { id: 2, eventType: 'connection_authorized', details: 'Authorization completed; credentials stored', createdAt: '2026-07-27T10:00:00.000Z' },
        { id: 1, eventType: 'connection_initiated', details: null, createdAt: '2026-07-27T09:59:00.000Z' },
      ],
    };
    renderCard('active');
    const btn = screen.getByTestId('btn-activate-team-management');
    expect(btn).toHaveTextContent('Manage Connection');
    expect(screen.getByTestId('badge-connection-active')).toBeInTheDocument();

    await userEvent.click(btn);
    expect(screen.getByTestId('partner-sync-info')).toBeInTheDocument();
    const history = screen.getByTestId('partner-event-list');
    expect(history).toHaveTextContent('connection authorized');
    expect(history).toHaveTextContent('connection initiated');
    // No credential material anywhere in the dialog
    expect(document.body.textContent).not.toMatch(/sandbox_(access|refresh)|accessToken|refreshToken/i);

    await userEvent.click(screen.getByTestId('btn-partner-disconnect'));
    expect(disconnectMutate).toHaveBeenCalledWith(
      { partnerId: 'deel' },
      expect.anything(),
    );
  });

  it('error state offers a restart of the connection', async () => {
    statusData = { ...statusData, status: 'error', lastError: 'Handshake state mismatch' };
    renderCard('error');
    await userEvent.click(screen.getByTestId('btn-activate-team-management'));
    expect(screen.getByTestId('partner-connection-error')).toHaveTextContent('Handshake state mismatch');
    expect(screen.getByTestId('btn-partner-connect')).toHaveTextContent('Restart Connection');
  });
});
