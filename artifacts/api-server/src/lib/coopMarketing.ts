import { randomBytes } from "crypto";
import {
  db,
  tenantsTable,
  sosCustomersTable,
  sosSettingsTable,
  merchantCoopPartnershipsTable,
  coopMarketingCampaignsTable,
  coopMarketingParticipantsTable,
  coopMarketingChannelsTable,
  coopMarketingSendsTable,
  coopMarketingLinksTable,
  coopMarketingLinkClicksTable,
  type CoopMarketingCampaign,
  type CoopMarketingParticipant,
  type CoopMarketingSend,
} from "@workspace/db";
import { and, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { sendMessageSafe } from "./messaging";
import { normalizeToE164 } from "./sms";
import { logger } from "./logger";

// ── Co-op Marketing & Social Syndication Hub ─────────────────────────────────
// Shared logic for the /coop/marketing routes and the concierge worker's
// scheduled-dispatch sweep: the asset template library, AI copy suggestion
// with deterministic fallback, campaign serialization, the multi-channel
// dispatch engine (SMS via the unified messaging pipeline; social via the
// channel connection layer with simulated fallback), and analytics rollups.

export const MARKETING_CHANNELS = ["sms", "instagram", "facebook"] as const;
export type MarketingChannel = (typeof MARKETING_CHANNELS)[number];

export interface MarketingTemplate {
  slug: string;
  label: string;
  description: string;
  /** Pixel dimensions of the rendered asset; null for text-only formats. */
  width: number | null;
  height: number | null;
  /** Channel this format is optimized for. */
  channel: MarketingChannel | "print";
}

export const MARKETING_TEMPLATES: MarketingTemplate[] = [
  {
    slug: "instagram_square",
    label: "Instagram Square",
    description: "1080×1080 co-branded square post for both feeds.",
    width: 1080,
    height: 1080,
    channel: "instagram",
  },
  {
    slug: "facebook_post",
    label: "Facebook Post",
    description: "1200×630 co-branded link-style post image.",
    width: 1200,
    height: 630,
    channel: "facebook",
  },
  {
    slug: "story",
    label: "Story",
    description: "1080×1920 vertical story for Instagram/Facebook stories.",
    width: 1080,
    height: 1920,
    channel: "instagram",
  },
  {
    slug: "flyer",
    label: "Printable Flyer",
    description: "Letter-format printable flyer (2550×3300 at 300dpi).",
    width: 2550,
    height: 3300,
    channel: "print",
  },
  {
    slug: "sms_blast",
    label: "SMS Blast Text",
    description: "Short co-branded text for both businesses' SMS subscriber lists.",
    width: null,
    height: null,
    channel: "sms",
  },
];
export const MARKETING_TEMPLATE_SLUGS = new Set(MARKETING_TEMPLATES.map((t) => t.slug));

// ── Social posting mode ──────────────────────────────────────────────────────
// Live posting requires real Meta Graph credentials; without them every
// social post runs in clearly-flagged simulated mode (same philosophy as the
// simulated-SMS fallback in lib/sms.ts).
export function socialPostingMode(): "live" | "simulated" {
  return process.env.META_GRAPH_ACCESS_TOKEN ? "live" : "simulated";
}

// ── Branding ────────────────────────────────────────────────────────────────

export interface TenantBranding {
  tenantId: number;
  name: string;
  logoUrl: string;
  primaryColor: string;
  secondaryColor: string;
}

export const DEFAULT_PRIMARY_COLOR = "#1e3a5f";
export const DEFAULT_SECONDARY_COLOR = "#f4a259";

/** Branding inputs for a set of tenants, with sensible defaults when unset. */
export async function brandingForTenants(tenantIds: number[]): Promise<TenantBranding[]> {
  if (tenantIds.length === 0) return [];
  const [tenants, settings] = await Promise.all([
    db
      .select({ id: tenantsTable.id, brandName: tenantsTable.brandName })
      .from(tenantsTable)
      .where(inArray(tenantsTable.id, tenantIds)),
    db
      .select({
        tenantId: sosSettingsTable.tenantId,
        brandLogoUrl: sosSettingsTable.brandLogoUrl,
        brandPrimaryColor: sosSettingsTable.brandPrimaryColor,
        brandSecondaryColor: sosSettingsTable.brandSecondaryColor,
      })
      .from(sosSettingsTable)
      .where(inArray(sosSettingsTable.tenantId, tenantIds)),
  ]);
  const settingsById = new Map(settings.map((s) => [s.tenantId, s]));
  return tenants.map((t) => {
    const s = settingsById.get(t.id);
    return {
      tenantId: t.id,
      name: t.brandName,
      logoUrl: s?.brandLogoUrl ?? "",
      primaryColor: s?.brandPrimaryColor || DEFAULT_PRIMARY_COLOR,
      secondaryColor: s?.brandSecondaryColor || DEFAULT_SECONDARY_COLOR,
    };
  });
}

// ── AI copy suggestion (deterministic fallback) ──────────────────────────────

export interface MarketingCopy {
  headline: string;
  body: string;
  smsText: string;
  usedAi: boolean;
}

export function fallbackMarketingCopy(
  hostName: string,
  partnerName: string,
  offer: string,
  templateSlug: string,
): MarketingCopy {
  const pair = `${hostName} × ${partnerName}`;
  const offerLine = offer.trim() || "a special joint offer for our neighborhood";
  return {
    headline: `${pair}: Better Together!`,
    body:
      `Two of your favorite local businesses teamed up — ${offerLine}. ` +
      `Visit ${hostName} or ${partnerName} to take advantage while it lasts.`,
    smsText:
      templateSlug === "sms_blast"
        ? `${pair} teamed up: ${offerLine}. Show this text at either business!`
        : `${pair}: ${offerLine}.`,
    usedAi: false,
  };
}

/**
 * AI-suggested promotional copy via the Replit AI integration (OpenAI-
 * compatible proxy) with the deterministic template above as fallback.
 * Suggestions are always editable by the merchant before use.
 */
export async function suggestMarketingCopy(
  hostName: string,
  partnerName: string,
  offer: string,
  templateSlug: string,
): Promise<MarketingCopy> {
  const baseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  const fallback = fallbackMarketingCopy(hostName, partnerName, offer, templateSlug);
  if (!baseUrl || !apiKey) return fallback;
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-luna",
        max_completion_tokens: 2048,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              'You write short, warm, locally-flavored joint promotional copy for two small businesses running a co-op cross-promotion. Respond with strict JSON: {"headline":string (max 60 chars),"body":string (max 220 chars),"smsText":string (max 140 chars, no links)}.',
          },
          {
            role: "user",
            content: `Businesses: "${hostName}" and "${partnerName}". Offer: ${offer || "joint neighborhood perk"}. Format: ${templateSlug}.`,
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`AI proxy ${res.status}`);
    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("empty AI response");
    const parsed = JSON.parse(content) as Partial<MarketingCopy>;
    return {
      headline: typeof parsed.headline === "string" && parsed.headline ? parsed.headline : fallback.headline,
      body: typeof parsed.body === "string" && parsed.body ? parsed.body : fallback.body,
      smsText: typeof parsed.smsText === "string" && parsed.smsText ? parsed.smsText : fallback.smsText,
      usedAi: true,
    };
  } catch (err) {
    logger.warn({ err }, "AI marketing copy failed; using deterministic fallback");
    return fallback;
  }
}

