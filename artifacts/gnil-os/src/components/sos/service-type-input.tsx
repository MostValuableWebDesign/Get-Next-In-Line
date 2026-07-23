import React, { useId } from 'react';
import { useGetSosSettings, getGetSosSettingsQueryKey } from '@workspace/api-client-react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

/**
 * Parse the comma-separated `serviceNames` settings string into a clean,
 * de-duplicated list. Mirrors `parseServiceNames` in the API server's
 * receptionist module so staff-booked and AI-booked appointments share the
 * same vocabulary.
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

/**
 * Service-type field used by every staff booking/check-in form.
 *
 * Suggests the business's configured services (Settings → AI Receptionist →
 * service names) via a native datalist plus one-click chips, while still
 * accepting free text for one-off services.
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
  const { data: settings } = useGetSosSettings({
    query: { queryKey: getGetSosSettingsQueryKey() },
  });
  const services = parseServiceNames(settings?.serviceNames);

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
            {services.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <div className="flex flex-wrap gap-1.5" data-testid="service-suggestions">
            {services.map((name) => (
              <Badge
                key={name}
                variant={value.trim().toLowerCase() === name.toLowerCase() ? 'default' : 'outline'}
                className="cursor-pointer select-none"
                onClick={() => onChange(name)}
                data-testid={`suggestion-service-${name.toLowerCase().replace(/\s+/g, '-')}`}
              >
                {name}
              </Badge>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
