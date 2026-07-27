import {
  db,
  clientProfilesTable,
  engagementRulesTable,
  messagesTable,
  type ClientProfile,
  type EngagementRule,
} from "@workspace/db";
import { and, desc, eq, gte, isNotNull, lt, lte, sql } from "drizzle-orm";
import {
  dispatchToProfile,
  reminderRuleConfigSchema,
  rebookingRuleConfigSchema,
  renderTemplate,
} from "../lib/concierge";
import { logger } from "../lib/logger";
import { resolveSettings } from "../lib/settings";

// ── Concierge background worker ──────────────────────────────────────────────
// Processes SEND_REMINDER and REBOOKING_NUDGE jobs:
//   SEND_REMINDER   — clients whose next_visit_at falls within the rule's
//                     lead window get an appointment reminder.
//   REBOOKING_NUDGE — clients whose time since last_visit_at exceeds their
//                     average cycle get a rebooking nudge.
// Each tenant's active engagement rules gate the sends, and every dispatch is
// audited in the unified messages table. Uses BullMQ + Redis when REDIS_URL is set, and an
// in-process interval scheduler (same handlers) otherwise.

export const JOB_SEND_REMINDER = "SEND_REMINDER";
export const JOB_REBOOKING_NUDGE = "REBOOKING_NUDGE";

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

async function activeRulesByTenant(ruleType: string): Promise<EngagementRule[]> {
  return db
    .select()
    .from(engagementRulesTable)
    .where(
      and(
        eq(engagementRulesTable.ruleType, ruleType),
        eq(engagementRulesTable.isActive, true),
      ),
    );
}

/** True when this client already has a non-failed message of this kind since `since`. */
async function alreadyLogged(
  clientProfileId: number,
  jobType: string,
  since: Date,
): Promise<boolean> {
  const [row] = await db
    .select({ id: messagesTable.id, status: messagesTable.status })
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.clientProfileId, clientProfileId),
        eq(messagesTable.kind, jobType),
        gte(messagesTable.createdAt, since),
      ),
    )
    .orderBy(desc(messagesTable.createdAt))
    .limit(1);
  return Boolean(row && row.status !== "failed");
}

/**
 * SEND_REMINDER handler: for every tenant with an active "reminder" rule,
 * remind clients whose next_visit_at is within the configured lead window.
 * Returns the number of dispatches attempted.
 */
export async function handleSendReminder(now: Date = new Date()): Promise<number> {
  let dispatched = 0;
  for (const rule of await activeRulesByTenant("reminder")) {
    const cfg = reminderRuleConfigSchema.safeParse(rule.config);
    if (!cfg.success) {
      logger.warn({ ruleId: rule.id }, "Skipping reminder rule with malformed config");
      continue;
    }
    const windowEnd = new Date(now.getTime() + cfg.data.leadHours * MS_PER_HOUR);

    const profiles: ClientProfile[] = await db
      .select()
      .from(clientProfilesTable)
      .where(
        and(
          eq(clientProfilesTable.tenantId, rule.tenantId),
          isNotNull(clientProfilesTable.nextVisitAt),
          gte(clientProfilesTable.nextVisitAt, now),
          lte(clientProfilesTable.nextVisitAt, windowEnd),
        ),
      );

    for (const profile of profiles) {
      // One reminder per client per lead window.
      const since = new Date(now.getTime() - cfg.data.leadHours * MS_PER_HOUR);
      if (await alreadyLogged(profile.id, "send_reminder", since)) continue;

      const when = profile.nextVisitAt!.toLocaleString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
      await dispatchToProfile({
        tenantId: rule.tenantId,
        profile,
        jobType: "send_reminder",
        ruleId: rule.id,
        body: renderTemplate(cfg.data.template, { name: profile.name, when }),
        context: { nextVisitAt: profile.nextVisitAt!.toISOString() },
      });
      dispatched++;
    }
  }
  return dispatched;
}

/**
 * REBOOKING_NUDGE handler: for every tenant with an active "rebooking_nudge"
 * rule, nudge clients whose time since last_visit_at exceeds their average
 * cycle length. Returns the number of dispatches attempted.
 */