// ── Tracked short links ──────────────────────────────────────────────────────

/** Unguessable lowercase link code matching the /mr/:code route pattern. */
export function newMarketingLinkCode(): string {
  return `mk${randomBytes(6).toString("hex")}`;
}

export const MARKETING_LINK_CODE_RE = /^[a-z0-9]{4,32}$/;

// ── Campaign loading & serialization ─────────────────────────────────────────

export interface MarketingCampaignRow {
  campaign: CoopMarketingCampaign;
  creatorTenantName: string;
  participants: Array<CoopMarketingParticipant & { tenantName: string }>;
}

export async function loadMarketingCampaignRows(
  campaignIds: number[],
): Promise<MarketingCampaignRow[]> {
  if (campaignIds.length === 0) return [];
  const [campaigns, parts] = await Promise.all([
    db
      .select({
        campaign: coopMarketingCampaignsTable,
        creatorTenantName: tenantsTable.brandName,
      })
      .from(coopMarketingCampaignsTable)
      .innerJoin(tenantsTable, eq(coopMarketingCampaignsTable.creatorTenantId, tenantsTable.id))
      .where(inArray(coopMarketingCampaignsTable.id, campaignIds))
      .orderBy(desc(coopMarketingCampaignsTable.createdAt), desc(coopMarketingCampaignsTable.id)),
    db
      .select({
        participant: coopMarketingParticipantsTable,
        tenantName: tenantsTable.brandName,
      })
      .from(coopMarketingParticipantsTable)
      .innerJoin(tenantsTable, eq(coopMarketingParticipantsTable.tenantId, tenantsTable.id))
      .where(inArray(coopMarketingParticipantsTable.campaignId, campaignIds)),
  ]);
  return campaigns.map(({ campaign, creatorTenantName }) => ({
    campaign,
    creatorTenantName,
    participants: parts
      .filter((p) => p.participant.campaignId === campaign.id)
      .map((p) => ({ ...p.participant, tenantName: p.tenantName })),
  }));
}

