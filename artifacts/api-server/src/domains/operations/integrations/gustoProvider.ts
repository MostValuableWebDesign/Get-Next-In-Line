import { and, eq } from "drizzle-orm";
import { db, workforceIntegrationConnectionsTable } from "@workspace/db";
import { getFreshGustoAccessToken } from "./gusto/gustoOAuthService";
import { GustoClient, loadGustoConfig } from "./gusto/GustoClient";
import type {
  NormalizedCompensation,
  NormalizedPayrollRun,
  ProviderConnectionState,
  ProviderConnectionStatus,
  ProviderContext,
  WorkforceProvider,
  WorkforceProviderDefinition,
} from "./types";

export const GUSTO_DEFINITION: WorkforceProviderDefinition = {
  providerId: "gusto",
  name: "Gusto",
  description: "Workforce records and payroll through a connected Gusto account.",
  preferred: true,
  capabilities: ["employees", "payroll", "compensation", "onboarding"],
  requiredScopes: {
    employees: ["employees:read"],
    payroll: ["payrolls:read"],
    compensation: ["compensations:read", "employees:read"],
  },
};

export class WorkforceProviderOperationUnavailableError extends Error {
  constructor(providerId: string, operation: string) {
    super(`${providerId} ${operation} is unavailable until its live API adapter is configured`);
    this.name = "WorkforceProviderOperationUnavailableError";
  }
}

type GustoJob = { uuid?: string; title?: string | null; hire_date?: string | null; primary?: boolean };
type GustoEmployee = {
  uuid?: string;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  work_email?: string | null;
  preferred_first_name?: string | null;
  phone?: string | null;
  terminated?: boolean;
  terminations?: Array<{ effective_date?: string | null }>;
  jobs?: GustoJob[];
};
type GustoContractor = {
  uuid?: string;
  first_name?: string | null;
  last_name?: string | null;
  business_name?: string | null;
  email?: string | null;
  phone?: string | null;
  is_active?: boolean;
};

type GustoPayroll = {
  uuid?: string;
  payroll_uuid?: string;
  pay_period?: { start_date?: string; end_date?: string };
  check_date?: string | null;
  processed?: boolean;
  processed_date?: string | null;
  calculated_at?: string | null;
  totals?: { gross_pay?: string | number | null; net_pay?: string | number | null };
};

type GustoCompensation = {
  uuid?: string;
  job_uuid?: string;
  rate?: string | number;
  payment_unit?: string;
  effective_date?: string | null;
};

function validDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return null;
  return value;
}

/** Convert provider decimal dollars to cents without floating point rounding. */
export function decimalDollarsToCents(value: unknown): string {
  const text =
    typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) {
    throw new Error("Gusto returned an invalid monetary amount");
  }
  const [whole, fraction = ""] = text.split(".");
  const cents = `${whole}${fraction.padEnd(2, "0")}`.replace(/^0+(?=\d)/, "");
  if (cents.length > 20) throw new Error("Gusto monetary amount is out of range");
  return cents;
}

export function normalizeGustoPayroll(payroll: GustoPayroll): NormalizedPayrollRun {
  const externalId = payroll.payroll_uuid ?? payroll.uuid;
  const start = validDate(payroll.pay_period?.start_date);
  const end = validDate(payroll.pay_period?.end_date);
  if (!externalId || !start || !end || typeof payroll.processed !== "boolean") {
    throw new Error("Gusto payroll response is missing verified fields");
  }
  const totals = payroll.totals ?? {};
  return {
    providerId: "gusto",
    externalId,
    status: payroll.processed ? "processed" : "draft",
    payPeriodStart: start,
    payPeriodEnd: end,
    paymentDate: validDate(payroll.check_date),
    grossPayCents: totals.gross_pay == null ? null : decimalDollarsToCents(totals.gross_pay),
    netPayCents: totals.net_pay == null ? null : decimalDollarsToCents(totals.net_pay),
    currency: "USD",
    rawUpdatedAt: validDate(payroll.calculated_at),
    processed: payroll.processed,
    processedDate: validDate(payroll.processed_date),
    calculatedAt: validDate(payroll.calculated_at),
  };
}

