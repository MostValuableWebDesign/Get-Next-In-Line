import { and, eq, sql } from "drizzle-orm";
import { db, tenantIntegrationCapabilitiesTable } from "@workspace/db";
import { getWorkforceProviderDefinition } from "./providerDefinitions";
import type { WorkforceCapability } from "./types";

const CAPABILITY_ASSIGNMENT_LOCK_NAMESPACE = 1_947_837_203;

export type CapabilityAssignmentResult = {
  assigned: WorkforceCapability[];
  alreadyOwned: WorkforceCapability[];
  conflicts: Array<{ capability: WorkforceCapability; providerId: string }>;
  unavailable: WorkforceCapability[];
};

export async function reconcileProviderCapabilityAssignments({
  tenantId,
  providerId,
  grantedScopes,
}: {
  tenantId: number;
  providerId: string;
  grantedScopes: readonly string[];
}): Promise<CapabilityAssignmentResult> {
  const definition = getWorkforceProviderDefinition(providerId);
  const scopeSet = new Set(grantedScopes);
  const available = definition.capabilities.filter((capability) =>
    (definition.requiredScopes?.[capability] ?? []).every((scope) => scopeSet.has(scope)),
  );
  const unavailable = definition.capabilities.filter(
    (capability) => !available.includes(capability),
  );

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${CAPABILITY_ASSIGNMENT_LOCK_NAMESPACE}, ${tenantId})`,
    );
    const result: CapabilityAssignmentResult = {
      assigned: [],
      alreadyOwned: [],
      conflicts: [],
      unavailable,
    };

    for (const capability of available) {
      const [owner] = await tx
        .select({
          id: tenantIntegrationCapabilitiesTable.id,
          providerId: tenantIntegrationCapabilitiesTable.providerId,
        })
        .from(tenantIntegrationCapabilitiesTable)
        .where(
          and(
            eq(tenantIntegrationCapabilitiesTable.tenantId, tenantId),
            eq(tenantIntegrationCapabilitiesTable.capability, capability),
            eq(tenantIntegrationCapabilitiesTable.isPrimary, true),
          ),
        )
        .limit(1);

      if (owner?.providerId === providerId) {
        result.alreadyOwned.push(capability);
        continue;
      }
      if (owner) {
        result.conflicts.push({ capability, providerId: owner.providerId });
        continue;
      }

      const [existingProviderAssignment] = await tx
        .select({ id: tenantIntegrationCapabilitiesTable.id })
        .from(tenantIntegrationCapabilitiesTable)
        .where(
          and(
            eq(tenantIntegrationCapabilitiesTable.tenantId, tenantId),
            eq(tenantIntegrationCapabilitiesTable.capability, capability),
            eq(tenantIntegrationCapabilitiesTable.providerId, providerId),
          ),
        )
        .limit(1);

      if (existingProviderAssignment) {
        await tx
          .update(tenantIntegrationCapabilitiesTable)
          .set({ isPrimary: true, updatedAt: new Date() })
          .where(eq(tenantIntegrationCapabilitiesTable.id, existingProviderAssignment.id));
      } else {
        await tx.insert(tenantIntegrationCapabilitiesTable).values({
          tenantId,
          capability,
          providerId,
          isPrimary: true,
        });
      }
      result.assigned.push(capability);
    }

    return result;
  });
}