/**
 * Concierge engagement-rule editor uses typed form fields (not raw JSON):
 *  - reminder rules edit leadHours + template and serialize to the zod shape;
 *  - rebooking rules edit cooldownDays + template;
 *  - upsell rules edit a repeatable add-on list (name, price, compatible
 *    services) with add/remove rows;
 *  - existing rule configs round-trip into the form on edit;
 *  - invalid input is rejected client-side before any request is sent.
 */
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const createMutate = vi.fn();
const updateMutate = vi.fn();
const deleteMutate = vi.fn();

let rulesData: Array<Record<string, unknown>> = [];

vi.mock('@workspace/api-client-react', () => ({
  useListEngagementRules: () => ({ data: rulesData, isLoading: false }),
  getListEngagementRulesQueryKey: (id: number) => ['engagement-rules', id],
  useCreateEngagementRule: () => ({ mutate: createMutate, isPending: false }),
  useUpdateEngagementRule: () => ({ mutate: updateMutate, isPending: false }),
  useDeleteEngagementRule: () => ({ mutate: deleteMutate, isPending: false }),
  useListClientProfiles: () => ({ data: [], isLoading: false }),
  getListClientProfilesQueryKey: (id: number) => ['client-profiles', id],
  useCreateClientProfile: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateClientProfile: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteClientProfile: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { RulesTab } from '@/components/concierge-tabs';

function renderRules() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RulesTab tenantId={5} />
    </QueryClientProvider>,
  );
}

async function pickRuleType(label: string) {
  fireEvent.click(screen.getByTestId('select-rule-type'));
  fireEvent.click(await screen.findByRole('option', { name: label }));
}

beforeEach(() => {
  createMutate.mockReset();
  updateMutate.mockReset();
  deleteMutate.mockReset();
  rulesData = [];
});

describe('reminder rule form', () => {
  it('creates a reminder rule from typed fields, serialized to the config shape', () => {
    renderRules();
    fireEvent.click(screen.getByTestId('button-add-rule'));

    // Reminder is the default type: typed fields, no JSON textarea.
    expect(screen.getByTestId('input-rule-lead-hours')).toBeInTheDocument();
    expect(screen.queryByTestId('input-rule-config')).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('input-rule-lead-hours'), { target: { value: '48' } });
    fireEvent.change(screen.getByTestId('input-rule-reminder-template'), {
      target: { value: 'See you {{when}}, {{name}}!' },
    });
    fireEvent.click(screen.getByTestId('button-save-rule'));

    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(createMutate.mock.calls[0][0]).toEqual({
      id: 5,
      data: {
        ruleType: 'reminder',
        config: { leadHours: 48, template: 'See you {{when}}, {{name}}!' },
        isActive: true,
      },
    });
  });

  it('round-trips an existing reminder config into the form and back on edit', () => {
    rulesData = [
      {
        id: 11,
        tenantId: 5,
        ruleType: 'reminder',
        isActive: false,
        config: { leadHours: 72, template: 'Custom {{name}} template' },
      },
    ];
    renderRules();
    fireEvent.click(screen.getByTestId('button-edit-rule-11'));

    expect(screen.getByTestId('input-rule-lead-hours')).toHaveValue(72);
    expect(screen.getByTestId('input-rule-reminder-template')).toHaveValue('Custom {{name}} template');

    fireEvent.change(screen.getByTestId('input-rule-lead-hours'), { target: { value: '12' } });
    fireEvent.click(screen.getByTestId('button-save-rule'));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0][0]).toEqual({
      id: 5,
      ruleId: 11,
      data: {
        config: { leadHours: 12, template: 'Custom {{name}} template' },
        isActive: false,
      },
    });
  });

  it('rejects a non-positive lead hours client-side without sending a request', () => {
    renderRules();
    fireEvent.click(screen.getByTestId('button-add-rule'));
    fireEvent.change(screen.getByTestId('input-rule-lead-hours'), { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('button-save-rule'));
    expect(createMutate).not.toHaveBeenCalled();
  });

  it('rejects an empty template client-side', () => {
    renderRules();
    fireEvent.click(screen.getByTestId('button-add-rule'));
    fireEvent.change(screen.getByTestId('input-rule-reminder-template'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('button-save-rule'));
    expect(createMutate).not.toHaveBeenCalled();
  });
});

describe('rebooking rule form', () => {
  it('creates a rebooking rule with cooldownDays + template', async () => {
    renderRules();
    fireEvent.click(screen.getByTestId('button-add-rule'));
    await pickRuleType('Rebooking Nudge');

    fireEvent.change(screen.getByTestId('input-rule-cooldown-days'), { target: { value: '14' } });
    fireEvent.change(screen.getByTestId('input-rule-rebooking-template'), {
      target: { value: 'Been {{days}} days, {{name}}!' },
    });
    fireEvent.click(screen.getByTestId('button-save-rule'));

    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(createMutate.mock.calls[0][0]).toEqual({
      id: 5,
      data: {
        ruleType: 'rebooking_nudge',
        config: { cooldownDays: 14, template: 'Been {{days}} days, {{name}}!' },
        isActive: true,
      },
    });
  });

  it('round-trips an existing rebooking config on edit', () => {
    rulesData = [
      {
        id: 22,
        tenantId: 5,
        ruleType: 'rebooking_nudge',
        isActive: true,
        config: { cooldownDays: 21, template: 'Come back!' },
      },
    ];
    renderRules();
    fireEvent.click(screen.getByTestId('button-edit-rule-22'));

    expect(screen.getByTestId('input-rule-cooldown-days')).toHaveValue(21);
    expect(screen.getByTestId('input-rule-rebooking-template')).toHaveValue('Come back!');

    fireEvent.click(screen.getByTestId('button-save-rule'));
    expect(updateMutate.mock.calls[0][0].data.config).toEqual({
      cooldownDays: 21,
      template: 'Come back!',
    });
  });

  it('rejects a fractional cooldown client-side', async () => {
    renderRules();
    fireEvent.click(screen.getByTestId('button-add-rule'));
    await pickRuleType('Rebooking Nudge');
    fireEvent.change(screen.getByTestId('input-rule-cooldown-days'), { target: { value: '2.5' } });
    fireEvent.click(screen.getByTestId('button-save-rule'));
    expect(createMutate).not.toHaveBeenCalled();
  });
});

