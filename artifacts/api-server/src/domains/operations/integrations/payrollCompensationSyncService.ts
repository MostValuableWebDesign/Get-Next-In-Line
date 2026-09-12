import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  workforceCapabilitySyncsTable,
  workforceCompensationsTable,
  workforceConnectionEventsTable,
  workforceIntegrationConnectionsTable,
  workforcePayrollRunsTable,
  workforcePeopleTable,
  tenantIntegrationCapabilitiesTable,
} from "@workspace/db";
import { getWorkforceProvider } from "./providerRegistry";
import type { ProviderSyncResult } from "./types";

const SYNC_LOCK_NAMESPACE = 1_947_837_202;
type Capability = "payroll" | "compensation";

// Gusto App Integrations webhooks are intentionally not enabled in this
// phase: without securely persisted verification-token matching, manual
// synchronization is the authoritative source for these read-only views.

async function requireConnection(tenantId: number, providerId: string, capability: Capability) {
  const [assigned] = await db
    .select({ providerId: tenantIntegrationCapabilitiesTable.providerId })
    .from(tenantIntegrationCapabilitiesTable)
    .where(
      and(
        eq(tenantIntegrationCapabilitiesTable.tenantId, tenantId),
        eq(tenantIntegrationCapabilitiesTable.capability, capability),
        eq(tenantIntegrationCapabilitiesTable.providerId, providerId),
        eq(tenantIntegrationCapabilitiesTable.isPrimary, true),
      ),
    )
    .limit(1);
  if (!assigned || assigned.providerId !== providerId) {
    throw Object.assign(new Error(`${providerId} is not the primary owner of ${capability}`), { status: 409 });
  }
  const [connection] = await db
    .select()
    .from(workforceIntegrationConnectionsTable)
    .where(
      and(
        eq(workforceIntegrationConnectionsTable.tenantId, tenantId),
        eq(workforceIntegrationConnectionsTable.providerId, providerId),
      ),
    )
    .limit(1);
  if (!connection || !["connected", "degraded"].includes(connection.status)) {
    throw Object.assign(new Error(`${providerId} is not connected`), { status: 409 });
  }
  return connection;
}

async function updateMetadata(
  tenantId: number,
  providerId: string,
  capability: Capability,
  values: {
    status: string;
    recordsRead?: number;
    recordsWritten?: number;
    lastAttemptAt?: Date;
    lastSuccessfulAt?: Date | null;
    lastError?: string | null;
  },
) {
  await db
    .insert(workforceCapabilitySyncsTable)
    .values({
      tenantId,
      providerId,
      capability,
      status: values.status,
      recordsRead: values.recordsRead ?? 0,
      recordsWritten: values.recordsWritten ?? 0,
      lastAttemptAt: values.lastAttemptAt ?? null,
      lastSuccessfulAt: values.lastSuccessfulAt ?? null,
      lastError: values.lastError ?? null,
    })
    .onConflictDoUpdate({
      target: [
        workforceCapabilitySyncsTable.tenantId,
        workforceCapabilitySyncsTable.providerId,
        workforceCapabilitySyncsTable.capability,
      ],
      set: {
        status: values.status,
        ...(values.recordsRead === undefined ? {} : { recordsRead: values.recordsRead }),
        ...(values.recordsWritten === undefined ? {} : { recordsWritten: values.recordsWritten }),
        ...(values.lastAttemptAt === undefined ? {} : { lastAttemptAt: values.lastAttemptAt }),
        ...(values.lastSuccessfulAt === undefined ? {} : { lastSuccessfulAt: values.lastSuccessfulAt }),
        ...(values.lastError === undefined ? {} : { lastError: values.lastError }),
        updatedAt: new Date(),
      },
    });
}

async function begin(
  connection: typeof workforceIntegrationConnectionsTable.$inferSelect,
  tenantId: number,
  providerId: string,
  capability: Capability,
  attemptedAt: Date,
) {
  await db
    .update(workforceIntegrationConnectionsTable)
    .set({ status: "syncing", lastSyncAttemptAt: attemptedAt })
    .where(eq(workforceIntegrationConnectionsTable.id, connection.id));
  await updateMetadata(tenantId, providerId, capability, {
    status: "syncing",
    lastAttemptAt: attemptedAt,
    lastError: null,
  });
}