export async function handleRebookingNudge(now: Date = new Date()): Promise<number> {
  let dispatched = 0;
  for (const rule of await activeRulesByTenant("rebooking_nudge")) {
    const cfg = rebookingRuleConfigSchema.safeParse(rule.config);
    if (!cfg.success) {
      logger.warn({ ruleId: rule.id }, "Skipping rebooking rule with malformed config");
      continue;
    }

    // Tenant-level fallback cycle: clients whose visit history is too thin to
    // have a computed averageCycleDays are still scanned against the tenant's
    // default cycle so they aren't invisible to the automation.
    const defaultCycleDays = (await resolveSettings(rule.tenantId)).defaultCycleDays;

    const profiles: ClientProfile[] = await db
      .select()
      .from(clientProfilesTable)
      .where(
        and(
          eq(clientProfilesTable.tenantId, rule.tenantId),
          isNotNull(clientProfilesTable.lastVisitAt),
        ),
      );

    for (const profile of profiles) {
      const cycleDays = profile.averageCycleDays ?? defaultCycleDays;
      const daysSince = Math.floor(
        (now.getTime() - profile.lastVisitAt!.getTime()) / MS_PER_DAY,
      );
      if (daysSince <= cycleDays) continue;

      // Respect the nudge cooldown so overdue clients aren't spammed.
      const since = new Date(now.getTime() - cfg.data.cooldownDays * MS_PER_DAY);
      if (await alreadyLogged(profile.id, "rebooking_nudge", since)) continue;

      await dispatchToProfile({
        tenantId: rule.tenantId,
        profile,
        jobType: "rebooking_nudge",
        ruleId: rule.id,
        body: renderTemplate(cfg.data.template, {
          name: profile.name,
          days: String(daysSince),
        }),
        context: {
          lastVisitAt: profile.lastVisitAt!.toISOString(),
          averageCycleDays: profile.averageCycleDays,
          effectiveCycleDays: cycleDays,
          daysSinceLastVisit: daysSince,
        },
      });
      dispatched++;
    }
  }
  return dispatched;
}

// ── Crash/concurrency hardening ──────────────────────────────────────────────

/** Outbound messages stuck in "pending" longer than this are considered dead. */
export const STALE_PENDING_MS = 15 * 60 * 1000;
export const STALE_PENDING_ERROR =
  "Reaped by concierge worker: message stuck in pending (likely a crash or restart mid-send)";

/** Advisory lock key for the concierge tick (arbitrary but stable). */
export const CONCIERGE_LOCK_KEY = 0x67_6e_69_6c; // "gnil"

/**
 * Mark outbound messages stuck in "pending" beyond the threshold as failed.
 * A crash/restart between the pending insert and the finalizing update leaves
 * rows in "pending" forever; since `alreadyLogged` treats non-failed rows as
 * "already sent", such rows would suppress the retry indefinitely. Marking
 * them failed lets the next tick re-dispatch. Returns the number reaped.
 */
export async function reapStalePendingMessages(
  now: Date = new Date(),
  thresholdMs: number = STALE_PENDING_MS,
): Promise<number> {
  const cutoff = new Date(now.getTime() - thresholdMs);
  const reaped = await db
    .update(messagesTable)
    .set({
      status: "failed",
      errorCode: "stale_pending",
      errorMessage: STALE_PENDING_ERROR,
      updatedAt: now,
    })
    .where(
      and(
        eq(messagesTable.direction, "outbound"),
        eq(messagesTable.status, "pending"),
        lt(messagesTable.createdAt, cutoff),
      ),
    )
    .returning({ id: messagesTable.id });
  if (reaped.length > 0) {
    logger.warn(
      { count: reaped.length, ids: reaped.map((r) => r.id) },
      "Reaped stale pending messages",
    );
  }
  return reaped.length;
}

export interface ConciergeTickResult {
  /** False when another instance held the advisory lock and this tick was skipped. */
  ran: boolean;
  reaped: number;
  reminders: number;
  nudges: number;
}