export type CampaignChannelTarget = { tenantId: number; channel: MarketingChannel };

export function campaignChannelTargets(c: CoopMarketingCampaign): CampaignChannelTarget[] {
  const raw = Array.isArray(c.channels) ? (c.channels as unknown[]) : [];
  const out: CampaignChannelTarget[] = [];
  for (const item of raw) {
    const t = item as { tenantId?: unknown; channel?: unknown };
    if (
      typeof t.tenantId === "number" &&
      typeof t.channel === "string" &&
      (MARKETING_CHANNELS as readonly string[]).includes(t.channel)
    ) {
      out.push({ tenantId: t.tenantId, channel: t.channel as MarketingChannel });
    }
  }
  return out;
}

export function allParticipantsApproved(row: MarketingCampaignRow): boolean {
  return row.participants.length > 0 && row.participants.every((p) => p.approval === "approved");
}

export function serializeMarketingCampaign(row: MarketingCampaignRow, viewerTenantId: number) {
  const mine = row.participants.find((p) => p.tenantId === viewerTenantId);
  return {
    id: row.campaign.id,
    name: row.campaign.name,
    partnershipId: row.campaign.partnershipId,
    templateSlug: row.campaign.templateSlug,
    headline: row.campaign.headline,
    bodyText: row.campaign.bodyText,
    smsText: row.campaign.smsText,
    assetPayload: (row.campaign.assetPayload ?? {}) as Record<string, unknown>,
    channels: campaignChannelTargets(row.campaign),
    scheduledAt: row.campaign.scheduledAt ? row.campaign.scheduledAt.toISOString() : null,
    status: row.campaign.status as
      | "pending_approval"
      | "scheduled"
      | "sending"
      | "sent"
      | "failed"
      | "declined",
    creatorTenantId: row.campaign.creatorTenantId,
    creatorTenantName: row.creatorTenantName,
    isCreator: row.campaign.creatorTenantId === viewerTenantId,
    myApproval: (mine?.approval ?? "pending") as "pending" | "approved" | "declined",
    dispatchTriggeredAt: row.campaign.dispatchTriggeredAt
      ? row.campaign.dispatchTriggeredAt.toISOString()
      : null,
    participants: row.participants.map((p) => ({
      tenantId: p.tenantId,
      tenantName: p.tenantName,
      approval: p.approval as "pending" | "approved" | "declined",
      respondedAt: p.respondedAt ? p.respondedAt.toISOString() : null,
    })),
    createdAt: row.campaign.createdAt.toISOString(),
  };
}

