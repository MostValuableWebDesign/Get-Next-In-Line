import {
  db,
  modulesTable,
  partnerConnectionsTable,
  partnerConnectionEventsTable,
  tenantModulesTable,
  tenantsTable,
  type Module,
} from "@workspace/db";
import { and, eq, isNull, ne } from "drizzle-orm";
import { logger } from "./logger";

/**
 * White-label proxy map — every module's hidden upstream connector.
 * Source: agency mapping file (attached_assets/Pasted-Every-single-module-...txt).
 *
 * ADMIN ONLY: this data is served exclusively via /api/admin/connector-registry
 * and must never appear in tenant-facing module endpoints.
 */
interface ConnectorMappingEntry {
  slug: string;
  name: string;
  category: string;
  categorySlug: string;
  description: string;
  wholesalePrice: string;
  /** Optional distinct bi-weekly wholesale rate (not monthly/2). */
  wholesalePriceBiweekly?: string;
  /**
   * Per-module markup override (percent). "0" for partner-direct pass-through
   * modules, "25" for white-label resale engines. Omit to follow the
   * agency-wide markup.
   */
  markupPercentOverride?: string;
  /** Null for internal (GNIL-native) modules with no external upstream. */
  upstreamVendor: string | null;
  /**
   * Customer-facing partner brand — ONLY for partner-category modules
   * (deliberate, narrow exception to the white-label contract). Omit/undefined
   * for every white-labeled module.
   */
  partnerBrand?: string;
  hiddenConnector: string | null;
  proxyNotes: string | null;
}