/**
 * Run one concierge tick under a Postgres advisory lock so concurrent server
 * instances never double-scan (and thus never double-dispatch) the same
 * reminders/nudges. Uses a transaction-scoped lock (pg_try_advisory_xact_lock)
 * so the lock is guaranteed released even if the process dies mid-tick, and
 * always sits on the same connection that acquired it.
 */
export async function runConciergeTick(now: Date = new Date()): Promise<ConciergeTickResult> {
  return db.transaction(async (tx) => {
    const res = await tx.execute(
      sql`select pg_try_advisory_xact_lock(${CONCIERGE_LOCK_KEY}) as locked`,
    );
    const locked = Boolean((res.rows?.[0] as { locked?: boolean } | undefined)?.locked);
    if (!locked) {
      logger.info("Concierge tick skipped — another instance holds the lock");
      return { ran: false, reaped: 0, reminders: 0, nudges: 0 };
    }
    const reaped = await reapStalePendingMessages(now);
    const reminders = await handleSendReminder(now);
    const nudges = await handleRebookingNudge(now);
    return { ran: true, reaped, reminders, nudges };
  });
}

const JOB_HANDLERS: Record<string, (now?: Date) => Promise<number>> = {
  [JOB_SEND_REMINDER]: handleSendReminder,
  [JOB_REBOOKING_NUDGE]: handleRebookingNudge,
};

export interface ConciergeWorkerHandle {
  mode: "bullmq" | "interval";
  stop: () => Promise<void>;
}

const QUEUE_NAME = "concierge";
const INTERVAL_MS = 5 * 60 * 1000; // fallback scheduler cadence
const REPEAT_MS = 5 * 60 * 1000; // BullMQ repeatable-job cadence

async function startBullMqWorker(redisUrl: string): Promise<ConciergeWorkerHandle> {
  const { Queue, Worker } = await import("bullmq");
  const connection = { url: redisUrl };

  const queue = new Queue(QUEUE_NAME, { connection });
  await queue.upsertJobScheduler(JOB_SEND_REMINDER, { every: REPEAT_MS }, { name: JOB_SEND_REMINDER });
  await queue.upsertJobScheduler(JOB_REBOOKING_NUDGE, { every: REPEAT_MS }, { name: JOB_REBOOKING_NUDGE });

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const handler = JOB_HANDLERS[job.name];
      if (!handler) {
        logger.warn({ jobName: job.name }, "Unknown concierge job");
        return 0;
      }
      // Crash-mid-send recovery applies on this path too.
      await reapStalePendingMessages();
      const n = await handler();
      logger.info({ jobName: job.name, dispatched: n }, "Concierge job processed");
      return n;
    },
    { connection },
  );
  worker.on("failed", (job, err) => {
    logger.error({ err, jobName: job?.name }, "Concierge job failed");
  });

  logger.info("Concierge worker started (BullMQ + Redis)");
  return {
    mode: "bullmq",
    stop: async () => {
      await worker.close();
      await queue.close();
    },
  };
}

function startIntervalWorker(): ConciergeWorkerHandle {
  let running = false;
  const tick = async () => {
    if (running) return; // don't overlap slow ticks
    running = true;
    try {
      const { ran, reaped, reminders, nudges } = await runConciergeTick();
      if (ran && reaped + reminders + nudges > 0) {
        logger.info(
          { reaped, reminders, nudges },
          "Concierge interval tick dispatched messages",
        );
      }
    } catch (err) {
      logger.error({ err }, "Concierge interval tick failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, INTERVAL_MS);
  timer.unref();
  logger.info("Concierge worker started (in-process interval scheduler)");
  return {
    mode: "interval",
    stop: async () => {
      clearInterval(timer);
    },
  };
}

/**
 * Start the concierge worker. BullMQ + Redis when REDIS_URL is configured;
 * otherwise an in-process interval scheduler running the same handlers.
 */
export async function startConciergeWorker(): Promise<ConciergeWorkerHandle> {
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    try {
      return await startBullMqWorker(redisUrl);
    } catch (err) {
      logger.error(
        { err },
        "BullMQ worker failed to start; falling back to in-process scheduler",
      );
    }
  }
  return startIntervalWorker();
}
