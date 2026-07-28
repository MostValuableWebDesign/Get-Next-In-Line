import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  db,
  tenantsTable,
  clientProfilesTable,
  engagementRulesTable,
  messagesTable,
} from "@workspace/db";
import { and, eq, like } from "drizzle-orm";
import {
  handleSendReminder,
  handleRebookingNudge,
  reapStalePendingMessages,
  runConciergeTick,
  CONCIERGE_LOCK_KEY,
  STALE_PENDING_MS,
} from "../concierge";
import { pool } from "@workspace/db";

// ---------------------------------------------------------------------------
// Unit/integration tests for the concierge worker job handlers against the
// real dev database, on the simulated-SMS path (no Twilio creds).
// ---------------------------------------------------------------------------

delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `worker-${Date.now()}-${process.pid}`;
const NOW = new Date("2026-07-22T12:00:00.000Z");

let tenantId: number;
let reminderRuleId: number;
let nudgeRuleId: number;
let dueSoonId: number; // next visit in 6h — inside 24h lead window
let farOutId: number; // next visit in 5 days — outside window
let overdueId: number; // 40 days since last visit, 30-day cycle — overdue
let onCycleId: number; // 20 days since last visit, 30-day cycle — not due

const PHONE_PREFIX = "+1555987";

async function logsFor(profileId: number, jobType: string) {
  return db
    .select()
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.clientProfileId, profileId),
        eq(messagesTable.kind, jobType),
      ),
    );
}

beforeAll(async () => {
  const [tenant] = await db
    .insert(tenantsTable)
    .values({ brandName: `Worker ${RUN}`, subdomain: RUN, status: "active" })
    .returning({ id: tenantsTable.id });
  tenantId = tenant.id;

  const rules = await db
    .insert(engagementRulesTable)
    .values([
      {
        tenantId,
        ruleType: "reminder",
        isActive: true,
        config: { leadHours: 24, template: "Reminder for {{name}} at {{when}}" },
      },
      {
        tenantId,
        ruleType: "rebooking_nudge",
        isActive: true,
        config: { cooldownDays: 7, template: "{{name}}, it has been {{days}} days!" },
      },
    ])
    .returning({ id: engagementRulesTable.id });
  [reminderRuleId, nudgeRuleId] = rules.map((r) => r.id);

  const hours = (n: number) => new Date(NOW.getTime() + n * 3600_000);
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

  const profiles = await db
    .insert(clientProfilesTable)
    .values([
      { tenantId, name: "Due Soon", phone: `${PHONE_PREFIX}0001`, nextVisitAt: hours(6) },
      { tenantId, name: "Far Out", phone: `${PHONE_PREFIX}0002`, nextVisitAt: hours(120) },
      {
        tenantId,
        name: "Overdue",
        phone: `${PHONE_PREFIX}0003`,
        lastVisitAt: daysAgo(40),
        averageCycleDays: 30,
      },
      {
        tenantId,
        name: "On Cycle",
        phone: `${PHONE_PREFIX}0004`,
        lastVisitAt: daysAgo(20),
        averageCycleDays: 30,
      },
    ])
    .returning({ id: clientProfilesTable.id });
  [dueSoonId, farOutId, overdueId, onCycleId] = profiles.map((p) => p.id);
});

afterAll(async () => {
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId)); // cascades
  await db.delete(messagesTable).where(like(messagesTable.toNumber, `${PHONE_PREFIX}%`));
});

describe("SEND_REMINDER handler", () => {
  it("reminds clients inside the lead window, logs the send, and skips others", async () => {
    const dispatched = await handleSendReminder(NOW);
    expect(dispatched).toBeGreaterThanOrEqual(1);

    const logs = await logsFor(dueSoonId, "send_reminder");
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("simulated");
    expect(logs[0].ruleId).toBe(reminderRuleId);
    expect(logs[0].body).toContain("Reminder for Due Soon");

    expect(await logsFor(farOutId, "send_reminder")).toHaveLength(0);
  });

  it("does not double-send within the same lead window", async () => {
    await handleSendReminder(NOW);
    expect(await logsFor(dueSoonId, "send_reminder")).toHaveLength(1);
  });

  it("skips entirely when the reminder rule is inactive", async () => {
    await db
      .update(engagementRulesTable)
      .set({ isActive: false })
      .where(eq(engagementRulesTable.id, reminderRuleId));
    await db
      .delete(messagesTable)
      .where(eq(messagesTable.clientProfileId, dueSoonId));

    await handleSendReminder(NOW);
    expect(await logsFor(dueSoonId, "send_reminder")).toHaveLength(0);

    await db
      .update(engagementRulesTable)
      .set({ isActive: true })
      .where(eq(engagementRulesTable.id, reminderRuleId));
  });
});