export const CONNECTOR_MAPPING: ConnectorMappingEntry[] = [
  // ── Former Marketing OS (GNIL Bridge) — folded into White-Label Resale
  // Engines (white-label resold marketing tooling at the same 25% markup) ──
  {
    slug: "ghl_crm_pipelines",
    name: "Lead Pipelines & CRM Core",
    category: "White-Label Resale Engines",
    categorySlug: "media",
    markupPercentOverride: "25",
    description: "Full CRM with visual lead pipelines, contact management, and deal tracking.",
    wholesalePrice: "97.00",
    upstreamVendor: "HighLevel",
    hiddenConnector:
      "HighLevel CRM & Pipeline API v2 (Proxy Tunled via app.getnextinline.io/api/v1/crm)",
    proxyNotes: "Proxy tunneled via app.getnextinline.io/api/v1/crm",
  },
  {
    slug: "ghl_omnichannel_inbox",
    name: "Unified Omnichannel Inbox",
    category: "White-Label Resale Engines",
    categorySlug: "media",
    markupPercentOverride: "25",
    description: "One inbox for SMS, email, chat, and social conversations.",
    wholesalePrice: "97.00",
    upstreamVendor: "HighLevel / Twilio / Mailgun",
    hiddenConnector:
      "HighLevel Conversations & Twilio/Mailgun SMS/Email API Gateway (Obfuscated Omnichannel Router)",
    proxyNotes: "Obfuscated omnichannel router",
  },
  {
    slug: "ghl_funnel_builder",
    name: "High-Converting Funnel & Site Builder",
    category: "White-Label Resale Engines",
    categorySlug: "media",
    markupPercentOverride: "25",
    description: "Drag-and-drop funnel and website builder with custom domains.",
    wholesalePrice: "97.00",
    upstreamVendor: "HighLevel",
    hiddenConnector:
      "HighLevel Funnel Engine & Custom Domain SSL Proxy (Rendered natively via white-label iframe/DOM wrapper)",
    proxyNotes: "Rendered natively via white-label iframe/DOM wrapper",
  },
  {
    slug: "ghl_ai_automation",
    name: "AI Voice & SMS Nurture Bots",
    category: "White-Label Resale Engines",
    categorySlug: "media",
    markupPercentOverride: "25",
    description: "AI-powered conversational bots that follow up leads via voice and SMS automatically.",
    wholesalePrice: "147.00",
    upstreamVendor: "HighLevel / OpenAI",
    hiddenConnector: "HighLevel Conversation AI & OpenAI GPT-4 Server-Side Agent Bridge",
    proxyNotes: "Server-side agent bridge",
  },
  // ── Category 1: Core Service Modules (Operations marketplace) ────────────
  // Internal GNIL-native modules — no hidden upstream connector. They live in
  // the "Core Operations" grid of the Operations hub, never in daily-workflow
  // sidebar tabs. categorySlug MUST stay "operations".
  {
    slug: "complete_payroll_suite",
    name: "Complete Payroll & Tax Suite",
    category: "Public Core Service Modules",
    categorySlug: "operations",
    description:
      "End-to-end multi-state tax filing, automated wage calculations, and direct deposit infrastructure.",
    wholesalePrice: "149.00",
    upstreamVendor: null,
    hiddenConnector: null,
    proxyNotes: null,
  },
  {
    slug: "smart_booking",
    name: "Smart Booking System",
    category: "Public Core Service Modules",
    categorySlug: "operations",
    description:
      "Intelligent customer scheduling engine with automated calendar sync and SMS reminders.",
    wholesalePrice: "79.00",
    upstreamVendor: null,
    hiddenConnector: null,
    proxyNotes: null,
  },
  {
    slug: "no_show_shield",
    name: "No-Show Shield & Deposits",
    category: "Public Core Service Modules",
    categorySlug: "operations",
    description:
      "Secure card-on-file authorization holding automated penalty deposits for missed appointments.",
    wholesalePrice: "49.00",
    upstreamVendor: null,
    hiddenConnector: null,
    proxyNotes: null,
  },
  {
    slug: "commission_ledger",
    name: "Commission & Split Tracker",
    category: "Public Core Service Modules",
    categorySlug: "operations",
    description:
      "Real-time complex staff commission splits, tiered bonuses, and performance ledgering.",
    wholesalePrice: "69.00",
    upstreamVendor: null,
    hiddenConnector: null,
    proxyNotes: null,
  },
  {
    slug: "franchise_coop_controller",
    name: "Multi-Location Franchise Co-Op Controller",
    category: "Public Core Service Modules",
    categorySlug: "operations",
    description:
      "Enterprise franchise governance: organization hierarchy (HQ → region → storefront), global perk template propagation, local-autonomy policy with approval queue, and consolidated roll-up reporting.",
    wholesalePrice: "199.00",
    upstreamVendor: null,
    hiddenConnector: null,
    proxyNotes: null,
  },
  {
    slug: "payroll_hub",
    name: "Service Payroll Hub",
    category: "Public Core Service Modules",
    categorySlug: "operations",
    description:
      "Specialized hourly & tip reporting command center optimized for service-based businesses.",
    wholesalePrice: "99.00",
    upstreamVendor: null,
    hiddenConnector: null,
    proxyNotes: null,
  },
  // ── Category 2: Partner Integrations (0% Markup) ─────────────────────────
  {
    slug: "simply_insured",
    markupPercentOverride: "0",
    partnerBrand: "SimplyInsured",
    name: "Group Health Insurance Hub",
    category: "Partner-Direct Integrations",
    categorySlug: "partners",
    description: "Group health insurance quoting and benefits administration.",
    wholesalePrice: "0.00",
    upstreamVendor: "SimplyInsured",
    hiddenConnector: "SimplyInsured Brokerage API & Benefits Administration Proxy",
    proxyNotes: null,
  },
  {
    // Consolidated offering: real-world Gusto sells payroll AND 401(k)/benefits,
    // so the former standalone Guideline module was folded in here (see
    // RETIRED_MODULES below).
    slug: "gusto",
    markupPercentOverride: "0",
    partnerBrand: "Gusto",
    name: "Payroll, 401(k) & Employee Benefits",
    category: "Partner-Direct Integrations",
    categorySlug: "partners",
    description:
      "Full-service payroll for W-2 employees and 1099 contractors, plus 401(k) administration and payroll-integrated employee benefits.",
    wholesalePrice: "0.00",
    upstreamVendor: "Gusto",
    hiddenConnector:
      "Gusto Embedded Payroll, Tax Filing & 401(k) Benefits Administration API",
    proxyNotes: null,
  },
  {
    slug: "next_insurance",
    markupPercentOverride: "0",
    partnerBrand: "Next Insurance",
    name: "Small Business Insurance & COI",
    category: "Partner-Direct Integrations",
    categorySlug: "partners",
    description:
      "General & professional liability, workers' comp, and instant COI generation.",
    wholesalePrice: "0.00",
    upstreamVendor: "Next Insurance",
    hiddenConnector: "Next Insurance Embedded Quoting & Certificate API",
    proxyNotes: null,
  },
  {
    slug: "quickbooks",
    markupPercentOverride: "0",
    partnerBrand: "QuickBooks",
    name: "General Ledger & Financial Sync",
    category: "Partner-Direct Integrations",
    categorySlug: "partners",
    description: "Two-way accounting sync with the general ledger.",
    wholesalePrice: "0.00",
    upstreamVendor: "QuickBooks",
    hiddenConnector: "QuickBooks Online OAuth2 & Two-Way Accounting Reconciliation Bridge",
    proxyNotes: null,
  },
  // ── Category 3: White-Label Resale Engines ───────────────────────────────
  {
    slug: "qujam",
    markupPercentOverride: "25",
    name: "High-Definition Live Stream Studio",
    category: "White-Label Resale Engines",
    categorySlug: "media",
    description: "Browser-based HD live streaming studio.",
    wholesalePrice: "49.00",
    upstreamVendor: "Qujam",
    hiddenConnector: "Qujam WebRTC Broadcast API & Ultra-Low Latency Video Streaming Node",
    proxyNotes: null,
  },
  {
    slug: "vibe_co",
    markupPercentOverride: "25",
    name: "Connected TV Ad Network",
    category: "White-Label Resale Engines",
    categorySlug: "media",
    description: "Programmatic connected-TV and OTT advertising.",
    // Monthly wholesale; distinct bi-weekly cadence rate (not monthly/2).
    wholesalePrice: "1500.00",
    wholesalePriceBiweekly: "700.00",
    upstreamVendor: "Vibe.co",
    hiddenConnector: "Vibe.co Programmatic CTV Ad Placement & Budget Routing API",
    proxyNotes: null,
  },
  {
    slug: "adroll",
    markupPercentOverride: "25",
    name: "Omnichannel Retargeting & Display",
    category: "White-Label Resale Engines",
    categorySlug: "media",
    description: "Retargeting and display ads across web and social.",
    wholesalePrice: "79.00",
    upstreamVendor: "AdRoll",
    hiddenConnector: "AdRoll Programmatic Display & Social Retargeting API",
    proxyNotes: null,
  },
  {
    slug: "audiogo",
    markupPercentOverride: "25",
    name: "Programmatic Digital Audio Ads",
    category: "White-Label Resale Engines",
    categorySlug: "media",
    description: "Podcast and streaming-music ad campaigns.",
    wholesalePrice: "59.00",
    upstreamVendor: "AudioGo",
    hiddenConnector: "AudioGo Podcast & Streaming Music Ad Insertion Gateway",
    proxyNotes: null,
  },
  {
    slug: "wondercraft_ai",
    markupPercentOverride: "25",
    name: "AI Voice & Audio Script Synthesis",
    category: "White-Label Resale Engines",
    categorySlug: "media",
    description: "AI text-to-speech audio and script generation.",
    wholesalePrice: "39.00",
    upstreamVendor: "Wondercraft AI",
    hiddenConnector: "Wondercraft AI Text-to-Speech Generation Pipeline",
    proxyNotes: null,
  },
  {
    slug: "creatify_ai",
    markupPercentOverride: "25",
    name: "Automated AI Video Ad Generator",
    category: "White-Label Resale Engines",
    categorySlug: "media",
    description: "Generate video ads automatically from a URL.",
    wholesalePrice: "49.00",
    upstreamVendor: "Creatify AI",
    hiddenConnector: "Creatify AI URL-to-Video Rendering Engine",
    proxyNotes: null,
  },
  {
    slug: "metricool",
    markupPercentOverride: "25",
    name: "Unified Social Analytics & Scheduler",
    category: "White-Label Resale Engines",
    categorySlug: "media",
    description: "Multi-channel social analytics, scheduling, and reporting.",
    wholesalePrice: "29.00",
    upstreamVendor: "Metricool",
    hiddenConnector: "Metricool Multi-Channel Social Graph API & Automated Reporting Gateway",
    proxyNotes: null,
  },
];

