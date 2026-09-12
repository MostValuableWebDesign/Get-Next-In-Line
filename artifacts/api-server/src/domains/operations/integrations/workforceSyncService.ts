import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  sosResourcesTable,
  sosStaffMembersTable,
  tenantIntegrationCapabilitiesTable,
  workforceCapabilitySyncsTable,
  workforceConnectionEventsTable,
  workforceIntegrationConnectionsTable,
  workforcePeopleTable,
  workforceStaffLinksTable,
} from "@workspace/db";
import { getWorkforceProvider } from "./providerRegistry";
import type { NormalizedEmployee } from "./types";

type SyncCounts = { created: number; updated: number; unchanged: number; errors: number };
const SYNC_LOCK_NAMESPACE = 1_947_837_202;

function normalizedEmail(value: string | null): string | null {
  const email = value?.trim().toLowerCase();
  return email || null;
}

function comparable(person: NormalizedEmployee) {
  return {
    personType: person.employmentType,
    firstName: person.firstName,
    lastName: person.lastName,
    displayName: person.displayName,
    email: person.email,
    normalizedEmail: normalizedEmail(person.email),
    phone: person.phone,
    employmentStatus: person.employmentStatus,
    jobTitle: person.jobTitle,
    hireDate: person.hireDate,
    terminationDate: person.terminationDate,
  };
}

async function ownsPrimaryCapability(tenantId: number, capability: string, providerId: string) {
  const [owner] = await db
    .select({ providerId: tenantIntegrationCapabilitiesTable.providerId })
    .from(tenantIntegrationCapabilitiesTable)
    .where(
      and(
        eq(tenantIntegrationCapabilitiesTable.tenantId, tenantId),
        eq(tenantIntegrationCapabilitiesTable.capability, capability),
        eq(tenantIntegrationCapabilitiesTable.isPrimary, true),
      ),
    )
    .limit(1);
  return owner?.providerId === providerId;
}

async function requirePrimaryCapability(tenantId: number, capability: string, providerId: string) {
  if (!(await ownsPrimaryCapability(tenantId, capability, providerId))) {
    throw Object.assign(new Error(`${providerId} is not the primary owner of ${capability}`), {
      status: 409,
    });
  }
}