describe("REBOOKING_NUDGE handler", () => {
  it("nudges overdue clients with the templated day count and skips on-cycle clients", async () => {
    const dispatched = await handleRebookingNudge(NOW);
    expect(dispatched).toBeGreaterThanOrEqual(1);

    const logs = await logsFor(overdueId, "rebooking_nudge");
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("simulated");
    expect(logs[0].ruleId).toBe(nudgeRuleId);
    expect(logs[0].body).toBe(
      "Overdue, it has been 40 days!",
    );

    expect(await logsFor(onCycleId, "rebooking_nudge")).toHaveLength(0);
  });

  it("respects the cooldown — no second nudge in the same window", async () => {
    await handleRebookingNudge(NOW);
    expect(await logsFor(overdueId, "rebooking_nudge")).toHaveLength(1);
  });

  it("skips entirely when the nudge rule is inactive", async () => {
    await db
      .update(engagementRulesTable)
      .set({ isActive: false })
      .where(eq(engagementRulesTable.id, nudgeRuleId));
    await db
      .delete(messagesTable)
      .where(eq(messagesTable.clientProfileId, overdueId));

    await handleRebookingNudge(NOW);
    expect(await logsFor(overdueId, "rebooking_nudge")).toHaveLength(0);

    await db
      .update(engagementRulesTable)
      .set({ isActive: true })
      .where(eq(engagementRulesTable.id, nudgeRuleId));
  });
});

describe("stale pending reaper", () => {
  async function insertPending(createdAt: Date, direction = "outbound") {
    const [row] = await db
      .insert(messagesTable)
      .values({
        tenantId,
        clientProfileId: dueSoonId,
        direction,
        kind: "send_reminder",
        channel: "sms",
        toNumber: `${PHONE_PREFIX}0001`,
        body: "stuck",
        status: "pending",
        createdAt,
      })
      .returning();
    return row;
  }

  it("marks pending outbound logs older than the threshold as failed with a clear error", async () => {
    const stale = await insertPending(new Date(NOW.getTime() - STALE_PENDING_MS - 60_000));
    const fresh = await insertPending(new Date(NOW.getTime() - 60_000));

    const reaped = await reapStalePendingMessages(NOW);
    expect(reaped).toBeGreaterThanOrEqual(1);

    const [staleRow] = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.id, stale.id));
    expect(staleRow.status).toBe("failed");
    expect(staleRow.errorCode).toBe("stale_pending");
    expect(staleRow.errorMessage).toMatch(/stuck in pending/i);

    const [freshRow] = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.id, fresh.id));
    expect(freshRow.status).toBe("pending");

    await db.delete(messagesTable).where(eq(messagesTable.id, fresh.id));
    await db.delete(messagesTable).where(eq(messagesTable.id, stale.id));
  });

  it("lets a reminder be re-sent after its stuck pending log is reaped", async () => {
    // Simulate a crash mid-send: clear prior logs, leave only a stale pending row.
    await db.delete(messagesTable).where(eq(messagesTable.clientProfileId, dueSoonId));
    await insertPending(new Date(NOW.getTime() - STALE_PENDING_MS - 60_000));

    // Without reaping, the pending row suppresses the reminder.
    await handleSendReminder(NOW);
    let logs = await logsFor(dueSoonId, "send_reminder");
    expect(logs.filter((l) => l.status === "simulated")).toHaveLength(0);

    await reapStalePendingMessages(NOW);
    await handleSendReminder(NOW);
    logs = await logsFor(dueSoonId, "send_reminder");
    expect(logs.filter((l) => l.status === "simulated")).toHaveLength(1);
  });
});

describe("concierge tick advisory lock", () => {
  it("skips the tick when another connection holds the lock", async () => {
    const client = await pool.connect();
    try {
      await client.query("select pg_advisory_lock($1)", [CONCIERGE_LOCK_KEY]);
      const result = await runConciergeTick(NOW);
      expect(result).toEqual({ ran: false, campaignBlasts: 0, marketingDispatches: 0, reaped: 0, reminders: 0, nudges: 0, expiredPerks: 0, perkReminders: 0, coopReports: 0, escalatedDisputes: 0, tierTransitions: 0, emergencyFanouts: 0, surgeActivated: 0, surgeEnded: 0, reputationActions: 0, supplyReminders: 0, supplyAutoRequests: 0, boostAuctionsSettled: 0, boostsExpired: 0, sentimentReports: 0, staleWaitlistReverted: 0, depositRetries: 0 });
    } finally {
      await client.query("select pg_advisory_unlock($1)", [CONCIERGE_LOCK_KEY]);
      client.release();
    }
  });

  it("runs the tick (reap + handlers) when the lock is free", async () => {
    const result = await runConciergeTick(NOW);
    expect(result.ran).toBe(true);
    expect(result.reminders).toBeGreaterThanOrEqual(0);
    expect(result.nudges).toBeGreaterThanOrEqual(0);
  });
});