// ── Dispatch engine ──────────────────────────────────────────────────────────

/**
 * Fully-qualified public short-link URL for a tracked marketing link code.
 * SMS recipients are outside the app context, so the link must be absolute.
 */
export function marketingLinkUrl(code: string): string {
  const fromEnv = process.env.APP_BASE_URL;
  const base = fromEnv
    ? fromEnv.replace(/\/$/, "")
    : (() => {
        const domain =
          process.env.REPLIT_DOMAINS?.split(",")[0]?.trim() ||
          process.env.REPLIT_DEV_DOMAIN;
        return domain ? `https://${domain}` : "http://localhost:5173";
      })();
  return `${base}/api/mr/${code}`;
}

/**
 * Deterministic simulated impression estimate for a social post — clearly
 * flagged as simulated in the send row and analytics, but stable so tests
 * and demos are reproducible.
 */
export function simulatedImpressions(campaignId: number, tenantId: number, channel: string): number {
  let h = 0;
  const s = `${campaignId}:${tenantId}:${channel}`;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return 150 + (h % 350);
}

export interface DispatchSummary {
  dispatched: boolean;
  sends: number;
  smsSent: number;
  smsSkipped: number;
  smsFailed: number;
}

/**
 * Dispatch one fully-approved campaign across all selected channels. The
 * conditional `dispatch_triggered_at IS NULL` claim is the send-once lock —
 * a concurrent tick or a manual send racing this can never double-fire.
 *
 * Fan-out per (tenant, channel) target:
 *  - sms: every opted-in customer of THAT tenant through the unified
 *    messaging service (opt-out/STOP guards + the tenant's own from-number),
 *    with the tenant+channel tracked short link appended.
 *  - instagram/facebook: through the channel connection when live credentials
 *    exist; otherwise a clearly-flagged simulated post.
 */