async function updateCapabilitySync(
  tenantId: number,
  providerId: string,
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
      capability: "employees",
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

async function autoLinkByEmail(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  tenantId: number,
  people: Array<{ id: number; normalizedEmail: string | null }>,
) {
  const emails = [...new Set(people.flatMap((person) => person.normalizedEmail ?? []))];
  if (!emails.length) return;
  const staff = await tx
    .select({ id: sosStaffMembersTable.id, email: sosStaffMembersTable.email })
    .from(sosStaffMembersTable)
    .where(eq(sosStaffMembersTable.tenantId, tenantId));
  const byEmail = new Map<string, number[]>();
  const importedEmailCounts = new Map<string, number>();
  for (const person of people) {
    if (person.normalizedEmail) {
      importedEmailCounts.set(
        person.normalizedEmail,
        (importedEmailCounts.get(person.normalizedEmail) ?? 0) + 1,
      );
    }
  }
  for (const member of staff) {
    const email = normalizedEmail(member.email);
    if (!email || !emails.includes(email)) continue;
    byEmail.set(email, [...(byEmail.get(email) ?? []), member.id]);
  }
  for (const person of people) {
    if (
      !person.normalizedEmail ||
      importedEmailCounts.get(person.normalizedEmail) !== 1 ||
      byEmail.get(person.normalizedEmail)?.length !== 1
    ) continue;
    await tx
      .insert(workforceStaffLinksTable)
      .values({
        tenantId,
        workforcePersonId: person.id,
        gnilStaffId: byEmail.get(person.normalizedEmail)![0],
        linkType: "auto_email",
      })
      .onConflictDoNothing();
  }
}

async function syncWorkforceEmployeesUnlocked({
  tenantId,
  providerId,
}: {
  tenantId: number;
  providerId: string;
}): Promise<SyncCounts> {
  await requirePrimaryCapability(tenantId, "employees", providerId);
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

  const attemptedAt = new Date();
  await db
    .update(workforceIntegrationConnectionsTable)
    .set({ status: "syncing", lastSyncAttemptAt: attemptedAt, lastError: null })
    .where(eq(workforceIntegrationConnectionsTable.id, connection.id));
  await updateCapabilitySync(tenantId, providerId, {
    status: "syncing",
    lastAttemptAt: attemptedAt,
    lastError: null,
  });

  try {
    const provider = getWorkforceProvider(providerId);
    const people: NormalizedEmployee[] = await provider.listEmployees({ tenantId });
    if (
      provider.listContractors &&
      connection.scopes.includes("contractors:read") &&
      (await ownsPrimaryCapability(tenantId, "contractors", providerId))
    ) {
      people.push(...(await provider.listContractors({ tenantId })));
    }
    if (new Set(people.map((person) => person.externalId)).size !== people.length) {
      throw new Error("Provider response contains duplicate workforce IDs");
    }

    const counts = await db.transaction(async (tx) => {
      const existing = people.length
        ? await tx
            .select()
            .from(workforcePeopleTable)
            .where(
              and(
                eq(workforcePeopleTable.tenantId, tenantId),
                eq(workforcePeopleTable.providerId, providerId),
                inArray(
                  workforcePeopleTable.externalId,
                  people.map((person) => person.externalId),
                ),
              ),
            )
        : [];
      const existingByExternalId = new Map(existing.map((person) => [person.externalId, person]));
      const result: SyncCounts = { created: 0, updated: 0, unchanged: 0, errors: 0 };
      const synced: Array<{ id: number; normalizedEmail: string | null }> = [];
      for (const person of people) {
        const values = comparable(person);
        const previous = existingByExternalId.get(person.externalId);
        const changed =
          !previous ||
          Object.entries(values).some(
            ([key, value]) => previous[key as keyof typeof previous] !== value,
          );
        if (!previous) result.created += 1;
        else if (changed) result.updated += 1;
        else result.unchanged += 1;
        const [saved] = await tx
          .insert(workforcePeopleTable)
          .values({
            tenantId,
            providerId,
            externalId: person.externalId,
            ...values,
            providerUpdatedAt: person.rawUpdatedAt ? new Date(person.rawUpdatedAt) : null,
            lastSyncedAt: attemptedAt,
          })
          .onConflictDoUpdate({
            target: [
              workforcePeopleTable.tenantId,
              workforcePeopleTable.providerId,
              workforcePeopleTable.externalId,
            ],
            set: { ...values, lastSyncedAt: attemptedAt, updatedAt: new Date() },
          })
          .returning({ id: workforcePeopleTable.id, normalizedEmail: workforcePeopleTable.normalizedEmail });
        synced.push(saved);
      }
      await autoLinkByEmail(tx, tenantId, synced);
      await tx
        .insert(workforceCapabilitySyncsTable)
        .values({
          tenantId,
          providerId,
          capability: "employees",
          status: "succeeded",
          recordsRead: people.length,
          recordsWritten: result.created + result.updated,
          lastAttemptAt: attemptedAt,
          lastSuccessfulAt: new Date(),
          lastError: null,
        })
        .onConflictDoUpdate({
          target: [
            workforceCapabilitySyncsTable.tenantId,
            workforceCapabilitySyncsTable.providerId,
            workforceCapabilitySyncsTable.capability,
          ],
          set: {
            status: "succeeded",
            recordsRead: people.length,
            recordsWritten: result.created + result.updated,
            lastAttemptAt: attemptedAt,
            lastSuccessfulAt: new Date(),
            lastError: null,
            updatedAt: new Date(),
          },
        });
      const failedCapabilities = await tx
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
      const [currentConnection] = await tx
        .select({
          status: workforceIntegrationConnectionsTable.status,
          lastError: workforceIntegrationConnectionsTable.lastError,
        })
        .from(workforceIntegrationConnectionsTable)
        .where(eq(workforceIntegrationConnectionsTable.id, connection.id))
        .limit(1);
      const protectedStatus = [
        "reauthorization_required",
        "error",
        "not_connected",
        "disconnected",
      ].includes(currentConnection?.status ?? "");
      const otherFailure = failedCapabilities.find((entry) => entry.capability !== "employees");
      await tx
        .update(workforceIntegrationConnectionsTable)
        .set({
          ...(protectedStatus
            ? {}
            : otherFailure
              ? {
                  status: "degraded",
                  lastError: otherFailure.lastError ?? currentConnection?.lastError,
                }
              : {
                  status: "connected",
                  lastSuccessfulSyncAt: new Date(),
                  lastError: null,
                }),
        })
        .where(eq(workforceIntegrationConnectionsTable.id, connection.id));
      await tx.insert(workforceConnectionEventsTable).values({
        connectionId: connection.id,
        eventType: "workforce_sync_succeeded",
        details: JSON.stringify(result),
      });
      return result;
    });
    return counts;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Workforce sync failed";
    await db.transaction(async (tx) => {
      await tx
        .insert(workforceCapabilitySyncsTable)
        .values({
          tenantId,
          providerId,
          capability: "employees",
          status: "failed",
          lastAttemptAt: attemptedAt,
          lastError: message,
        })
        .onConflictDoUpdate({
          target: [
            workforceCapabilitySyncsTable.tenantId,
            workforceCapabilitySyncsTable.providerId,
            workforceCapabilitySyncsTable.capability,
          ],
          set: {
            status: "failed",
            lastAttemptAt: attemptedAt,
            lastError: message,
            updatedAt: new Date(),
          },
        });
      await tx
        .update(workforceIntegrationConnectionsTable)
        .set({
          status: sql`case when ${workforceIntegrationConnectionsTable.status} = 'reauthorization_required' then 'reauthorization_required' else 'degraded' end`,
          lastError: message,
        })
        .where(eq(workforceIntegrationConnectionsTable.id, connection.id));
      await tx.insert(workforceConnectionEventsTable).values({
        connectionId: connection.id,
        eventType: "workforce_sync_failed",
        details: JSON.stringify({ error: message }),
      });
    });
    throw error;
  }
}

export async function syncWorkforceEmployees(args: {
  tenantId: number;
  providerId: string;
}): Promise<SyncCounts> {
  return db.transaction(async (lockTx) => {
    await lockTx.execute(
      sql`select pg_advisory_xact_lock(${SYNC_LOCK_NAMESPACE}, ${args.tenantId})`,
    );
    return syncWorkforceEmployeesUnlocked(args);
  });
}

export async function listWorkforcePeople(tenantId: number) {
  return db
    .select({
      id: workforcePeopleTable.id,
      providerId: workforcePeopleTable.providerId,
      externalId: workforcePeopleTable.externalId,
      personType: workforcePeopleTable.personType,
      displayName: workforcePeopleTable.displayName,
      email: workforcePeopleTable.email,
      phone: workforcePeopleTable.phone,
      employmentStatus: workforcePeopleTable.employmentStatus,
      jobTitle: workforcePeopleTable.jobTitle,
      lastSyncedAt: workforcePeopleTable.lastSyncedAt,
      linkId: workforceStaffLinksTable.id,
      linkType: workforceStaffLinksTable.linkType,
      gnilStaffId: workforceStaffLinksTable.gnilStaffId,
      gnilResourceId: workforceStaffLinksTable.gnilResourceId,
    })
    .from(workforcePeopleTable)
    .leftJoin(
      workforceStaffLinksTable,
      and(
        eq(workforceStaffLinksTable.workforcePersonId, workforcePeopleTable.id),
        eq(workforceStaffLinksTable.tenantId, tenantId),
      ),
    )
    .where(eq(workforcePeopleTable.tenantId, tenantId))
    .orderBy(workforcePeopleTable.displayName);
}

export async function setWorkforceStaffLink({
  tenantId,
  personId,
  staffId,
  resourceId,
}: {
  tenantId: number;
  personId: number;
  staffId?: number | null;
  resourceId?: number | null;
}) {
  if (staffId != null && resourceId != null) throw Object.assign(new Error("Choose a staff member or resource, not both"), { status: 400 });
  return db.transaction(async (tx) => {
    const [person] = await tx.select({ id: workforcePeopleTable.id }).from(workforcePeopleTable).where(and(eq(workforcePeopleTable.id, personId), eq(workforcePeopleTable.tenantId, tenantId))).limit(1);
    if (!person) throw Object.assign(new Error("Workforce person not found"), { status: 404 });
    await tx.delete(workforceStaffLinksTable).where(and(eq(workforceStaffLinksTable.tenantId, tenantId), eq(workforceStaffLinksTable.workforcePersonId, personId)));
    if (staffId == null && resourceId == null) return null;
    if (staffId != null) {
      const [staff] = await tx.select({ id: sosStaffMembersTable.id }).from(sosStaffMembersTable).where(and(eq(sosStaffMembersTable.id, staffId), eq(sosStaffMembersTable.tenantId, tenantId))).limit(1);
      if (!staff) throw Object.assign(new Error("GNIL staff member not found"), { status: 404 });
    }
    if (resourceId != null) {
      const [resource] = await tx.select({ id: sosResourcesTable.id }).from(sosResourcesTable).where(and(eq(sosResourcesTable.id, resourceId), eq(sosResourcesTable.tenantId, tenantId))).limit(1);
      if (!resource) throw Object.assign(new Error("GNIL resource not found"), { status: 404 });
    }
    const [link] = await tx.insert(workforceStaffLinksTable).values({ tenantId, workforcePersonId: personId, gnilStaffId: staffId ?? null, gnilResourceId: resourceId ?? null, linkType: "manual" }).returning();
    return link;
  });
}