/**
 * Effective markup percent for a module: the per-module override when set
 * (e.g. 0% for partner-direct pass-through modules, 25% for white-label
 * resale engines), falling back to the agency-wide markup otherwise.
 */
export function effectiveMarkupPercent(
  module: { markupPercentOverride: string | null },
  agencyMarkupPercent: number
): number {
  return module.markupPercentOverride != null
    ? parseFloat(module.markupPercentOverride)
    : agencyMarkupPercent;
}