/**
 * Modules retired from the catalog. Retirement is deliberately soft: the seed
 * deactivates the module row (isActive=false) rather than deleting it, so
 * tenant activations, billing, and provisioning history stay intact. Any
 * partner connection that is not already disconnected gets its stored
 * credentials purged (same semantics as the tenant-facing disconnect route)
 * with an explanatory audit event on the connection history.
 */
interface RetiredModuleEntry {
  slug: string;
  /** Fallback match for legacy rows that predate slugs. */
  name: string;
  /** Audit note recorded on every connection the seed force-disconnects. */
  auditNote: string;
  /**
   * Consolidation target. When set, retirement is a MIGRATE-THEN-REMOVE:
   * every tenant activation of the retired module is re-pointed to the
   * successor module (keeping charged wholesale/resale snapshots, cadence,
   * payment mode, and provisioning date), tenants that already hold the
   * successor keep their existing activation (the redundant retired one is
   * dropped so nobody is double-billed), an explanatory audit event is
   * recorded on each affected workspace's successor connection history, and
   * the retired module row (plus its own connection rows) is then hard-deleted
   * so it can never reappear. Without a successor, retirement stays soft
   * (deactivate + force-disconnect, history intact).
   */
  successorSlug?: string;
  /** Audit note recorded on each migrated workspace's successor connection. */
  migrationAuditNote?: string;
}

