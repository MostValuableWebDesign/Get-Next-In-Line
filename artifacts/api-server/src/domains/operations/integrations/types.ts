export const WORKFORCE_CAPABILITIES = [
  "employees",
  "contractors",
  "payroll",
  "compensation",
  "onboarding",
  "benefits",
  "tax_documents",
  "time_tracking",
  "time_off",
  "scheduling",
] as const;

export type WorkforceCapability = (typeof WORKFORCE_CAPABILITIES)[number];

export type WorkforceProviderDefinition = {
  providerId: string;
  name: string;
  description: string;
  preferred: boolean;
  capabilities: readonly WorkforceCapability[];
};

export interface WorkforceProvider {
  readonly definition: WorkforceProviderDefinition;
}