import { createHash, randomBytes } from "crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import {
  db,
  workforceConnectionEventsTable,
  workforceIntegrationConnectionsTable,
  workforceOAuthStatesTable,
} from "@workspace/db";
import { decryptToken, encryptToken } from "../../../../lib/partnerCrypto";
import { GustoApiError, GustoClient, loadGustoConfig } from "./GustoClient";
import { reconcileConnectedProviderCapabilities } from "../capabilityAssignmentService";

const PROVIDER_ID = "gusto";
const STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_EARLY_MS = 5 * 60 * 1000;
const REFRESH_LOCK_NAMESPACE = 1_947_837_201;
const LIFECYCLE_LOCK_NAMESPACE = 1_947_837_202;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function recordEvent(
  connectionId: number,
  eventType: string,
  details?: Record<string, unknown>,
): Promise<void> {
  await db.insert(workforceConnectionEventsTable).values({
    connectionId,
    eventType,
    details: details ? JSON.stringify(details) : null,
  });
}

export async function startGustoConnection(
  tenantId: number,
  sessionId: string,
): Promise<{ authorizationUrl: string }> {
  const client = new GustoClient(loadGustoConfig());
  const rawState = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + STATE_TTL_MS);
  return db.transaction(async (lockTx) => {
  await lockTx.execute(
    sql`select pg_advisory_xact_lock(${LIFECYCLE_LOCK_NAMESPACE}, ${tenantId})`,
  );
  let [connection] = await lockTx
    .select({
      id: workforceIntegrationConnectionsTable.id,
      status: workforceIntegrationConnectionsTable.status,
    })
    .from(workforceIntegrationConnectionsTable)
    .where(
      and(
        eq(workforceIntegrationConnectionsTable.tenantId, tenantId),
        eq(workforceIntegrationConnectionsTable.providerId, PROVIDER_ID),
      ),
    )
    .limit(1);
  if (!connection) {
    [connection] = await lockTx
      .insert(workforceIntegrationConnectionsTable)
      .values({ tenantId, providerId: PROVIDER_ID, status: "connecting", lastError: null })
      .returning({
        id: workforceIntegrationConnectionsTable.id,
        status: workforceIntegrationConnectionsTable.status,
      });
  } else if (!["connected", "degraded", "reauthorization_required", "syncing"].includes(connection.status)) {
    [connection] = await lockTx
      .update(workforceIntegrationConnectionsTable)
      .set({ status: "connecting", lastError: null, updatedAt: new Date() })
      .where(eq(workforceIntegrationConnectionsTable.id, connection.id))
      .returning({
        id: workforceIntegrationConnectionsTable.id,
        status: workforceIntegrationConnectionsTable.status,
      });
  }

  await lockTx.insert(workforceOAuthStatesTable).values({
    tenantId,
    providerId: PROVIDER_ID,
    stateHash: hash(rawState),
    sessionBindingHash: hash(sessionId),
    expiresAt,
  });
  await lockTx.insert(workforceConnectionEventsTable).values({
    connectionId: connection.id,
    eventType: "connection_started",
    details: JSON.stringify({ expiresAt: expiresAt.toISOString() }),
  });
  return { authorizationUrl: client.buildAuthorizationUrl(rawState) };
  });
}

export class InvalidOAuthStateError extends Error {
  constructor(message = "Invalid, expired, or already-used OAuth state") {
    super(message);
    this.name = "InvalidOAuthStateError";
  }
}

