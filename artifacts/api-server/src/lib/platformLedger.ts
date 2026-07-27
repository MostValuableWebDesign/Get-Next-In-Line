import { db, platformLedgerEntriesTable, sosAppointmentsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

/**
 * Platform compliance ledger — append-only capture of money-relevant events.
 *
 * Every entry is keyed by a unique (source, sourceRef) pair so capture is
 * idempotent: re-emitting the same event (retries, webhook replays, the
 * backfill migration racing a live hook) can never double-count money.
 * Rows are immutable at the DB level (append-only trigger).
 */

export type PlatformLedgerSource =
  | "module_subscription"
  | "visit_checkout"
  | "plan_purchase"
  | "plan_renewal"
  | "deposit_captured"
  | "deposit_released"
  | "deposit_failed";

export interface PlatformLedgerEvent {
  source: PlatformLedgerSource;
  /** Stable reference to the originating row, e.g. "tenant_modules:12". */
  sourceRef: string;
  tenantId: number | null;
  category: string;
  description?: string | null;
  /** Dollars, e.g. "25.00". 0 for outcome-only events. */
  amount: string;
  wholesaleAmount?: string | null;
  /** Platform's realized margin — 0 unless this is a marked-up subscription charge. */
  platformMargin?: string;
  occurredAt: Date;
}

/**
 * Record ledger entries without ever throwing: a reporting-ledger failure
 * must not abort the money operation itself. Failures are logged loudly and
 * the missed event remains recoverable via the idempotent backfill.
 */
export async function recordLedgerEventsSafe(events: PlatformLedgerEvent[]): Promise<void> {
  if (events.length === 0) return;
  try {
    await db
      .insert(platformLedgerEntriesTable)
      .values(
        events.map((e) => ({
          source: e.source,
          sourceRef: e.sourceRef,
          tenantId: e.tenantId,
          category: e.category,
          description: e.description ?? null,
          amount: e.amount,
          wholesaleAmount: e.wholesaleAmount ?? null,
          platformMargin: e.platformMargin ?? "0",
          occurredAt: e.occurredAt,
        })),
      )
      .onConflictDoNothing();
  } catch (err) {
    logger.error(
      { err, sourceRefs: events.map((e) => `${e.source}:${e.sourceRef}`) },
      "PLATFORM LEDGER WRITE FAILED — compliance ledger is missing entries (recoverable via backfill)",
    );
  }
}

/** Ledger sources for terminal deposit-hold outcomes. */
const DEPOSIT_OUTCOME_SOURCES: Record<string, PlatformLedgerSource> = {
  captured: "deposit_captured",
  released: "deposit_released",
  failed: "deposit_failed",
};

/**
 * Record the terminal outcome of a deposit hold. Captured holds carry the
 * captured fee amount; released/failed outcomes land as 0-amount entries so
 * outcome counts are auditable. No-op for non-terminal statuses.
 */
export async function recordDepositOutcomeSafe(hold: {
  id: number;
  appointmentId: number;
  status: string;
  feeAmount: string;
  outcomeReason: string | null;
  resolvedAt: Date | null;
}): Promise<void> {
  const source = DEPOSIT_OUTCOME_SOURCES[hold.status];
  if (!source) return;
  try {
    const [appt] = await db
      .select({ tenantId: sosAppointmentsTable.tenantId })
      .from(sosAppointmentsTable)
      .where(eq(sosAppointmentsTable.id, hold.appointmentId));
    await recordLedgerEventsSafe([
      {
        source,
        sourceRef: `sos_deposit_holds:${hold.id}`,
        tenantId: appt?.tenantId ?? null,
        category: "Deposits",
        description: hold.outcomeReason,
        amount: hold.status === "captured" ? hold.feeAmount : "0",
        occurredAt: hold.resolvedAt ?? new Date(),
      },
    ]);
  } catch (err) {
    logger.error({ err, holdId: hold.id }, "Failed to record deposit outcome in platform ledger");
  }
}
