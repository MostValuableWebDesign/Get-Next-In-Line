import React, { useId } from 'react';
import {
  useGetSosSettings, getGetSosSettingsQueryKey,
  useListSosServices, getListSosServicesQueryKey,
  type SosService,
} from '@workspace/api-client-react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

/**
 * Parse the legacy comma-separated `serviceNames` settings string into a
 * clean, de-duplicated list. Mirrors `parseServiceNames` in the API server's
 * receptionist module so staff-booked and AI-booked appointments share the
 * same vocabulary. Only used as a fallback for scopes whose structured
 * service catalog hasn't been backfilled yet.
 */
export function parseServiceNames(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export interface ServiceSuggestion {
  name: string;
  price: number | null;
  durationMinutes: number | null;
}

/**
 * The business's service suggestions: the structured service catalog when it
 * has entries (active services in display order, with price and duration),
 * otherwise the legacy comma-separated setting as a read-only fallback —
 * exactly the same resolution the API server uses for the AI receptionist.
 */
export function useServiceSuggestions(): ServiceSuggestion[] {
  const { data: catalog } = useListSosServices({
    query: { queryKey: getListSosServicesQueryKey() },
  });
  const hasCatalog = (catalog?.length ?? 0) > 0;
  const { data: settings } = useGetSosSettings({
    query: { queryKey: getGetSosSettingsQueryKey(), enabled: catalog != null && !hasCatalog },
  });
  if (hasCatalog) {
    return (catalog as SosService[])
      .filter((s) => s.isActive)
      .map((s) => ({ name: s.name, price: s.price, durationMinutes: s.durationMinutes }));
  }
  return parseServiceNames(settings?.serviceNames).map((name) => ({
    name,
    price: null,
    durationMinutes: null,
  }));
}

/**
 * Service-type field used by every staff booking/check-in form.
 *
 * Suggests the business's service menu (Business Bookings → Services) via a
 * native datalist plus one-click chips showing price and duration, while
 * still accepting free text for one-off services.
 */
export function ServiceTypeInput({
  value,
  onChange,
  placeholder,
  'data-testid': dataTestId = 'input-service-type',
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  'data-testid'?: string;
}) {
  const listId = useId();
  const services = useServiceSuggestions();

  return (
    <div className="space-y-2">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        list={services.length > 0 ? listId : undefined}
        placeholder={placeholder ?? (services.length > 0 ? 'Choose a service or type your own' : 'e.g. Consultation, Appointment')}
        data-testid={dataTestId}
      />
      {services.length > 0 && (
        <>
          <datalist id={listId}>
            {services.map((s) => (
              <option key={s.name} value={s.name} />
            ))}
          </datalist>
          <div className="flex flex-wrap gap-1.5" data-testid="service-suggestions">
            {services.map((s) => (
              <Badge
                key={s.name}
                variant={value.trim().toLowerCase() === s.name.toLowerCase() ? 'default' : 'outline'}
                className="cursor-pointer select-none"
                onClick={() => onChange(s.name)}
                data-testid={`suggestion-service-${s.name.toLowerCase().replace(/\s+/g, '-')}`}
              >
                {s.name}
                {(s.price != null || s.durationMinutes != null) && (
                  <span className="ml-1 font-normal opacity-70">
                    {[
                      s.price != null ? `$${s.price.toFixed(0)}` : null,
                      s.durationMinutes != null ? `${s.durationMinutes}m` : null,
                    ].filter(Boolean).join(' · ')}
                  </span>
                )}
              </Badge>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
