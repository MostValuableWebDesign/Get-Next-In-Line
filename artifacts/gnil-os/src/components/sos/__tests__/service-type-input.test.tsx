import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let serviceNames: string | null = 'Haircut, Color, haircut , ,Beard Trim';
// Structured catalog rows. When empty, the component falls back to the
// legacy comma-separated serviceNames setting.
let catalog: Array<{ name: string; price: number | null; durationMinutes: number | null; isActive: boolean }> = [];

vi.mock('@workspace/api-client-react', () => ({
  useGetSosSettings: () => ({ data: { serviceNames }, isLoading: false }),
  getGetSosSettingsQueryKey: () => ['/api/sos/settings'],
  useListSosServices: () => ({ data: catalog, isLoading: false }),
  getListSosServicesQueryKey: () => ['/api/sos/services'],
}));

import { ServiceTypeInput, parseServiceNames } from '../service-type-input';

function renderInput(props: Partial<React.ComponentProps<typeof ServiceTypeInput>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onChange = vi.fn();
  const utils = render(
    <QueryClientProvider client={qc}>
      <ServiceTypeInput value="" onChange={onChange} {...props} />
    </QueryClientProvider>,
  );
  return { onChange, ...utils };
}

describe('parseServiceNames', () => {
  it('splits, trims, drops empties, and de-dupes case-insensitively', () => {
    expect(parseServiceNames('Haircut, Color, haircut , ,Beard Trim')).toEqual([
      'Haircut',
      'Color',
      'Beard Trim',
    ]);
    expect(parseServiceNames('')).toEqual([]);
    expect(parseServiceNames(null)).toEqual([]);
    expect(parseServiceNames(undefined)).toEqual([]);
  });
});

describe('ServiceTypeInput', () => {
  it('suggests the structured catalog services (active only, with price/duration) when the catalog has rows', () => {
    catalog = [
      { name: 'Balayage', price: 120, durationMinutes: 90, isActive: true },
      { name: 'Old Perm', price: 50, durationMinutes: 60, isActive: false },
      { name: 'Trim', price: null, durationMinutes: null, isActive: true },
    ];
    const { onChange } = renderInput();
    const chips = screen.getByTestId('service-suggestions');
    expect(chips.textContent).toContain('Balayage');
    expect(chips.textContent).toContain('$120');
    expect(chips.textContent).toContain('90m');
    expect(chips.textContent).not.toContain('Old Perm'); // inactive hidden
    // Legacy string is ignored once the catalog exists
    expect(chips.textContent).not.toContain('Haircut');
    fireEvent.click(screen.getByTestId('suggestion-service-balayage'));
    expect(onChange).toHaveBeenCalledWith('Balayage');
    catalog = [];
  });

  it('falls back to the legacy comma-separated setting when the catalog is empty', () => {
    const { onChange } = renderInput();
    expect(screen.getByTestId('service-suggestions')).toBeTruthy();
    fireEvent.click(screen.getByTestId('suggestion-service-beard-trim'));
    expect(onChange).toHaveBeenCalledWith('Beard Trim');
  });

  it('wires the input to a datalist of configured services', () => {
    renderInput();
    const input = screen.getByTestId('input-service-type') as HTMLInputElement;
    const listId = input.getAttribute('list');
    expect(listId).toBeTruthy();
    const datalist = document.getElementById(listId!) as HTMLDataListElement;
    expect(datalist).toBeTruthy();
    expect(Array.from(datalist.options).map((o) => o.value)).toEqual([
      'Haircut',
      'Color',
      'Beard Trim',
    ]);
  });

  it('still allows free-text entry', () => {
    const { onChange } = renderInput();
    fireEvent.change(screen.getByTestId('input-service-type'), {
      target: { value: 'One-off thing' },
    });
    expect(onChange).toHaveBeenCalledWith('One-off thing');
  });

  it('renders a plain input when no services are configured', () => {
    serviceNames = null;
    renderInput();
    const input = screen.getByTestId('input-service-type') as HTMLInputElement;
    expect(input.getAttribute('list')).toBeNull();
    expect(screen.queryByTestId('service-suggestions')).toBeNull();
  });
});
