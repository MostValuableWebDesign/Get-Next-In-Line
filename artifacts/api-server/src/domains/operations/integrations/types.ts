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
  /** Provider scopes required before a capability can be used. */
  requiredScopes?: Partial<Record<WorkforceCapability, readonly string[]>>;
};

export type ProviderContext = {
  tenantId: number;
};

export type ProviderConnectionState =
  | "not_connected"
  | "connecting"
  | "connected"
  | "syncing"
  | "degraded"
  | "reauthorization_required"
  | "error";

export type ProviderConnectionStatus = {
  providerId: string;
  state: ProviderConnectionState;
  providerAccountId: string | null;
  scopes: readonly string[];
  connectedAt: string | null;
  lastSuccessfulSyncAt: string | null;
  lastSyncAttemptAt: string | null;
  lastError: string | null;
};

export type EmploymentType = "employee" | "contractor" | "unknown";
export type EmploymentStatus = "active" | "inactive" | "terminated" | "unknown";

export type NormalizedEmployee = {
  providerId: string;
  externalId: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  email: string | null;
  phone: string | null;
  employmentType: EmploymentType;
  employmentStatus: EmploymentStatus;
  jobTitle: string | null;
  hireDate: string | null;
  terminationDate: string | null;
  rawUpdatedAt: string | null;
  /** Provider job UUIDs used internally by compensation synchronization. */
  providerJobIds?: readonly string[];
};

export type NormalizedContractor = Omit<NormalizedEmployee, "employmentType"> & {
  employmentType: "contractor";
};

export type NormalizedPayrollRun = {
  providerId: string;
  externalId: string;
  status: "draft" | "processing" | "processed" | "paid" | "cancelled" | "unknown";
  payPeriodStart: string;
  payPeriodEnd: string;
  paymentDate: string | null;
  grossPayCents: string | null;
  netPayCents: string | null;
  currency: string;
  processed: boolean;
  processedDate: string | null;
  calculatedAt: string | null;
  rawUpdatedAt: string | null;
};

export type NormalizedCompensation = {
  providerId: string;
  externalEmployeeId: string;
  externalJobId: string;
  amountCents: string;
  currency: string;
  interval: "hourly" | "weekly" | "monthly" | "annual" | "paycheck" | "unknown";
  effectiveFrom: string | null;
  effectiveTo: string | null;
  rawUpdatedAt: string | null;
};

export type PayrollQueryOptions = {
  from?: string;
  to?: string;
  limit?: number;
};

export type ProviderSyncResult = {
  providerId: string;
  tenantId: number;
  startedAt: string;
  completedAt: string;
  status: "succeeded" | "partially_succeeded" | "failed";
  recordsRead: number;
  recordsWritten: number;
  errors: readonly string[];
};

export interface WorkforceProvider {
  readonly definition: WorkforceProviderDefinition;
  getConnectionStatus(context: ProviderContext): Promise<ProviderConnectionStatus>;
  listEmployees(context: ProviderContext): Promise<NormalizedEmployee[]>;
  getEmployee?(
    context: ProviderContext,
    externalEmployeeId: string,
  ): Promise<NormalizedEmployee | null>;
  listContractors?(context: ProviderContext): Promise<NormalizedContractor[]>;
  listPayrollRuns?(
    context: ProviderContext,
    options?: PayrollQueryOptions,
  ): Promise<NormalizedPayrollRun[]>;
  listCompensations?(
    context: ProviderContext,
  ): Promise<NormalizedCompensation[]>;
  getCompensation?(
    context: ProviderContext,
    externalEmployeeId: string,
  ): Promise<NormalizedCompensation | null>;
}