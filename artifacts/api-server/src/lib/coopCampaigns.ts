import {
  db,
  tenantsTable,
  sosCustomersTable,
  coopCampaignsTable,
  coopCampaignParticipantsTable,
  coopCampaignBlastsTable,
  type CoopCampaign,
  type CoopCampaignParticipant,
} from "@workspace/db";
import { and, desc, eq, gt, gte, inArray, isNull, lte } from "drizzle-orm";
import { sendMessageSafe } from "./messaging";
import { normalizeToE164 } from "./sms";
import { logger } from "./logger";

// ── Co-op promotional campaigns & seasonal blasts ────────────────────────────
// Shared logic for the /coop/campaigns routes and the concierge worker's
// auto-blast sweep: preset templates, campaign serialization, and the joint
// SMS blast with rolling 7-day network-wide frequency capping.

/** Rolling frequency-cap window: one co-op campaign blast per phone per 7 days. */
export const BLAST_CAP_MS = 7 * 24 * 60 * 60 * 1000;

export interface CampaignTemplate {
  slug: string;
  label: string;
  description: string;
  defaultDurationDays: number;
  suggestedPerkBoost: string;
}

export const CAMPAIGN_TEMPLATES: CampaignTemplate[] = [
  {
    slug: "back_to_school",
    label: "Back-to-School",
    description: "A neighborhood-wide back-to-school week: every partner boosts a family-friendly perk.",
    defaultDurationDays: 7,
    suggestedPerkBoost: "Back-to-School special — show this text for a bonus perk at every participating business!",
  },
  {
    slug: "holiday_weekend",
    label: "Holiday Weekend",
    description: "A synchronized long-weekend flash deal across the whole partner network.",
    defaultDurationDays: 3,
    suggestedPerkBoost: "Holiday Weekend flash deal — extra perks all weekend at your favorite local businesses!",
  },
  {
    slug: "community_event",
    label: "Local Community Event",
    description: "Ride a local festival, market, or game day with a coordinated same-day boost.",
    defaultDurationDays: 1,
    suggestedPerkBoost: "Community event special — stop by today for a boosted perk at each participating business!",
  },
  {
    slug: "custom",
    label: "Custom",
    description: "Set your own name, window, and boosted offer.",
    defaultDurationDays: 7,
    suggestedPerkBoost: "",
  },
];

export const CAMPAIGN_TEMPLATE_SLUGS = new Set(CAMPAIGN_TEMPLATES.map((t) => t.slug));

export type CampaignPhase = "upcoming" | "live" | "ended";

export function campaignPhase(c: Pick<CoopCampaign, "startsAt" | "endsAt">, now: Date): CampaignPhase {
  if (now < c.startsAt) return "upcoming";
  if (now >= c.endsAt) return "ended";
  return "live";
}

export interface CampaignRow {
  campaign: CoopCampaign;
  participants: Array<CoopCampaignParticipant & { tenantName: string }>;
}

/** Load campaigns (with joined participant names) for a set of campaign ids. */
export async function loadCampaignRows(campaignIds: number[]): Promise<CampaignRow[]> {
  if (campaignIds.length === 0) return [];
  const [campaigns, parts] = await Promise.all([
    db
      .select()
      .from(coopCampaignsTable)
      .where(inArray(coopCampaignsTable.id, campaignIds))
      .orderBy(desc(coopCampaignsTable.createdAt), desc(coopCampaignsTable.id)),
    db
      .select({
        participant: coopCampaignParticipantsTable,
        tenantName: tenantsTable.brandName,
      })
      .from(coopCampaignParticipantsTable)
      .innerJoin(tenantsTable, eq(coopCampaignParticipantsTable.tenantId, tenantsTable.id))
      .where(inArray(coopCampaignParticipantsTable.campaignId, campaignIds)),
  ]);
  return campaigns.map((campaign) => ({
    campaign,
    participants: parts
      .filter((p) => p.participant.campaignId === campaign.id)
      .map((p) => ({ ...p.participant, tenantName: p.tenantName })),
  }));
}

export function serializeCampaign(
  row: CampaignRow,
  viewerTenantId: number,
  creatorTenantName: string,
  now: Date = new Date(),
) {
  const mine = row.participants.find((p) => p.tenantId === viewerTenantId);
  return {
    id: row.campaign.id,
    name: row.campaign.name,
    template: row.campaign.template,
    perkBoostText: row.campaign.perkBoostText,
    startsAt: row.campaign.startsAt.toISOString(),
    endsAt: row.campaign.endsAt.toISOString(),
    creatorTenantId: row.campaign.creatorTenantId,
    creatorTenantName,
    phase: campaignPhase(row.campaign, now),
    blastTriggeredAt: row.campaign.blastTriggeredAt
      ? row.campaign.blastTriggeredAt.toISOString()
      : null,
    myStatus: (mine?.status ?? "invited") as "invited" | "joined" | "declined",
    isCreator: row.campaign.creatorTenantId === viewerTenantId,
    participants: row.participants.map((p) => ({
      tenantId: p.tenantId,
      tenantName: p.tenantName,
      status: p.status as "invited" | "joined" | "declined",
      respondedAt: p.respondedAt ? p.respondedAt.toISOString() : null,
    })),
    createdAt: row.campaign.createdAt.toISOString(),
  };
}

/**
 * Live flash perks for a tenant's storefront perk surface: campaigns the
 * tenant JOINED whose uniform window is currently open. Partner names list
 * the other joined participants.
 */