async function finishSuccess(
  connection: typeof workforceIntegrationConnectionsTable.$inferSelect,
  tenantId: number,
  providerId: string,
  capability: Capability,
  result: ProviderSyncResult,
) {
  const completedAt = new Date(result.completedAt);
  await updateMetadata(tenantId, providerId, capability, {
    status: "succeeded",
    recordsRead: result.recordsRead,
    recordsWritten: result.recordsWritten,
    lastSuccessfulAt: completedAt,
    lastError: null,
  });
  // A degraded connection can represent another failed capability. Never
  // clear it just because this independent capability succeeded, including
  // when a stale connection row was incorrectly left as connected.
  const failedCapabilities = await db
    .select({
      capability: workforceCapabilitySyncsTable.capability,
      lastError: workforceCapabilitySyncsTable.lastError,
    })
    .from(workforceCapabilitySyncsTable)
    .where(
      and(
        eq(workforceCapabilitySyncsTable.tenantId, tenantId),
        eq(workforceCapabilitySyncsTable.providerId, providerId),
        eq(workforceCapabilitySyncsTable.status, "failed"),
      ),
    );
  const anotherFailed = failedCapabilities.find((entry) => entry.capability !== capability);
  const [currentConnection] = await db
    .select({
      status: workforceIntegrationConnectionsTable.status,
      lastError: workforceIntegrationConnectionsTable.lastError,
    })
    .from(workforceIntegrationConnectionsTable)
    .where(eq(workforceIntegrationConnectionsTable.id, connection.id))
    .limit(1);
  const protectedStatus = ["reauthorization_required", "error", "not_connected", "disconnected"]
    .includes(currentConnection?.status ?? "");
  await db
    .update(workforceIntegrationConnectionsTable)
    .set(
      protectedStatus
        ? {}
        : anotherFailed
          ? { status: "degraded", lastError: anotherFailed.lastError ?? currentConnection?.lastError }
          : { status: "connected", lastSuccessfulSyncAt: completedAt, lastError: null },
    )
    .where(eq(workforceIntegrationConnectionsTable.id, connection.id));
  await db.insert(workforceConnectionEventsTable).values({
    connectionId: connection.id,
    eventType: `${capability}_sync_succeeded`,
    details: JSON.stringify({
      recordsRead: result.recordsRead,
      recordsWritten: result.recordsWritten,
    }),
  });
}

async function finishFailure(
  connection: typeof workforceIntegrationConnectionsTable.$inferSelect,
  tenantId: number,
  providerId: string,
  capability: Capability,
  error: unknown,
) {
  const message = error instanceof Error ? error.message : `${capability} sync failed`;
  await updateMetadata(tenantId, providerId, capability, {
    status: "failed",
    lastError: message,
  });
  await db
    .update(workforceIntegrationConnectionsTable)
    .set({
      status: sql`case when ${workforceIntegrationConnectionsTable.status} = 'reauthorization_required' then 'reauthorization_required' else 'degraded' end`,
      lastError: message,
    })
    .where(eq(workforceIntegrationConnectionsTable.id, connection.id));
  await db.insert(workforceConnectionEventsTable).values({
    connectionId: connection.id,
    eventType: `${capability}_sync_failed`,
    details: JSON.stringify({ error: message }),
  });
}

function result(
  providerId: string,
  tenantId: number,
  startedAt: Date,
  recordsRead: number,
  recordsWritten: number,
): ProviderSyncResult {
  return {
    providerId,
    tenantId,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    status: "succeeded",
    recordsRead,
    recordsWritten,
    errors: [],
  };
}