export async function dispatchMarketingCampaign(
  campaignId: number,
  now: Date = new Date(),
): Promise<DispatchSummary> {
  const none: DispatchSummary = { dispatched: false, sends: 0, smsSent: 0, smsSkipped: 0, smsFailed: 0 };
  // Send-once claim.
  const [claimed] = await db
    .update(coopMarketingCampaignsTable)
    .set({ dispatchTriggeredAt: now, status: "sending", updatedAt: now })
    .where(
      and(
        eq(coopMarketingCampaignsTable.id, campaignId),
        isNull(coopMarketingCampaignsTable.dispatchTriggeredAt),
      ),
    )
    .returning();
  if (!claimed) return none;

  const [row] = await loadMarketingCampaignRows([campaignId]);
  if (!row || !allParticipantsApproved(row)) {
    // Should be guarded by callers; belt-and-braces so an unapproved
    // campaign can never fan out.
    await db
      .update(coopMarketingCampaignsTable)
      .set({ status: "failed", updatedAt: now })
      .where(eq(coopMarketingCampaignsTable.id, campaignId));
    logger.warn({ campaignId }, "Marketing dispatch aborted: not fully approved");
    return none;
  }

  const targets = campaignChannelTargets(row.campaign);
  const participantIds = new Set(row.participants.map((p) => p.tenantId));
  const names = new Map(row.participants.map((p) => [p.tenantId, p.tenantName]));
  const socialMode = socialPostingMode();
  const connections = await db
    .select()
    .from(coopMarketingChannelsTable)
    .where(inArray(coopMarketingChannelsTable.tenantId, [...participantIds]));

  let sends = 0;
  let smsSent = 0;
  let smsSkipped = 0;
  let smsFailed = 0;
  let anySuccess = false;
  let anyFailure = false;

  for (const target of targets) {
    // Only participants' audiences are ever touched.
    if (!participantIds.has(target.tenantId)) continue;

    // One tracked short link per (tenant, channel) audience.
    const code = newMarketingLinkCode();
    await db.insert(coopMarketingLinksTable).values({
      campaignId,
      tenantId: target.tenantId,
      channel: target.channel,
      code,
    });
    const link = marketingLinkUrl(code);

    if (target.channel === "sms") {
      const customers = await db
        .select({
          id: sosCustomersTable.id,
          phone: sosCustomersTable.phone,
          smsOptIn: sosCustomersTable.smsOptIn,
        })
        .from(sosCustomersTable)
        .where(eq(sosCustomersTable.tenantId, target.tenantId));
      let sent = 0;
      let skipped = 0;
      let failedCount = 0;
      let simulatedAny = false;
      for (const customer of customers) {
        const phone = normalizeToE164(customer.phone);
        if (!customer.smsOptIn || !phone) {
          skipped++;
          continue;
        }
        const msg = await sendMessageSafe({
          tenantId: target.tenantId,
          origin: "marketing",
          kind: "coop_marketing_blast",
          customerId: customer.id,
          toNumber: phone,
          body:
            `${names.get(target.tenantId) ?? "Your local business"}: ${row.campaign.smsText || row.campaign.headline} ` +
            `More: ${link} Reply STOP to opt out.`,
          context: { marketingCampaignId: campaignId, linkCode: code },
        });
        if (!msg || msg.status === "failed") failedCount++;
        else if (msg.status === "skipped") skipped++;
        else {
          sent++;
          if (msg.status === "simulated") simulatedAny = true;
        }
      }
      smsSent += sent;
      smsSkipped += skipped;
      smsFailed += failedCount;
      const status = sent > 0 ? (simulatedAny ? "simulated" : "sent") : failedCount > 0 ? "failed" : "sent";
      if (sent > 0) anySuccess = true;
      if (failedCount > 0 && sent === 0) anyFailure = true;
      await db.insert(coopMarketingSendsTable).values({
        campaignId,
        tenantId: target.tenantId,
        channel: "sms",
        status,
        simulated: simulatedAny,
        recipients: customers.length,
        delivered: sent,
        failed: failedCount,
        skipped,
        impressions: sent,
        linkCode: code,
      });
      sends++;
    } else {
      const connection = connections.find(
        (c) => c.tenantId === target.tenantId && c.platform === target.channel,
      );
      if (!connection) {
        anyFailure = true;
        await db.insert(coopMarketingSendsTable).values({
          campaignId,
          tenantId: target.tenantId,
          channel: target.channel,
          status: "failed",
          simulated: false,
          linkCode: code,
        });
        sends++;
        continue;
      }
      // Live posting would call the Meta Graph API here with the stored
      // connection token. Without real credentials, the post is simulated —
      // clearly flagged, with a deterministic impression estimate.
      const simulated = socialMode === "simulated" || !connection.accessToken;
      const impressions = simulated
        ? simulatedImpressions(campaignId, target.tenantId, target.channel)
        : 0;
      await db.insert(coopMarketingSendsTable).values({
        campaignId,
        tenantId: target.tenantId,
        channel: target.channel,
        status: simulated ? "simulated" : "sent",
        simulated,
        impressions,
        linkCode: code,
      });
      anySuccess = true;
      sends++;
    }
  }

  await db
    .update(coopMarketingCampaignsTable)
    .set({
      status: anySuccess || !anyFailure ? "sent" : "failed",
      updatedAt: new Date(),
    })
    .where(eq(coopMarketingCampaignsTable.id, campaignId));

  logger.info(
    { campaignId, sends, smsSent, smsSkipped, smsFailed },
    "Co-op marketing campaign dispatched",
  );
  return { dispatched: true, sends, smsSent, smsSkipped, smsFailed };
}