export async function completeGustoConnection(
  rawState: string,
  code: string,
  sessionId: string,
): Promise<{ tenantId: number; status: "connected" }> {
  const stateHash = hash(rawState);
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const [state] = await tx
      .select()
      .from(workforceOAuthStatesTable)
      .where(
        and(
          eq(workforceOAuthStatesTable.stateHash, stateHash),
          eq(workforceOAuthStatesTable.providerId, PROVIDER_ID),
          eq(workforceOAuthStatesTable.sessionBindingHash, hash(sessionId)),
          isNull(workforceOAuthStatesTable.consumedAt),
          gt(workforceOAuthStatesTable.expiresAt, now),
        ),
      )
      .limit(1);
    if (!state) throw new InvalidOAuthStateError();
    const [claimed] = await tx
      .update(workforceOAuthStatesTable)
      .set({ consumedAt: now })
      .where(
        and(
          eq(workforceOAuthStatesTable.id, state.id),
          isNull(workforceOAuthStatesTable.consumedAt),
        ),
      )
      .returning({ tenantId: workforceOAuthStatesTable.tenantId });
    if (!claimed) throw new InvalidOAuthStateError();
    return claimed;
  });

  const completion = await db.transaction(async (lockTx) => {
  await lockTx.execute(
    sql`select pg_advisory_xact_lock(${LIFECYCLE_LOCK_NAMESPACE}, ${result.tenantId})`,
  );
  const [connection] = await lockTx
    .select({
      id: workforceIntegrationConnectionsTable.id,
      status: workforceIntegrationConnectionsTable.status,
      accessTokenEncrypted: workforceIntegrationConnectionsTable.accessTokenEncrypted,
      refreshTokenEncrypted: workforceIntegrationConnectionsTable.refreshTokenEncrypted,
      providerAccountId: workforceIntegrationConnectionsTable.providerAccountId,
    })
    .from(workforceIntegrationConnectionsTable)
    .where(
      and(
        eq(workforceIntegrationConnectionsTable.tenantId, result.tenantId),
        eq(workforceIntegrationConnectionsTable.providerId, PROVIDER_ID),
      ),
    )
    .limit(1);
  if (!connection) {
    throw new InvalidOAuthStateError("Gusto connection is no longer available");
  }

  try {
    const client = new GustoClient(loadGustoConfig());
    const tokens = await client.exchangeAuthorizationCode(code);
    const tokenInfo = await client.getTokenInfo(tokens.accessToken);
    if (tokenInfo.resourceType !== "Company" || !tokenInfo.resourceUuid) {
      throw new GustoApiError("Gusto did not authorize a company-scoped token", null, false);
    }
    await lockTx
      .update(workforceIntegrationConnectionsTable)
      .set({
        status: "connected",
        accessTokenEncrypted: encryptToken(tokens.accessToken),
        refreshTokenEncrypted: encryptToken(tokens.refreshToken),
        tokenExpiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
        providerAccountId: tokenInfo.resourceUuid,
        scopes: tokenInfo.scopes,
        connectedAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(workforceIntegrationConnectionsTable.id, connection.id));
    await lockTx.insert(workforceConnectionEventsTable).values({
      connectionId: connection.id,
      eventType: "authorization_succeeded",
      details: JSON.stringify({
        providerAccountId: tokenInfo.resourceUuid,
        scopes: tokenInfo.scopes,
      }),
    });
    return {
      tenantId: result.tenantId,
      status: "connected" as const,
      scopes: tokenInfo.scopes,
    };
  } catch (error) {
     const message = "Gusto authorization failed";
     const hasUsableConnection =
       Boolean(connection?.accessTokenEncrypted && connection.refreshTokenEncrypted) &&
       Boolean(connection?.providerAccountId);
     const preserveStatus =
       hasUsableConnection &&
       ["connected", "degraded", "syncing"].includes(connection?.status ?? "");
     const preserveReauthorization = connection?.status === "reauthorization_required";
     if (!preserveStatus && !preserveReauthorization) {
       await lockTx
         .update(workforceIntegrationConnectionsTable)
         .set({ status: "error", lastError: message, updatedAt: new Date() })
         .where(eq(workforceIntegrationConnectionsTable.id, connection.id));
     }
    await lockTx.insert(workforceConnectionEventsTable).values({
       connectionId: connection.id,
      eventType: "authorization_failed",
      details: JSON.stringify({ message }),
    });
    return { error };
  }
  });
  if ("error" in completion) throw completion.error;
  try {
    await reconcileConnectedProviderCapabilities({
      tenantId: completion.tenantId,
      providerId: PROVIDER_ID,
    });
  } catch {
    // OAuth credentials remain valid. The reconciliation service records a
    // safe degraded state and can be retried independently.
  }
  return completion;
}

export async function disconnectGusto(tenantId: number): Promise<void> {
  await db.transaction(async (tx) => {
  await tx.execute(sql`select pg_advisory_xact_lock(${LIFECYCLE_LOCK_NAMESPACE}, ${tenantId})`);
  const [connection] = await tx
    .update(workforceIntegrationConnectionsTable)
    .set({
      status: "not_connected",
      accessTokenEncrypted: null,
      refreshTokenEncrypted: null,
      tokenExpiresAt: null,
      providerAccountId: null,
      scopes: [],
      connectedAt: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workforceIntegrationConnectionsTable.tenantId, tenantId),
        eq(workforceIntegrationConnectionsTable.providerId, PROVIDER_ID),
      ),
    )
    .returning({ id: workforceIntegrationConnectionsTable.id });
  if (connection) {
    await tx.insert(workforceConnectionEventsTable).values({
      connectionId: connection.id,
      eventType: "disconnected",
    });
  }
  });
}

export async function getFreshGustoAccessToken(tenantId: number): Promise<string> {
  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${REFRESH_LOCK_NAMESPACE}, ${tenantId})`,
    );
    const [connection] = await tx
      .select()
      .from(workforceIntegrationConnectionsTable)
      .where(
        and(
          eq(workforceIntegrationConnectionsTable.tenantId, tenantId),
          eq(workforceIntegrationConnectionsTable.providerId, PROVIDER_ID),
        ),
      )
      .limit(1);
    if (
      !connection?.accessTokenEncrypted ||
      !connection.refreshTokenEncrypted ||
      !connection.tokenExpiresAt
    ) {
      throw new GustoApiError("Gusto is not connected", null, false);
    }
    if (connection.tokenExpiresAt.getTime() > Date.now() + REFRESH_EARLY_MS) {
      return decryptToken(connection.accessTokenEncrypted);
    }

    try {
      const tokens = await new GustoClient(loadGustoConfig()).refreshAccessToken(
        decryptToken(connection.refreshTokenEncrypted),
      );
      await tx
        .update(workforceIntegrationConnectionsTable)
        .set({
          status: "connected",
          accessTokenEncrypted: encryptToken(tokens.accessToken),
          refreshTokenEncrypted: encryptToken(tokens.refreshToken),
          tokenExpiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(workforceIntegrationConnectionsTable.id, connection.id));
      await tx.insert(workforceConnectionEventsTable).values({
        connectionId: connection.id,
        eventType: "token_refresh_succeeded",
      });
      return tokens.accessToken;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Token refresh failed";
      await tx
        .update(workforceIntegrationConnectionsTable)
        .set({ status: "reauthorization_required", lastError: message, updatedAt: new Date() })
        .where(eq(workforceIntegrationConnectionsTable.id, connection.id));
      await tx.insert(workforceConnectionEventsTable).values({
        connectionId: connection.id,
        eventType: "token_refresh_failed",
        details: JSON.stringify({ message }),
      });
      return { error };
    }
  });
  if (typeof result === "string") return result;
  throw result.error;
}