export const RETIRED_MODULES: RetiredModuleEntry[] = [
  {
    // Real-world Gusto offers payroll AND 401(k)/benefits, so the standalone
    // Guideline partner module is redundant — consolidated into "gusto".
    slug: "guideline",
    name: "401(k) & Employee Benefits",
    auditNote:
      "Partner offering retired: 401(k) & employee benefits are now part of the Gusto integration. Connection disconnected; stored credentials purged.",
    successorSlug: "gusto",
    migrationAuditNote:
      "Partner offering consolidated: the standalone 401(k) & Employee Benefits module was folded into the Gusto integration. Existing billing (charged prices, cadence, provisioning date) carried over unchanged; the retired module's connection history was removed with it and any stored credentials were purged.",
  },
  {
    slug: "deel",
    name: "Global Team & HR Management",
    auditNote:
      "Partner offering retired: Team Management powered by Deel is no longer available. Connection disconnected; stored credentials purged.",
  },
  {
    slug: "the_hartford",
    name: "Commercial Liability & Workers Comp",
    auditNote:
      "Partner offering retired: Commercial Coverage powered by The Hartford is no longer available. Connection disconnected; stored credentials purged.",
  },
  {
    slug: "vestwell",
    name: "Automated Retirement & 401(k)",
    auditNote:
      "Partner offering retired: Retirement Plans powered by Vestwell is no longer available. Connection disconnected; stored credentials purged.",
  },
];

/**
 * Idempotent seed: upserts the hidden connector mapping into the modules table.
 * - Existing modules (matched by slug, falling back to name) get their catalog
 *   copy (name, description) and connector fields refreshed from the mapping.
 * - Modules present in the mapping but missing from the DB are inserted, so the
 *   registry is always complete.
 * - RETIRED_MODULES are deactivated (never deleted) and their remaining
 *   partner connections force-disconnected with an audit event.
 * Runs on every server start; safe to re-run.
 */
