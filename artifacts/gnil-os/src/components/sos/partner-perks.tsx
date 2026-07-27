import { useSearch } from 'wouter';
import {
  useListCoopActivePerks, getListCoopActivePerksQueryKey,
  type CoopActivePerk,
} from '@workspace/api-client-react';
import { parseTenantParam } from '@/lib/sos-tenant';
import { Handshake, Ticket } from 'lucide-react';

/**
 * Live co-op partner perks for the business currently in scope (?tenant=).
 *
 * Only accepted AND active partnerships are ever returned by the API, so
 * these blocks automatically appear on acceptance and disappear on
 * deactivation — no manual deployment step. Returns [] under the legacy
 * (unscoped) view, where the endpoint has no tenant to resolve.
 */
export function usePartnerPerks(): { perks: CoopActivePerk[]; tenantScoped: boolean } {
  const search = useSearch();
  const tenantId = parseTenantParam(search);
  const { data } = useListCoopActivePerks({
    query: {
      queryKey: getListCoopActivePerksQueryKey(),
      enabled: tenantId != null,
    },
  });
  return { perks: tenantId != null ? (data ?? []) : [], tenantScoped: tenantId != null };
}

/**
 * Compact partner-perk block reused across the checkout ticket, the printed
 * receipt, and customer pass/plan surfaces. `staffFacing` controls whether
 * the redemption code is shown (staff need it; pure customer output doesn't
 * have to hide it either, but pass views keep it for redemption at partner).
 */
export function PartnerPerksBlock({
  perks,
  staffFacing = false,
  title = 'Partner Perks',
}: {
  perks: CoopActivePerk[];
  staffFacing?: boolean;
  title?: string;
}) {
  if (perks.length === 0) return null;
  return (
    <div className="border rounded-md p-3 bg-emerald-500/5 border-emerald-500/30 space-y-2" data-testid="block-partner-perks">
      <span className="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
        <Handshake className="w-3.5 h-3.5" /> {title}
      </span>
      <div className="space-y-1.5">
        {perks.map(perk => (
          <div key={perk.id} className="text-sm" data-testid={`row-partner-perk-${perk.id}`}>
            <span className="font-medium">{perk.perkTitle}</span>
            <span className="text-muted-foreground"> — with {perk.partnerName}</span>
            {staffFacing && (
              <span className="ml-2 inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
                <Ticket className="w-3 h-3" /> {perk.redemptionCode}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
