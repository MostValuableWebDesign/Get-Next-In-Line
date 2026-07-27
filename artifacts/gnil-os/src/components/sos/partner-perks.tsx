import { useSearch } from 'wouter';
import {
  useListCoopActivePerks, getListCoopActivePerksQueryKey,
  type CoopActivePerk, type CoopFlashPerk,
} from '@workspace/api-client-react';
import { QRCodeSVG } from 'qrcode.react';
import { parseTenantParam } from '@/lib/sos-tenant';
import { Handshake, Ticket } from 'lucide-react';

/**
 * Live co-op partner perks for the business currently in scope (?tenant=).
 *
 * Only accepted, active partnerships inside their optional date window are
 * ever returned by the API, so these blocks automatically appear on
 * acceptance and disappear on deactivation/expiry — no manual deployment
 * step. Returns [] under the legacy (unscoped) view, where the endpoint has
 * no tenant to resolve. The `disclaimer` is the platform liability text that
 * must accompany every displayed perk; it comes from the API (single source),
 * never a local copy.
 */
export function usePartnerPerks(): {
  perks: CoopActivePerk[];
  flashPerks: CoopFlashPerk[];
  disclaimer: string | null;
  tenantScoped: boolean;
} {
  const search = useSearch();
  const tenantId = parseTenantParam(search);
  const { data } = useListCoopActivePerks({
    query: {
      queryKey: getListCoopActivePerksQueryKey(),
      enabled: tenantId != null,
    },
  });
  return {
    perks: tenantId != null ? (data?.perks ?? []) : [],
    // Boosted flash offers from live co-op campaigns this business joined —
    // present only while each campaign window is open.
    flashPerks: tenantId != null ? (data?.flashPerks ?? []) : [],
    disclaimer: tenantId != null ? (data?.disclaimer ?? null) : null,
    tenantScoped: tenantId != null,
  };
}

/** Build the QR payload the Scan Perk flow expects: `<code>|<passCode>`. */
export function perkQrPayload(redemptionCode: string, passCode: string): string {
  return `${redemptionCode}|${passCode}`;
}

/**
 * Compact partner-perk block reused across the checkout ticket, the printed
 * receipt, and customer pass/plan surfaces. `staffFacing` controls whether
 * the redemption code is shown. When `passCode` is provided (customer pass
 * surface) each perk renders a scannable QR carrying the redemption payload
 * for that specific pass instance, plus the payload text as a manual-entry
 * fallback.
 */
export function PartnerPerksBlock({
  perks,
  flashPerks = [],
  disclaimer,
  staffFacing = false,
  passCode,
  title = 'Partner Perks',
}: {
  perks: CoopActivePerk[];
  flashPerks?: CoopFlashPerk[];
  disclaimer?: string | null;
  staffFacing?: boolean;
  passCode?: string;
  title?: string;
}) {
  if (perks.length === 0 && flashPerks.length === 0) return null;
  return (
    <div className="border rounded-md p-3 bg-emerald-500/5 border-emerald-500/30 space-y-2" data-testid="block-partner-perks">
      <span className="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
        <Handshake className="w-3.5 h-3.5" /> {title}
      </span>
      {flashPerks.length > 0 && (
        <div className="space-y-1.5" data-testid="block-flash-perks">
          {flashPerks.map(fp => (
            <div
              key={fp.campaignId}
              className="text-sm rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5"
              data-testid={`row-flash-perk-${fp.campaignId}`}
            >
              <span className="font-semibold text-amber-700 dark:text-amber-400">⚡ {fp.campaignName}:</span>{' '}
              <span>{fp.perkBoostText}</span>
              {fp.partnerNames.length > 0 && (
                <span className="text-muted-foreground"> — also at {fp.partnerNames.join(', ')}</span>
              )}
              <span className="ml-1 text-xs text-muted-foreground">
                (through {new Date(fp.endsAt).toLocaleDateString()})
              </span>
            </div>
          ))}
        </div>
      )}
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
            {perk.perkEndsAt && (
              <span className="ml-2 text-xs text-muted-foreground">
                (through {new Date(perk.perkEndsAt).toLocaleDateString()})
              </span>
            )}
            {passCode && (
              <div className="mt-1.5 flex items-center gap-3" data-testid={`qr-partner-perk-${perk.id}`}>
                <div className="bg-white p-1.5 rounded-md border">
                  <QRCodeSVG value={perkQrPayload(perk.redemptionCode, passCode)} size={72} />
                </div>
                <div className="text-[10px] font-mono text-muted-foreground break-all">
                  {perkQrPayload(perk.redemptionCode, passCode)}
                  <div className="font-sans mt-0.5">Show this at {perk.partnerName} to redeem — one use per pass.</div>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      {disclaimer && (
        <p className="text-[10px] leading-snug text-muted-foreground pt-1 border-t border-emerald-500/20" data-testid="text-perk-disclaimer">
          {disclaimer}
        </p>
      )}
    </div>
  );
}