const compensationIntervals: Record<string, NormalizedCompensation["interval"]> = {
  Hour: "hourly",
  Week: "weekly",
  Month: "monthly",
  Year: "annual",
  Paycheck: "paycheck",
};

export function normalizeGustoCompensation(
  compensation: GustoCompensation,
  externalEmployeeId: string,
): NormalizedCompensation {
  if (
    !compensation.uuid ||
    !compensation.job_uuid ||
    compensation.rate == null ||
    !compensation.payment_unit ||
    !validDate(compensation.effective_date)
  ) {
    throw new Error("Gusto compensation response is missing verified fields");
  }
  const interval = compensationIntervals[compensation.payment_unit];
  if (!interval) throw new Error("Gusto compensation response has an unsupported payment unit");
  return {
    providerId: "gusto",
    externalEmployeeId,
    externalJobId: compensation.job_uuid,
    amountCents: decimalDollarsToCents(compensation.rate),
    currency: "USD",
    interval,
    effectiveFrom: validDate(compensation.effective_date),
    effectiveTo: null,
    rawUpdatedAt: null,
  };
}

async function connectionFor(tenantId: number) {
  const [connection] = await db
    .select()
    .from(workforceIntegrationConnectionsTable)
    .where(
      and(
        eq(workforceIntegrationConnectionsTable.tenantId, tenantId),
        eq(workforceIntegrationConnectionsTable.providerId, GUSTO_DEFINITION.providerId),
      ),
    )
    .limit(1);
  if (!connection?.providerAccountId) {
    throw new WorkforceProviderOperationUnavailableError("gusto", "workforce synchronization");
  }
  return connection;
}

function displayName(first: string | null, last: string | null, fallback: string): string {
  return [first, last].filter(Boolean).join(" ").trim() || fallback;
}

function normalizeState(status: string | undefined): ProviderConnectionState {
  switch (status) {
    case "pending":
    case "connecting":
      return "connecting";
    case "active":
    case "connected":
      return "connected";
    case "syncing":
      return "syncing";
    case "degraded":
      return "degraded";
    case "reauthorization_required":
      return "reauthorization_required";
    case "error":
      return "error";
    default:
      return "not_connected";
  }
}

