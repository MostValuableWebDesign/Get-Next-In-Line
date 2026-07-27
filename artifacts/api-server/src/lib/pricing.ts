/**
 * Effective markup percent for a module.
 *
 * Precedence:
 *  1. Partner-Direct modules (categorySlug "partners") are ALWAYS strict
 *     pass-through — 0% markup (multiplier 1.00) — regardless of any stored
 *     override or the agency-wide markup. This is a billing contract with the
 *     partners, enforced here so no pricing/checkout surface can drift.
 *  2. Per-module override when set (e.g. 25% for white-label resale engines).
 *  3. The agency-wide markup otherwise.
 */
export function effectiveMarkupPercent(
  module: { markupPercentOverride: string | null; categorySlug?: string },
  agencyMarkupPercent: number
): number {
  if (module.categorySlug === "partners") return 0;
  return module.markupPercentOverride != null
    ? parseFloat(module.markupPercentOverride)
    : agencyMarkupPercent;
}
