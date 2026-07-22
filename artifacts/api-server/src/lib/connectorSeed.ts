import { db, modulesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
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
  /** Null for internal (GNIL-native) modules with no external upstream. */
  upstreamVendor: string | null;
  hiddenConnector: string | null;
  proxyNotes: string | null;
}

export const CONNECTOR_MAPPING: ConnectorMappingEntry[] = [
  // ── Category 0.5: Marketing OS (GNIL Bridge) ──────────────────────────────
  {
    slug: "ghl_crm_pipelines",
    name: "Lead Pipelines & CRM Core",
    category: "Marketing OS / GNIL Bridge",
    categorySlug: "marketing",
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
    category: "Marketing OS / GNIL Bridge",
    categorySlug: "marketing",
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
    category: "Marketing OS / GNIL Bridge",
    categorySlug: "marketing",
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
    category: "Marketing OS / GNIL Bridge",
    categorySlug: "marketing",
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
    category: "Core Service Modules",
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
    category: "Core Service Modules",
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
    category: "Core Service Modules",
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
    category: "Core Service Modules",
    categorySlug: "operations",
    description:
      "Real-time complex staff commission splits, tiered bonuses, and performance ledgering.",
    wholesalePrice: "69.00",
    upstreamVendor: null,
    hiddenConnector: null,
    proxyNotes: null,
  },
  {
    slug: "payroll_hub",
    name: "Service Payroll Hub",
    category: "Core Service Modules",
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
    slug: "the_hartford",
    name: "Commercial Liability & Workers Comp",
    category: "Partner Integrations",
    categorySlug: "partners",
    description: "Commercial liability and workers compensation coverage for clients.",
    wholesalePrice: "0.00",
    upstreamVendor: "The Hartford",
    hiddenConnector: "The Hartford API Brokerage & Direct Underwriting Gateway",
    proxyNotes: null,
  },
  {
    slug: "vestwell",
    name: "Automated Retirement & 401(k)",
    category: "Partner Integrations",
    categorySlug: "partners",
    description: "Automated retirement plans and 401(k) administration.",
    wholesalePrice: "0.00",
    upstreamVendor: "Vestwell",
    hiddenConnector: "Vestwell Embedded API & Payroll Deduction Sync Engine",
    proxyNotes: null,
  },
  {
    slug: "simply_insured",
    name: "Group Health Insurance Hub",
    category: "Partner Integrations",
    categorySlug: "partners",
    description: "Group health insurance quoting and benefits administration.",
    wholesalePrice: "0.00",
    upstreamVendor: "SimplyInsured",
    hiddenConnector: "SimplyInsured Brokerage API & Benefits Administration Proxy",
    proxyNotes: null,
  },
  {
    slug: "gusto",
    name: "Integrated W-2 & Contractor Payroll",
    category: "Partner Integrations",
    categorySlug: "partners",
    description: "Full-service payroll for W-2 employees and 1099 contractors.",
    wholesalePrice: "0.00",
    upstreamVendor: "Gusto",
    hiddenConnector: "Gusto Embedded Payroll API & Tax Filing Engine",
    proxyNotes: null,
  },
  {
    slug: "quickbooks",
    name: "General Ledger & Financial Sync",
    category: "Partner Integrations",
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
 * Idempotent seed: upserts the hidden connector mapping into the modules table.
 * - Existing modules (matched by slug, falling back to name) get their connector
 *   fields refreshed from the mapping.
 * - Modules present in the mapping but missing from the DB are inserted, so the
 *   registry is always complete.
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
          category: entry.category,
          // Keep marketplace placement pinned — e.g. Core Service Modules
          // must stay under "operations" (Core Operations grid).
          categorySlug: entry.categorySlug,
          upstreamVendor: entry.upstreamVendor,
          hiddenConnector: entry.hiddenConnector,
          proxyNotes: entry.proxyNotes,
          wholesalePriceBiweekly: entry.wholesalePriceBiweekly ?? null,
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
        isActive: true,
        slug: entry.slug,
        upstreamVendor: entry.upstreamVendor,
        hiddenConnector: entry.hiddenConnector,
        proxyNotes: entry.proxyNotes,
      });
      inserted++;
    }
  }

  logger.info({ updated, inserted }, "Connector mapping seed complete");
}