async function syncPayrollUnlocked(tenantId: number, providerId: string): Promise<ProviderSyncResult> {
  const connection = await requireConnection(tenantId, providerId, "payroll");
  const startedAt = new Date();
  await begin(connection, tenantId, providerId, "payroll", startedAt);
  try {
    const provider = getWorkforceProvider(providerId);
    if (!provider.listPayrollRuns) throw new Error(`${providerId} payroll synchronization is unavailable`);
    const runs = await provider.listPayrollRuns({ tenantId });
    const ids = runs.map((run) => run.externalId);
    if (new Set(ids).size !== ids.length) throw new Error("Provider response contains duplicate payroll IDs");
    await db.transaction(async (tx) => {
      for (const run of runs) {
        await tx
          .insert(workforcePayrollRunsTable)
          .values({
            tenantId,
            providerId,
            externalId: run.externalId,
            status: run.status,
            payPeriodStart: run.payPeriodStart,
            payPeriodEnd: run.payPeriodEnd,
            paymentDate: run.paymentDate,
            processed: run.processed,
            processedDate: run.processedDate,
            calculatedAt: run.calculatedAt ? new Date(run.calculatedAt) : null,
            grossPayCents: run.grossPayCents,
            netPayCents: run.netPayCents,
            currency: run.currency,
            providerUpdatedAt: run.rawUpdatedAt ? new Date(run.rawUpdatedAt) : null,
            lastSyncedAt: startedAt,
          })
          .onConflictDoUpdate({
            target: [
              workforcePayrollRunsTable.tenantId,
              workforcePayrollRunsTable.providerId,
              workforcePayrollRunsTable.externalId,
            ],
            set: {
              status: run.status,
              payPeriodStart: run.payPeriodStart,
              payPeriodEnd: run.payPeriodEnd,
              paymentDate: sql`coalesce(excluded.payment_date, ${workforcePayrollRunsTable.paymentDate})`,
              processed: run.processed,
              processedDate: sql`coalesce(excluded.processed_date, ${workforcePayrollRunsTable.processedDate})`,
              calculatedAt: sql`coalesce(excluded.calculated_at, ${workforcePayrollRunsTable.calculatedAt})`,
              grossPayCents: sql`coalesce(excluded.gross_pay_cents, ${workforcePayrollRunsTable.grossPayCents})`,
              netPayCents: sql`coalesce(excluded.net_pay_cents, ${workforcePayrollRunsTable.netPayCents})`,
              currency: run.currency,
              providerUpdatedAt: sql`coalesce(excluded.provider_updated_at, ${workforcePayrollRunsTable.providerUpdatedAt})`,
              lastSyncedAt: startedAt,
              updatedAt: new Date(),
            },
          });
      }
    });
    const completed = result(providerId, tenantId, startedAt, runs.length, runs.length);
    await finishSuccess(connection, tenantId, providerId, "payroll", completed);
    return completed;
  } catch (error) {
    await finishFailure(connection, tenantId, providerId, "payroll", error);
    throw error;
  }
}

async function syncCompensationUnlocked(tenantId: number, providerId: string): Promise<ProviderSyncResult> {
  const connection = await requireConnection(tenantId, providerId, "compensation");
  const startedAt = new Date();
  await begin(connection, tenantId, providerId, "compensation", startedAt);
  try {
    const provider = getWorkforceProvider(providerId);
    if (!provider.listCompensations) throw new Error(`${providerId} compensation synchronization is unavailable`);
    const compensations = await provider.listCompensations({ tenantId });
    const ids = compensations.map((compensation) => compensation.externalJobId);
    if (new Set(ids).size !== ids.length) throw new Error("Provider response contains duplicate compensation jobs");
    await db.transaction(async (tx) => {
      const employees = compensations.length
        ? await tx
            .select({
              id: workforcePeopleTable.id,
              externalId: workforcePeopleTable.externalId,
            })
            .from(workforcePeopleTable)
            .where(
              and(
                eq(workforcePeopleTable.tenantId, tenantId),
                eq(workforcePeopleTable.providerId, providerId),
                inArray(
                  workforcePeopleTable.externalId,
                  compensations.map((compensation) => compensation.externalEmployeeId),
                ),
              ),
            )
        : [];
      const personByExternalId = new Map(employees.map((person) => [person.externalId, person.id]));
      for (const compensation of compensations) {
        await tx
          .insert(workforceCompensationsTable)
          .values({
            tenantId,
            providerId,
            externalEmployeeId: compensation.externalEmployeeId,
            externalJobId: compensation.externalJobId,
            workforcePersonId: personByExternalId.get(compensation.externalEmployeeId) ?? null,
            amountCents: compensation.amountCents,
            currency: compensation.currency,
            interval: compensation.interval,
            effectiveFrom: compensation.effectiveFrom,
            effectiveTo: compensation.effectiveTo,
            providerUpdatedAt: compensation.rawUpdatedAt ? new Date(compensation.rawUpdatedAt) : null,
            lastSyncedAt: startedAt,
          })
          .onConflictDoUpdate({
            target: [
              workforceCompensationsTable.tenantId,
              workforceCompensationsTable.providerId,
              workforceCompensationsTable.externalJobId,
            ],
            set: {
              externalEmployeeId: compensation.externalEmployeeId,
              workforcePersonId: personByExternalId.get(compensation.externalEmployeeId) ?? null,
              amountCents: compensation.amountCents,
              currency: compensation.currency,
              interval: compensation.interval,
              effectiveFrom: compensation.effectiveFrom,
              effectiveTo: compensation.effectiveTo,
              providerUpdatedAt: compensation.rawUpdatedAt ? new Date(compensation.rawUpdatedAt) : null,
              lastSyncedAt: startedAt,
              updatedAt: new Date(),
            },
          });
      }
    });
    const completed = result(providerId, tenantId, startedAt, compensations.length, compensations.length);
    await finishSuccess(connection, tenantId, providerId, "compensation", completed);
    return completed;
  } catch (error) {
    await finishFailure(connection, tenantId, providerId, "compensation", error);
    throw error;
  }
}

