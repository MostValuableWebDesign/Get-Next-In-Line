import type { WorkforceProviderDefinition } from "./types";

export const GUSTO_DEFINITION: WorkforceProviderDefinition = {
  providerId: "gusto",
  name: "Gusto",
  description: "Workforce records and payroll through a connected Gusto account.",
  preferred: true,
  capabilities: ["employees", "payroll", "compensation"],
  requiredScopes: {
    employees: ["employees:read"],
    payroll: ["payrolls:read"],
    compensation: ["compensations:read", "employees:read"],
  },
};

const PROVIDER_DEFINITIONS: readonly WorkforceProviderDefinition[] = [GUSTO_DEFINITION];

export function listWorkforceProviderDefinitions(): readonly WorkforceProviderDefinition[] {
  return PROVIDER_DEFINITIONS;
}

export function getWorkforceProviderDefinition(providerId: string): WorkforceProviderDefinition {
  const definition = PROVIDER_DEFINITIONS.find(
    (candidate) => candidate.providerId === providerId,
  );
  if (!definition) {
    throw new Error(`Unknown workforce provider: ${providerId}`);
  }
  return definition;
}