export const gustoProvider: WorkforceProvider = {
  definition: GUSTO_DEFINITION,

  async getConnectionStatus(context: ProviderContext): Promise<ProviderConnectionStatus> {
    const [connection] = await db
      .select({
        status: workforceIntegrationConnectionsTable.status,
        providerAccountId: workforceIntegrationConnectionsTable.providerAccountId,
        scopes: workforceIntegrationConnectionsTable.scopes,
        connectedAt: workforceIntegrationConnectionsTable.connectedAt,
        lastSuccessfulSyncAt: workforceIntegrationConnectionsTable.lastSuccessfulSyncAt,
        lastSyncAttemptAt: workforceIntegrationConnectionsTable.lastSyncAttemptAt,
        lastError: workforceIntegrationConnectionsTable.lastError,
      })
      .from(workforceIntegrationConnectionsTable)
      .where(
        and(
          eq(workforceIntegrationConnectionsTable.tenantId, context.tenantId),
          eq(workforceIntegrationConnectionsTable.providerId, GUSTO_DEFINITION.providerId),
        ),
      )
      .limit(1);

    return {
      providerId: GUSTO_DEFINITION.providerId,
      state: normalizeState(connection?.status),
      providerAccountId: connection?.providerAccountId ?? null,
      scopes: connection?.scopes ?? [],
      connectedAt: connection?.connectedAt?.toISOString() ?? null,
      lastSuccessfulSyncAt: connection?.lastSuccessfulSyncAt?.toISOString() ?? null,
      lastSyncAttemptAt: connection?.lastSyncAttemptAt?.toISOString() ?? null,
      lastError: connection?.lastError ?? null,
    };
  },

  async listEmployees(context) {
    const connection = await connectionFor(context.tenantId);
    const companyId = connection.providerAccountId!;
    if (!connection.scopes.includes("employees:read")) {
      throw new WorkforceProviderOperationUnavailableError("gusto", "employees:read scope");
    }
    const accessToken = await getFreshGustoAccessToken(context.tenantId);
    const employees = await new GustoClient(loadGustoConfig()).request<GustoEmployee[]>(
      `/v1/companies/${encodeURIComponent(companyId)}/employees`,
      { method: "GET" },
      accessToken,
    );
    return employees.map((employee) => {
      if (!employee.uuid) throw new Error("Gusto employee response is missing uuid");
      const firstName =
        employee.preferred_first_name?.trim() || employee.first_name?.trim() || null;
      const lastName = employee.last_name?.trim() || null;
      const primaryJob = employee.jobs?.find((job) => job.primary) ?? employee.jobs?.[0];
      const email = employee.work_email?.trim() || employee.email?.trim() || null;
      const terminationDate =
        employee.terminations
          ?.map((termination) => termination.effective_date)
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1) ?? null;
      return {
        providerId: "gusto",
        externalId: employee.uuid,
        firstName,
        lastName,
        displayName: displayName(firstName, lastName, email ?? "Unnamed employee"),
        email,
        phone: employee.phone?.trim() || null,
        employmentType: "employee" as const,
        employmentStatus: employee.terminated ? ("terminated" as const) : ("active" as const),
        jobTitle: primaryJob?.title?.trim() || null,
        hireDate: primaryJob?.hire_date ?? null,
        terminationDate,
        rawUpdatedAt: null,
        providerJobIds: employee.jobs?.flatMap((job) => (job.uuid ? [job.uuid] : [])) ?? [],
      };
    });
  },

  async listContractors() {
    throw new WorkforceProviderOperationUnavailableError(
      "gusto",
      "contractor synchronization (current endpoint contract not verified)",
    );
  },

  async listPayrollRuns(context): Promise<NormalizedPayrollRun[]> {
    const connection = await connectionFor(context.tenantId);
    if (!connection.scopes.includes("payrolls:read")) {
      throw new WorkforceProviderOperationUnavailableError("gusto", "payrolls:read scope");
    }
    const accessToken = await getFreshGustoAccessToken(context.tenantId);
    const all: NormalizedPayrollRun[] = [];
    for (let page = 1; ; page += 1) {
      const query = new URLSearchParams({
        processing_statuses: "processed,unprocessed",
        payroll_types: "regular,off_cycle,external",
        include: "totals",
        per: "100",
        page: String(page),
      });
      const payrolls = await new GustoClient(loadGustoConfig()).request<GustoPayroll[]>(
        `/v1/companies/${encodeURIComponent(connection.providerAccountId!)}/payrolls?${query}`,
        { method: "GET" },
        accessToken,
      );
      if (!Array.isArray(payrolls)) throw new Error("Gusto payroll response was not a list");
      all.push(...payrolls.map(normalizeGustoPayroll));
      if (payrolls.length < 100) break;
    }
    return all;
  },

  async listCompensations(context): Promise<NormalizedCompensation[]> {
    const connection = await connectionFor(context.tenantId);
    if (!connection.scopes.includes("compensations:read")) {
      throw new WorkforceProviderOperationUnavailableError("gusto", "compensations:read scope");
    }
    if (!connection.scopes.includes("employees:read")) {
      throw new WorkforceProviderOperationUnavailableError("gusto", "employees:read scope");
    }
    const accessToken = await getFreshGustoAccessToken(context.tenantId);
    const employees = await this.listEmployees(context);
    const result: NormalizedCompensation[] = [];
    for (const employee of employees) {
      for (const jobId of employee.providerJobIds ?? []) {
        const values = await new GustoClient(loadGustoConfig()).request<GustoCompensation[]>(
          `/v1/jobs/${encodeURIComponent(jobId)}/compensations`,
          { method: "GET" },
          accessToken,
        );
        if (!Array.isArray(values)) throw new Error("Gusto compensation response was not a list");
        // The default provider response is current-only. Be defensive if a
        // provider returns more than one current record and retain the newest.
        const normalized = values
          .map((value) => normalizeGustoCompensation(value, employee.externalId))
          .sort((a, b) => (b.effectiveFrom ?? "").localeCompare(a.effectiveFrom ?? ""));
        if (normalized[0]) result.push(normalized[0]);
      }
    }
    return result;
  },
};