export async function syncPayroll(args: { tenantId: number; providerId: string }) {
  return db.transaction(async (lockTx) => {
    await lockTx.execute(sql`select pg_advisory_xact_lock(${SYNC_LOCK_NAMESPACE}, ${args.tenantId})`);
    return syncPayrollUnlocked(args.tenantId, args.providerId);
  });
}

export async function syncCompensation(args: { tenantId: number; providerId: string }) {
  return db.transaction(async (lockTx) => {
    await lockTx.execute(sql`select pg_advisory_xact_lock(${SYNC_LOCK_NAMESPACE}, ${args.tenantId})`);
    return syncCompensationUnlocked(args.tenantId, args.providerId);
  });
}

export async function listPayroll(tenantId: number) {
  return db
    .select({
      id: workforcePayrollRunsTable.id,
      status: workforcePayrollRunsTable.status,
      payPeriodStart: workforcePayrollRunsTable.payPeriodStart,
      payPeriodEnd: workforcePayrollRunsTable.payPeriodEnd,
      paymentDate: workforcePayrollRunsTable.paymentDate,
      processed: workforcePayrollRunsTable.processed,
      processedDate: workforcePayrollRunsTable.processedDate,
      calculatedAt: workforcePayrollRunsTable.calculatedAt,
      grossPayCents: workforcePayrollRunsTable.grossPayCents,
      netPayCents: workforcePayrollRunsTable.netPayCents,
      currency: workforcePayrollRunsTable.currency,
      lastSyncedAt: workforcePayrollRunsTable.lastSyncedAt,
    })
    .from(workforcePayrollRunsTable)
    .where(eq(workforcePayrollRunsTable.tenantId, tenantId))
    .orderBy(sql`${workforcePayrollRunsTable.payPeriodStart} desc`);
}

export async function listCompensation(tenantId: number) {
  return db
    .select({
      id: workforceCompensationsTable.id,
      workforcePersonId: workforceCompensationsTable.workforcePersonId,
      displayName: workforcePeopleTable.displayName,
      amountCents: workforceCompensationsTable.amountCents,
      currency: workforceCompensationsTable.currency,
      interval: workforceCompensationsTable.interval,
      effectiveFrom: workforceCompensationsTable.effectiveFrom,
      effectiveTo: workforceCompensationsTable.effectiveTo,
      lastSyncedAt: workforceCompensationsTable.lastSyncedAt,
    })
    .from(workforceCompensationsTable)
    .leftJoin(
      workforcePeopleTable,
      and(
        eq(workforcePeopleTable.id, workforceCompensationsTable.workforcePersonId),
        eq(workforcePeopleTable.tenantId, tenantId),
      ),
    )
    .where(eq(workforceCompensationsTable.tenantId, tenantId))
    .orderBy(sql`${workforceCompensationsTable.effectiveFrom} desc`);
}