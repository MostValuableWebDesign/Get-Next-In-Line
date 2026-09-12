import type { WorkforceProviderDefinition } from "./types";

const PROVIDERS: readonly WorkforceProviderDefinition[] = [
  {
    providerId: "gusto",
    name: "Gusto",
    description: "Workforce records and payroll through a connected Gusto account.",
    preferred: true,
    // Keep this deliberately conservative until a live account confirms any
    // optional scopes. The UI must never imply unsupported capability.
    capabilities: ["employees", "contractors", "payroll", "compensation", "onboarding"],
  },
];

export function listWorkforceProviders(): readonly WorkforceProviderDefinition[] {
  return PROVIDERS;
}