export async function flashPerksForTenant(tenantId: number, now: Date = new Date()) {
  const myLive = await db
    .select({ campaignId: coopCampaignParticipantsTable.campaignId })
    .from(coopCampaignParticipantsTable)
    .innerJoin(
      coopCampaignsTable,
      eq(coopCampaignParticipantsTable.campaignId, coopCampaignsTable.id),
    )
    .where(
      and(
        eq(coopCampaignParticipantsTable.tenantId, tenantId),
        eq(coopCampaignParticipantsTable.status, "joined"),
        lte(coopCampaignsTable.startsAt, now),
        gt(coopCampaignsTable.endsAt, now),
      ),
    );
  const rows = await loadCampaignRows(myLive.map((r) => r.campaignId));
  return rows.map((row) => ({
    campaignId: row.campaign.id,
    campaignName: row.campaign.name,
    template: row.campaign.template,
    perkBoostText: row.campaign.perkBoostText,
    partnerNames: row.participants
      .filter((p) => p.status === "joined" && p.tenantId !== tenantId)
      .map((p) => p.tenantName),
    startsAt: row.campaign.startsAt.toISOString(),
    endsAt: row.campaign.endsAt.toISOString(),
  }));
}

export interface BlastSummary {
  sent: number;
  capped: number;
  skipped: number;
  totalCandidates: number;
}

/**
 * Run the joint blast for a campaign whose blast_triggered_at claim the
 * caller has ALREADY stamped (send-once lock lives with the caller). Iterates
 * every joined participant's opted-in customers, skips phones that received
 * any co-op campaign blast across the network within the rolling 7-day
 * window, sends through the unified messaging pipeline with a marketing
 * origin, and logs each send into the frequency-cap ledger.
 */
export async function runCampaignBlast(
  campaignId: number,
  now: Date = new Date(),
): Promise<BlastSummary> {
  const [row] = await loadCampaignRows([campaignId]);
  if (!row) return { sent: 0, capped: 0, skipped: 0, totalCandidates: 0 };
  const joined = row.participants.filter((p) => p.status === "joined");
  const joinedNames = joined.map((p) => p.tenantName);
  const capCutoff = new Date(now.getTime() - BLAST_CAP_MS);

  const endDate = row.campaign.endsAt.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  let sent = 0;
  let capped = 0;
  let skipped = 0;
  let total = 0;
  // Dedupe within this run too: shared customers of two partners get one text.
  const seenThisRun = new Set<string>();

  for (const participant of joined) {
    const customers = await db
      .select({
        id: sosCustomersTable.id,
        name: sosCustomersTable.name,
        phone: sosCustomersTable.phone,
        smsOptIn: sosCustomersTable.smsOptIn,
      })
      .from(sosCustomersTable)
      .where(eq(sosCustomersTable.tenantId, participant.tenantId));

    for (const customer of customers) {
      total++;
      const phone = normalizeToE164(customer.phone);
      if (!customer.smsOptIn || !phone) {
        skipped++;
        continue;
      }
      if (seenThisRun.has(phone)) {
        capped++;
        continue;
      }
      // Network-wide rolling 7-day cap: ANY prior co-op campaign blast to
      // this phone inside the window blocks this send.
      const [recent] = await db
        .select({ id: coopCampaignBlastsTable.id })
        .from(coopCampaignBlastsTable)
        .where(
          and(
            eq(coopCampaignBlastsTable.phone, phone),
            gte(coopCampaignBlastsTable.sentAt, capCutoff),
          ),
        )
        .limit(1);
      if (recent) {
        capped++;
        continue;
      }
      seenThisRun.add(phone);
      // Log BEFORE dispatch so a crash mid-blast can't spam on retry — the
      // cap ledger is deliberately conservative.
      await db.insert(coopCampaignBlastsTable).values({
        campaignId: row.campaign.id,
        tenantId: participant.tenantId,
        customerId: customer.id,
        phone,
        sentAt: now,
      });
      await sendMessageSafe({
        tenantId: participant.tenantId,
        origin: "marketing",
        kind: "coop_campaign_blast",
        customerId: customer.id,
        toNumber: phone,
        body:
          `${participant.tenantName}: Neighborhood-wide deal! "${row.campaign.name}" — ` +
          `${row.campaign.perkBoostText} Participating: ${joinedNames.join(", ")}. ` +
          `Now through ${endDate}. Reply STOP to opt out.`,
        context: { campaignId: row.campaign.id },
      });
      sent++;
    }
  }
  logger.info(
    { campaignId, sent, capped, skipped, total },
    "Co-op campaign blast completed",
  );
  return { sent, capped, skipped, totalCandidates: total };
}

/**
 * Worker sweep: auto-fire the joint blast for live campaigns whose blast has
 * not been triggered yet. The conditional `blast_triggered_at IS NULL` claim
 * is the send-once lock — a concurrent tick or a manual trigger racing this
 * sweep can never double-blast. Returns the number of campaigns blasted.
 */
export async function sweepCampaignAutoBlasts(now: Date = new Date()): Promise<number> {
  const due = await db
    .select({ id: coopCampaignsTable.id })
    .from(coopCampaignsTable)
    .where(
      and(
        isNull(coopCampaignsTable.blastTriggeredAt),
        lte(coopCampaignsTable.startsAt, now),
        gt(coopCampaignsTable.endsAt, now),
      ),
    );
  let fired = 0;
  for (const { id } of due) {
    const [claimed] = await db
      .update(coopCampaignsTable)
      .set({ blastTriggeredAt: now, updatedAt: now })
      .where(and(eq(coopCampaignsTable.id, id), isNull(coopCampaignsTable.blastTriggeredAt)))
      .returning({ id: coopCampaignsTable.id });
    if (!claimed) continue;
    await runCampaignBlast(id, now);
    fired++;
  }
  return fired;
}