export async function seedConnectorMapping(): Promise<void> {
  const existing = await db.select().from(modulesTable);
  let updated = 0;
  let inserted = 0;

  for (const entry of CONNECTOR_MAPPING) {
    const match =
      existing.find((m) => m.slug === entry.slug) ??
      existing.find((m) => m.name === entry.name);

    if (match) {
      await db
        .update(modulesTable)
        .set({
          slug: entry.slug,
          // The mapping is the source of truth for catalog identity — keep
          // name/description in sync so consolidations (e.g. Gusto absorbing
          // the retired Guideline offering) land on existing rows too.
          name: entry.name,
          description: entry.description,
          category: entry.category,
          // Keep marketplace placement pinned — e.g. Core Service Modules
          // must stay under "operations" (Core Operations grid).
          categorySlug: entry.categorySlug,
          upstreamVendor: entry.upstreamVendor,
          hiddenConnector: entry.hiddenConnector,
          proxyNotes: entry.proxyNotes,
          partnerBrand: entry.partnerBrand ?? null,
          wholesalePriceBiweekly: entry.wholesalePriceBiweekly ?? null,
          markupPercentOverride: entry.markupPercentOverride ?? null,
          // Partner-Direct modules bill strictly at $0 pass-through: the
          // catalog's declared wholesale price is authoritative on EVERY run
          // (like the markup override above), so legacy partner rows carrying
          // pre-contract prices reconcile to $0.00. Non-partner categories
          // keep their DB wholesale price (only written on insert) —
          // historical charged snapshots are never touched either way.
          ...(entry.categorySlug === "partners"
            ? { wholesalePrice: entry.wholesalePrice }
            : {}),
        })
        .where(eq(modulesTable.id, match.id));
      updated++;
    } else {
      await db.insert(modulesTable).values({
        name: entry.name,
        category: entry.category,
        categorySlug: entry.categorySlug,
        description: entry.description,
        wholesalePrice: entry.wholesalePrice,
        wholesalePriceBiweekly: entry.wholesalePriceBiweekly ?? null,
        markupPercentOverride: entry.markupPercentOverride ?? null,
        isActive: true,
        slug: entry.slug,
        upstreamVendor: entry.upstreamVendor,
        hiddenConnector: entry.hiddenConnector,
        proxyNotes: entry.proxyNotes,
        partnerBrand: entry.partnerBrand ?? null,
      });
      inserted++;
    }
  }

  // ── Retired modules ────────────────────────────────────────────────────────
  // Two flavors:
  //  - with a successor: MIGRATE-THEN-REMOVE — activations re-point to the
  //    successor (billing history intact), then the retired row is deleted
  //    and never re-created (it is absent from CONNECTOR_MAPPING).
  //  - without: soft retire — deactivate (never delete) + force-disconnect.
  let deactivated = 0;
  let disconnected = 0;
  let migrated = 0;
  let removed = 0;
  for (const retired of RETIRED_MODULES) {
    const match =
      existing.find((m) => m.slug === retired.slug) ??
      existing.find((m) => m.name === retired.name);
    if (!match) continue;

    if (retired.successorSlug) {
      const stats = await migrateAndRemoveRetiredModule(match, retired);
      if (stats) {
        migrated += stats.migrated;
        removed++;
      }
      continue;
    }

    if (match.isActive) {
      await db
        .update(modulesTable)
        .set({ isActive: false })
        .where(eq(modulesTable.id, match.id));
      deactivated++;
    }

    // Disconnect any connection that isn't already disconnected, purging
    // stored credentials (mirrors the tenant-facing disconnect semantics) and
    // recording an explanatory audit event. Idempotent: already-disconnected
    // rows are skipped, so re-running the seed never duplicates audit events.
    const liveConns = await db
      .select({ id: partnerConnectionsTable.id })
      .from(partnerConnectionsTable)
      .where(
        and(
          eq(partnerConnectionsTable.moduleId, match.id),
          ne(partnerConnectionsTable.status, "not_connected")
        )
      );
    for (const conn of liveConns) {
      await db
        .update(partnerConnectionsTable)
        .set({
          status: "not_connected",
          oauthState: null,
          accessTokenEncrypted: null,
          refreshTokenEncrypted: null,
          webhookSecretEncrypted: null,
          connectedAt: null,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(partnerConnectionsTable.id, conn.id));
      await db.insert(partnerConnectionEventsTable).values({
        connectionId: conn.id,
        eventType: "disconnected",
        details: retired.auditNote,
      });
      disconnected++;
    }
  }

  logger.info(
    { updated, inserted, deactivated, disconnected, migrated, removed },
    "Connector mapping seed complete"
  );
}

/**
 * Migrate a retired module's tenant activations onto its successor, record an
 * explanatory audit event on each affected workspace's successor connection
 * history, and hard-delete the retired module row (its own connection rows
 * and their events cascade away with it).
 *
 * Idempotent by construction: once the retired row is deleted, later seed
 * runs find no match and skip this path entirely — audit events are written
 * exactly once. Runs in a single transaction so a crash mid-migration leaves
 * everything untouched.
 */
async function migrateAndRemoveRetiredModule(
  retiredModule: Module,
  entry: RetiredModuleEntry
): Promise<{ migrated: number } | null> {
  const [successor] = await db
    .select()
    .from(modulesTable)
    .where(eq(modulesTable.slug, entry.successorSlug!));
  if (!successor) {
    // Never delete billing-referenced rows without a live consolidation
    // target — loud skip, next seed run retries.
    logger.error(
      { retiredSlug: entry.slug, successorSlug: entry.successorSlug },
      "Retired-module migration skipped: successor module not found"
    );
    return null;
  }

  return db.transaction(async (tx) => {
    const retiredAssignments = await tx
      .select()
      .from(tenantModulesTable)
      .where(eq(tenantModulesTable.moduleId, retiredModule.id));
    const successorAssignments = await tx
      .select()
      .from(tenantModulesTable)
      .where(eq(tenantModulesTable.moduleId, successor.id));
    const tenantsWithSuccessor = new Set(successorAssignments.map((a) => a.tenantId));

    const migratedTenantIds = new Set<number>();
    for (const assignment of retiredAssignments) {
      if (tenantsWithSuccessor.has(assignment.tenantId)) {
        // Tenant already holds the successor: keep that activation untouched
        // and drop the redundant retired one, pulling the tenant's MRR and
        // module count back in line with the join table — the consolidation
        // must not leave anyone double-billed.
        await tx.delete(tenantModulesTable).where(eq(tenantModulesTable.id, assignment.id));

        const biweekly = assignment.billingCadence === "biweekly";
        const removedResale =
          assignment.chargedResale != null
            ? parseFloat(assignment.chargedResale)
            : parseFloat(
                (biweekly ? retiredModule.wholesalePriceBiweekly : null) ??
                  retiredModule.wholesalePrice
              );
        const monthlyEquivalent = biweekly ? (removedResale * 26) / 12 : removedResale;

        const [tenant] = await tx
          .select()
          .from(tenantsTable)
          .where(eq(tenantsTable.id, assignment.tenantId));
        if (tenant) {
          const remaining = await tx
            .select({ id: tenantModulesTable.id })
            .from(tenantModulesTable)
            .where(eq(tenantModulesTable.tenantId, assignment.tenantId));
          await tx
            .update(tenantsTable)
            .set({
              mrr: String(
                Math.max(
                  0,
                  Math.round((parseFloat(tenant.mrr ?? "0") - monthlyEquivalent) * 100) / 100
                )
              ),
              modulesEnabled: remaining.length,
            })
            .where(eq(tenantsTable.id, tenant.id));
        }
      } else {
        // Re-point to the successor, preserving the original charged
        // wholesale/resale snapshots, cadence, payment mode, and provisioning
        // date — billing history and MRR are unchanged.
        await tx
          .update(tenantModulesTable)
          .set({ moduleId: successor.id })
          .where(eq(tenantModulesTable.id, assignment.id));
      }
      migratedTenantIds.add(assignment.tenantId);
    }

    // Audit trail: every workspace that had an activation OR a connection on
    // the retired module gets a consolidation event on its successor
    // connection history (created not_connected when absent) — replacing the
    // history that is deleted along with the retired module's own connections.
    const retiredConns = await tx
      .select({ tenantId: partnerConnectionsTable.tenantId })
      .from(partnerConnectionsTable)
      .where(eq(partnerConnectionsTable.moduleId, retiredModule.id));
    const scopes = new Set<number | null>([
      ...retiredConns.map((c) => c.tenantId),
      ...migratedTenantIds,
    ]);
    for (const scope of scopes) {
      const [existingConn] = await tx
        .select({ id: partnerConnectionsTable.id })
        .from(partnerConnectionsTable)
        .where(
          and(
            eq(partnerConnectionsTable.moduleId, successor.id),
            scope == null
              ? isNull(partnerConnectionsTable.tenantId)
              : eq(partnerConnectionsTable.tenantId, scope)
          )
        );
      let connectionId = existingConn?.id;
      if (connectionId == null) {
        const [insertedConn] = await tx
          .insert(partnerConnectionsTable)
          .values({ tenantId: scope, moduleId: successor.id, status: "not_connected" })
          .returning({ id: partnerConnectionsTable.id });
        connectionId = insertedConn.id;
      }
      await tx.insert(partnerConnectionEventsTable).values({
        connectionId,
        eventType: "module_migrated",
        details: entry.migrationAuditNote ?? entry.auditNote,
      });
    }

    // Hard delete — the retired module's own partner connections (and their
    // events) cascade away; no tenant activation references it anymore.
    await tx.delete(modulesTable).where(eq(modulesTable.id, retiredModule.id));

    logger.info(
      {
        retiredSlug: entry.slug,
        successorSlug: entry.successorSlug,
        migratedActivations: retiredAssignments.length,
        auditedWorkspaces: scopes.size,
      },
      "Retired module migrated to successor and removed"
    );
    return { migrated: retiredAssignments.length };
  });
}