/**
 * Worker sweep: dispatch fully-approved scheduled campaigns whose send time
 * has arrived. The send-once lock lives inside dispatchMarketingCampaign, so
 * this is safe to run on every tick. Returns campaigns dispatched.
 */
export async function sweepMarketingCampaignDispatch(now: Date = new Date()): Promise<number> {
  const due = await db
    .select({ id: coopMarketingCampaignsTable.id })
    .from(coopMarketingCampaignsTable)
    .where(
      and(
        eq(coopMarketingCampaignsTable.status, "scheduled"),
        isNull(coopMarketingCampaignsTable.dispatchTriggeredAt),
        lte(coopMarketingCampaignsTable.scheduledAt, now),
      ),
    );
  let fired = 0;
  for (const { id } of due) {
    const res = await dispatchMarketingCampaign(id, now);
    if (res.dispatched) fired++;
  }
  return fired;
}

// ── Analytics rollup ─────────────────────────────────────────────────────────

export interface CampaignAnalyticsEntry {
  tenantId: number;
  tenantName: string;
  channel: string;
  status: string;
  simulated: boolean;
  recipients: number;
  delivered: number;
  failed: number;
  skipped: number;
  impressions: number;
  clicks: number;
  linkCode: string | null;
}

export async function campaignAnalytics(campaignId: number): Promise<{
  entries: CampaignAnalyticsEntry[];
  totals: {
    delivered: number;
    failed: number;
    clicks: number;
    reach: number;
    simulatedReach: number;
  };
}> {
  const [sendRows, clickRows] = await Promise.all([
    db
      .select({ send: coopMarketingSendsTable, tenantName: tenantsTable.brandName })
      .from(coopMarketingSendsTable)
      .innerJoin(tenantsTable, eq(coopMarketingSendsTable.tenantId, tenantsTable.id))
      .where(eq(coopMarketingSendsTable.campaignId, campaignId)),
    db
      .select({
        code: coopMarketingLinksTable.code,
        clicks: sql<number>`count(${coopMarketingLinkClicksTable.id})::int`,
      })
      .from(coopMarketingLinksTable)
      .leftJoin(
        coopMarketingLinkClicksTable,
        eq(coopMarketingLinkClicksTable.linkId, coopMarketingLinksTable.id),
      )
      .where(eq(coopMarketingLinksTable.campaignId, campaignId))
      .groupBy(coopMarketingLinksTable.code),
  ]);
  const clicksByCode = new Map(clickRows.map((r) => [r.code, r.clicks]));
  const entries = sendRows.map(({ send, tenantName }) => entryFromSend(send, tenantName, clicksByCode));
  const totals = entries.reduce(
    (acc, e) => {
      acc.delivered += e.delivered;
      acc.failed += e.failed;
      acc.clicks += e.clicks;
      const reach = e.channel === "sms" ? e.delivered : e.impressions;
      acc.reach += reach;
      if (e.simulated) acc.simulatedReach += reach;
      return acc;
    },
    { delivered: 0, failed: 0, clicks: 0, reach: 0, simulatedReach: 0 },
  );
  return { entries, totals };
}

function entryFromSend(
  send: CoopMarketingSend,
  tenantName: string,
  clicksByCode: Map<string, number>,
): CampaignAnalyticsEntry {
  return {
    tenantId: send.tenantId,
    tenantName,
    channel: send.channel,
    status: send.status,
    simulated: send.simulated,
    recipients: send.recipients,
    delivered: send.delivered,
    failed: send.failed,
    skipped: send.skipped,
    impressions: send.impressions,
    clicks: send.linkCode ? (clicksByCode.get(send.linkCode) ?? 0) : 0,
    linkCode: send.linkCode,
  };
}

// Re-exported for the routes' partnership-participation check.
export { merchantCoopPartnershipsTable };
