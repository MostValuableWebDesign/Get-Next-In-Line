import { useSearch } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import {
  useListCoopActivePerks, getListCoopActivePerksQueryKey,
  signCoopPassPayloads,
  type CoopActivePerk, type CoopFlashPerk,
} from '@workspace/api-client-react';
import { QRCodeSVG } from 'qrcode.react';
import { parseTenantParam } from '@/lib/sos-tenant';
import { Handshake, Star, Ticket } from 'lucide-react';

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
 * Code the customer pass QR should carry: the direction-aware tracking code
 * when present (attributes the redemption to this business as the sender),
 * falling back to the legacy shared redemption code.
 */
export function perkPassCode(perk: Pick<CoopActivePerk, 'trackingCode' | 'redemptionCode'>): string {
  return perk.trackingCode ?? perk.redemptionCode;
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
  // Server-signed QR payloads (Co-Op Offline Fallback Mode): when this block
  // renders a customer pass, ask the server to sign each perk's code so the
  // QR can be verified offline at the partner. Until the signatures arrive
  // (or if the call fails) the QR falls back to the legacy plain payload,
  // which keeps validating online.
  const codes = perks.map(perkPassCode);
  const { data: signed } = useQuery({
    queryKey: ['coop-pass-signatures', passCode ?? null, codes.join(',')],
    queryFn: () => signCoopPassPayloads({ passCode: passCode!, codes }),
    enabled: Boolean(passCode) && codes.length > 0,
    staleTime: 5 * 60 * 1000,
  });
  const signedByCode = new Map((signed?.signatures ?? []).map(s => [s.code, s.qrPayload]));

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
          <div
            key={perk.id}
            className={`text-sm ${perk.featured ? 'rounded-md border border-amber-400/70 bg-amber-100/40 dark:bg-amber-900/20 px-2 py-1.5' : ''}`}
            data-testid={`row-partner-perk-${perk.id}`}
          >
            {perk.featured && (
              <span
                className="mr-1.5 inline-flex items-center gap-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400"
                data-testid={`badge-featured-perk-${perk.id}`}
              >
                <Star className="w-3 h-3 fill-current" /> Featured
              </span>
            )}
            <span className="font-medium">{perk.perkTitle}</span>
            <span className="text-muted-foreground"> — with {perk.partnerName}</span>
            {perk.surge && (
              <span
                className="ml-2 inline-flex items-center gap-1 rounded-md border border-orange-500/40 bg-orange-500/10 px-1.5 py-0.5 text-xs font-semibold text-orange-700 dark:text-orange-400"
                data-testid={`badge-surge-boost-${perk.id}`}
              >
                🔥 Boosted: {perk.surge.boostedDiscountPercent}% off
                <span className="font-normal text-muted-foreground line-through">
                  {perk.surge.baseDiscountPercent}%
                </span>
                <span className="font-normal">
                  — limited time, until{' '}
                  {new Date(perk.surge.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </span>
              </span>
            )}
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
                  <QRCodeSVG value={signedByCode.get(perkPassCode(perk)) ?? perkQrPayload(perkPassCode(perk), passCode)} size={72} />
                </div>
                <div className="text-[10px] font-mono text-muted-foreground break-all">
                  {perkQrPayload(perkPassCode(perk), passCode)}
                  <div className="font-sans mt-0.5">Show this at {perk.partnerName} to redeem — one use per pass.</div>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      {/* Neighborhood Passport: every redemption at a new partner business
          earns a stamp — the passport lives inside the customer wallet. */}
      <p className="text-[11px] leading-snug pt-1">
        <a
          href={`${import.meta.env.BASE_URL}wallet`}
          className="text-emerald-700 dark:text-emerald-400 underline underline-offset-2"
          data-testid="link-perk-passport"
        >
          Redeeming earns a Neighborhood Passport stamp — view your passport
        </a>
      </p>
      {disclaimer && (
        <p className="text-[10px] leading-snug text-muted-foreground pt-1 border-t border-emerald-500/20" data-testid="text-perk-disclaimer">
          {disclaimer}
        </p>
      )}
    </div>
  );
}
