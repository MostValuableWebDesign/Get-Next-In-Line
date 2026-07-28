import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const updateMutate = vi.fn();
const redeemMutate = vi.fn();
let redeemOnSuccess: ((res: unknown) => void) | undefined;

let program = {
  settings: { optedIn: true, pledgePerRedemption: 2 },
  poolBalance: 9,
  myContribution: 4,
  myBenefit: 5,
  tiers: [
    { key: 'member', name: 'Member', minPartners: 0, minReferrals: 0, discountPercent: 0, vip: false },
    { key: 'advocate', name: 'Advocate', minPartners: 2, minReferrals: 1, discountPercent: 5, vip: false },
    { key: 'ambassador', name: 'Community Ambassador', minPartners: 4, minReferrals: 3, discountPercent: 10, vip: true },
  ],
  topAmbassadors: [
    { displayName: 'Jamie R.', phoneMasked: '•••1234', tier: 'ambassador', distinctPartners: 5, convertedReferrals: 3 },
  ],
  referralStats: { totalReferrals: 4, convertedReferrals: 2, convertedAtThisBusiness: 1 },
};

let ledger = {
  poolBalance: 9,
  entries: [
    { id: 1, entryType: 'contribution', amount: 2, businessName: 'Amb Gym', description: 'Pledge accrued from a co-op perk redemption', createdAt: new Date().toISOString() },
    { id: 2, entryType: 'reward_debit', amount: 5, businessName: 'Amb Gym', description: 'Ambassador reward AMB-XYZ redeemed', createdAt: new Date().toISOString() },
  ],
};

vi.mock('@workspace/api-client-react', () => ({
  useGetAmbassadorProgram: () => ({ data: program, isLoading: false }),
  getGetAmbassadorProgramQueryKey: () => ['/api/coop/ambassador/program'],
  useGetAmbassadorLedger: () => ({ data: ledger, isLoading: false }),
  getGetAmbassadorLedgerQueryKey: () => ['/api/coop/ambassador/ledger'],
  useUpdateAmbassadorProgram: () => ({ mutate: updateMutate, isPending: false }),
  useRedeemAmbassadorReward: (opts?: { mutation?: { onSuccess?: (res: unknown) => void } }) => {
    redeemOnSuccess = opts?.mutation?.onSuccess;
    return { mutate: redeemMutate, isPending: false };
  },
}));

vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { AmbassadorProgramSection } from '../ambassador-program-content';

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AmbassadorProgramSection tenantId={42} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  updateMutate.mockClear();
  redeemMutate.mockClear();
});

describe('AmbassadorProgramSection', () => {
  it('shows the pool balance, my contribution vs. attributed benefit, and referral stats', () => {
    renderSection();
    expect(screen.getByTestId('text-ambassador-pool-balance').textContent).toContain('$9.00');
    expect(screen.getByTestId('text-ambassador-my-contribution').textContent).toContain('$4.00');
    expect(screen.getByTestId('text-ambassador-my-benefit').textContent).toContain('$5.00');
    expect(screen.getByTestId('text-ambassador-referral-stats').textContent).toContain('4 started');
    expect(screen.getByTestId('text-ambassador-referral-stats').textContent).toContain('2 converted');
  });

  it('lists the network tier defaults and top ambassadors', () => {
    renderSection();
    const tiers = screen.getByTestId('list-ambassador-tiers');
    expect(tiers.textContent).toContain('Advocate');
    expect(tiers.textContent).toContain('Community Ambassador');
    expect(tiers.textContent).toContain('10% off + VIP');
    const top = screen.getByTestId('list-top-ambassadors');
    expect(top.textContent).toContain('Jamie R.');
    expect(top.textContent).toContain('5 businesses');
  });

  it('renders the pool ledger with signed amounts', () => {
    renderSection();
    const list = screen.getByTestId('list-ambassador-ledger');
    expect(list.textContent).toContain('+$2.00');
    expect(list.textContent).toContain('−$5.00');
  });

  it('saves the pledge with opt-in state', () => {
    renderSection();
    fireEvent.change(screen.getByTestId('input-ambassador-pledge'), { target: { value: '3.5' } });
    fireEvent.click(screen.getByTestId('button-save-ambassador-pledge'));
    expect(updateMutate).toHaveBeenCalledWith({ data: { optedIn: true, pledgePerRedemption: 3.5 } });
  });

  it('submits a reward code and surfaces the redemption outcome', () => {
    renderSection();
    fireEvent.change(screen.getByTestId('input-ambassador-reward-code'), { target: { value: 'AMB-TEST1234' } });
    fireEvent.click(screen.getByTestId('button-redeem-ambassador-reward'));
    expect(redeemMutate).toHaveBeenCalledWith({ data: { code: 'AMB-TEST1234' } });
    // Simulate a rejected redemption.
    act(() => {
      redeemOnSuccess?.({ valid: false, reason: 'Unknown reward code', reward: null });
    });
    expect(screen.getByTestId('text-ambassador-redeem-error').textContent).toContain('Unknown reward code');
  });
});