describe('upsell rule form', () => {
  it('creates an upsell rule from add-on rows with add/remove', async () => {
    renderRules();
    fireEvent.click(screen.getByTestId('button-add-rule'));
    await pickRuleType('Upsell Suggestions');

    fireEvent.change(screen.getByTestId('input-addon-name-0'), {
      target: { value: 'Deep Conditioning' },
    });
    fireEvent.change(screen.getByTestId('input-addon-price-0'), { target: { value: '25' } });
    fireEvent.change(screen.getByTestId('input-addon-services-0'), {
      target: { value: 'Haircut, Color ' },
    });
    fireEvent.change(screen.getByTestId('input-addon-description-0'), {
      target: { value: 'Restores moisture' },
    });

    fireEvent.click(screen.getByTestId('button-add-addon'));
    fireEvent.change(screen.getByTestId('input-addon-name-1'), { target: { value: 'Scalp Massage' } });

    // A third row added then removed must not appear in the payload.
    fireEvent.click(screen.getByTestId('button-add-addon'));
    fireEvent.change(screen.getByTestId('input-addon-name-2'), { target: { value: 'Oops' } });
    fireEvent.click(screen.getByTestId('button-remove-addon-2'));

    fireEvent.click(screen.getByTestId('button-save-rule'));

    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(createMutate.mock.calls[0][0]).toEqual({
      id: 5,
      data: {
        ruleType: 'upsell',
        config: {
          addOns: [
            { name: 'Deep Conditioning', price: 25, description: 'Restores moisture', compatibleServices: ['Haircut', 'Color'] },
            { name: 'Scalp Massage', price: null, description: null, compatibleServices: [] },
          ],
        },
        isActive: true,
      },
    });
  });

  it('round-trips an existing upsell config into rows on edit', () => {
    rulesData = [
      {
        id: 33,
        tenantId: 5,
        ruleType: 'upsell',
        isActive: true,
        config: {
          addOns: [
            { name: 'Gloss', price: 30, description: 'Adds shine', compatibleServices: ['Color'] },
            { name: 'Trim', compatibleServices: [] },
          ],
        },
      },
    ];
    renderRules();
    fireEvent.click(screen.getByTestId('button-edit-rule-33'));

    expect(screen.getByTestId('input-addon-name-0')).toHaveValue('Gloss');
    expect(screen.getByTestId('input-addon-price-0')).toHaveValue(30);
    expect(screen.getByTestId('input-addon-services-0')).toHaveValue('Color');
    expect(screen.getByTestId('input-addon-description-0')).toHaveValue('Adds shine');
    expect(screen.getByTestId('input-addon-name-1')).toHaveValue('Trim');
    expect(screen.getByTestId('input-addon-price-1')).toHaveValue(null);

    fireEvent.click(screen.getByTestId('button-save-rule'));
    expect(updateMutate.mock.calls[0][0].data.config).toEqual({
      addOns: [
        { name: 'Gloss', price: 30, description: 'Adds shine', compatibleServices: ['Color'] },
        { name: 'Trim', price: null, description: null, compatibleServices: [] },
      ],
    });
  });

  it('rejects an add-on with price but no name, and allows saving an empty list', async () => {
    renderRules();
    fireEvent.click(screen.getByTestId('button-add-rule'));
    await pickRuleType('Upsell Suggestions');

    fireEvent.change(screen.getByTestId('input-addon-price-0'), { target: { value: '10' } });
    fireEvent.click(screen.getByTestId('button-save-rule'));
    expect(createMutate).not.toHaveBeenCalled();

    // Clearing the price leaves a fully-empty row, which is dropped.
    fireEvent.change(screen.getByTestId('input-addon-price-0'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('button-save-rule'));
    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(createMutate.mock.calls[0][0].data.config).toEqual({ addOns: [] });
  });

  it('rejects a negative price client-side', async () => {
    renderRules();
    fireEvent.click(screen.getByTestId('button-add-rule'));
    await pickRuleType('Upsell Suggestions');
    fireEvent.change(screen.getByTestId('input-addon-name-0'), { target: { value: 'Gloss' } });
    fireEvent.change(screen.getByTestId('input-addon-price-0'), { target: { value: '-5' } });
    fireEvent.click(screen.getByTestId('button-save-rule'));
    expect(createMutate).not.toHaveBeenCalled();
  });
});

describe('rule list summary', () => {
  it('shows a human-readable summary instead of raw JSON', () => {
    rulesData = [
      {
        id: 44,
        tenantId: 5,
        ruleType: 'upsell',
        isActive: true,
        config: { addOns: [{ name: 'Gloss', price: 30 }] },
      },
    ];
    renderRules();
    const summary = screen.getByTestId('text-rule-summary-44');
    expect(summary).toHaveTextContent('Gloss ($30)');
    expect(within(summary).queryByText(/addOns/)).not.toBeInTheDocument();
  });
});
