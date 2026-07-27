import { Router, type Request, type IRouter } from "express";
import {
  db,
  tenantsTable,
  sosSettingsTable,
  merchantCoopPartnershipsTable,
  safetyIncidentsTable,
  safetyIncidentRecipientsTable,
  safetyIncidentEventsTable,
  safetyEmergencyContactsTable,
  safetyBroadcastTemplatesTable,
  safetyDefaultsSeededTable,
  type SafetyIncident,
} from "@workspace/db";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import {
  ListSafetyIncidentsResponse,
  CreateSafetyIncidentBody,
  CreateSafetyIncidentResponse,
  GetSafetyIncidentTimelineResponse,
  CreateSafetyIncidentUpdateBody,
  CreateSafetyIncidentUpdateResponse,
  AcknowledgeSafetyIncidentResponse,
  ResolveSafetyIncidentResponse,
  ListSafetyContactsResponse,
  CreateSafetyContactBody,
  CreateSafetyContactResponse,
  UpdateSafetyContactBody,
  UpdateSafetyContactResponse,
  ListSafetyTemplatesResponse,
  CreateSafetyTemplateBody,
  CreateSafetyTemplateResponse,
  UpdateSafetyTemplateBody,
  UpdateSafetyTemplateResponse,
} from "@workspace/api-zod";
import {
  encryptIncidentText,
  decryptIncidentText,
  isEncryptedIncidentText,
} from "../lib/safetyCrypto";
import { sendMessageSafe } from "../lib/messaging";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Co-Op Emergency & Safety Alert Network — /api/coop/safety/*
//
// Tenant-scoped (x-tenant-id header, same convention as the other merchant
// co-op routes). A merchant raises an incident; it is broadcast to every
// tenant they hold an accepted + active co-op partnership with. Sensitive
// incident text is encrypted at rest (see safetyCrypto.ts) and only decrypted
// when serializing for the originator or a recorded recipient. All routes sit
// behind the shared session auth.
// ---------------------------------------------------------------------------

const INCIDENT_TYPES = [
  "silent_panic",
  "suspicious_activity",
  "safety_hazard",
  "medical_emergency",
  "severe_weather",
] as const;

const INCIDENT_TYPE_LABELS: Record<string, string> = {
  silent_panic: "Silent panic",
  suspicious_activity: "Suspicious activity",
  safety_hazard: "Safety hazard",
  medical_emergency: "Medical emergency",
  severe_weather: "Severe weather",
};

/** Tenant scope from the x-tenant-id header (same convention as /api/coop). */
function tenantIdFrom(req: Request): number | null {
  const raw = req.header("x-tenant-id");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Decrypt stored incident text, tolerating legacy/plaintext rows. */
function decryptSafe(stored: string | null): string | null {
  if (stored == null) return null;
  if (!isEncryptedIncidentText(stored)) return stored;
  try {
    return decryptIncidentText(stored);
  } catch (err) {
    logger.error({ err }, "Failed to decrypt safety incident text");
    return "[undecryptable]";
  }
}

/**
 * Accepted + active co-op partner tenant ids for a tenant — the exact
 * recipient set for a safety broadcast. Perk date windows are deliberately
 * ignored: a scheduled/expired *perk* doesn't end the safety relationship;
 * only status and the isActive kill switch do.
 */
async function acceptedPartnerTenantIds(tenantId: number): Promise<number[]> {
  const rows = await db
    .select({
      hostTenantId: merchantCoopPartnershipsTable.hostTenantId,
      partnerTenantId: merchantCoopPartnershipsTable.partnerTenantId,
    })
    .from(merchantCoopPartnershipsTable)
    .where(
      and(
        eq(merchantCoopPartnershipsTable.status, "accepted"),
        eq(merchantCoopPartnershipsTable.isActive, true),
        or(
          eq(merchantCoopPartnershipsTable.hostTenantId, tenantId),
          eq(merchantCoopPartnershipsTable.partnerTenantId, tenantId)
        )
      )
    );
  const ids = new Set<number>();
  for (const r of rows) {
    ids.add(r.hostTenantId === tenantId ? r.partnerTenantId : r.hostTenantId);
  }
  ids.delete(tenantId);
  return [...ids];
}

interface IncidentCounts {
  recipientCount: number;
  acknowledgedCount: number;
  smsSentCount: number;
}

function serializeIncident(
  incident: SafetyIncident,
  tenantName: string,
  direction: "raised" | "received",
  counts: IncidentCounts,
  acknowledgedAt: Date | null
) {
  return {
    id: incident.id,
    tenantId: incident.tenantId,
    tenantName,
    direction,
    incidentType: incident.incidentType,
    description: decryptSafe(incident.description) ?? "",
    location: incident.location,
    status: incident.status,
    resolvedAt: incident.resolvedAt ? incident.resolvedAt.toISOString() : null,
    acknowledgedAt: acknowledgedAt ? acknowledgedAt.toISOString() : null,
    recipientCount: counts.recipientCount,
    acknowledgedCount: counts.acknowledgedCount,
    smsSentCount: counts.smsSentCount,
    createdAt: incident.createdAt.toISOString(),
    updatedAt: incident.updatedAt.toISOString(),
  };
}

async function countsFor(incidentIds: number[]): Promise<Map<number, IncidentCounts>> {
  const map = new Map<number, IncidentCounts>();
  if (incidentIds.length === 0) return map;
  const rows = await db
    .select({
      incidentId: safetyIncidentRecipientsTable.incidentId,
      acknowledgedAt: safetyIncidentRecipientsTable.acknowledgedAt,
    })
    .from(safetyIncidentRecipientsTable)
    .where(inArray(safetyIncidentRecipientsTable.incidentId, incidentIds));
  for (const r of rows) {
    const c = map.get(r.incidentId) ?? {
      recipientCount: 0,
      acknowledgedCount: 0,
      smsSentCount: 0,
    };
    c.recipientCount++;
    if (r.acknowledgedAt != null) c.acknowledgedCount++;
    map.set(r.incidentId, c);
  }
  return map;
}

async function tenantNames(ids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({ id: tenantsTable.id, brandName: tenantsTable.brandName })
    .from(tenantsTable)
    .where(inArray(tenantsTable.id, ids));
  for (const r of rows) map.set(r.id, r.brandName);
  return map;
}

/**
 * Load an incident visible to the requesting tenant: either it raised the
 * incident or it is a recorded recipient. Returns null (→ 404) otherwise, so
 * non-partnered tenants can't even learn an incident exists.
 */
async function visibleIncident(
  incidentId: number,
  tenantId: number
): Promise<{ incident: SafetyIncident; recipient: { id: number; acknowledgedAt: Date | null } | null } | null> {
  const [incident] = await db
    .select()
    .from(safetyIncidentsTable)
    .where(eq(safetyIncidentsTable.id, incidentId));
  if (!incident) return null;
  if (incident.tenantId === tenantId) return { incident, recipient: null };
  const [recipient] = await db
    .select({
      id: safetyIncidentRecipientsTable.id,
      acknowledgedAt: safetyIncidentRecipientsTable.acknowledgedAt,
    })
    .from(safetyIncidentRecipientsTable)
    .where(
      and(
        eq(safetyIncidentRecipientsTable.incidentId, incidentId),
        eq(safetyIncidentRecipientsTable.recipientTenantId, tenantId)
      )
    );
  if (!recipient) return null;
  return { incident, recipient };
}

async function serializeFor(
  incident: SafetyIncident,
  requestingTenantId: number,
  acknowledgedAt: Date | null
) {
  const counts = (await countsFor([incident.id])).get(incident.id) ?? {
    recipientCount: 0,
    acknowledgedCount: 0,
    smsSentCount: 0,
  };
  const names = await tenantNames([incident.tenantId]);
  return serializeIncident(
    incident,
    names.get(incident.tenantId) ?? `Business #${incident.tenantId}`,
    incident.tenantId === requestingTenantId ? "raised" : "received",
    counts,
    acknowledgedAt
  );
}

// ── GET /coop/safety/incidents — raised + received, newest first ────────────
router.get("/coop/safety/incidents", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }

  const raised = await db
    .select()
    .from(safetyIncidentsTable)
    .where(eq(safetyIncidentsTable.tenantId, tenantId))
    .orderBy(desc(safetyIncidentsTable.createdAt), desc(safetyIncidentsTable.id));

  const receivedRows = await db
    .select({
      incident: safetyIncidentsTable,
      acknowledgedAt: safetyIncidentRecipientsTable.acknowledgedAt,
    })
    .from(safetyIncidentRecipientsTable)
    .innerJoin(
      safetyIncidentsTable,
      eq(safetyIncidentRecipientsTable.incidentId, safetyIncidentsTable.id)
    )
    .where(eq(safetyIncidentRecipientsTable.recipientTenantId, tenantId))
    .orderBy(desc(safetyIncidentsTable.createdAt), desc(safetyIncidentsTable.id));

  const all = [
    ...raised.map((incident) => ({ incident, acknowledgedAt: null as Date | null, direction: "raised" as const })),
    ...receivedRows.map((r) => ({ incident: r.incident, acknowledgedAt: r.acknowledgedAt, direction: "received" as const })),
  ].sort((a, b) => b.incident.createdAt.getTime() - a.incident.createdAt.getTime());

  const counts = await countsFor(all.map((e) => e.incident.id));
  const names = await tenantNames([...new Set(all.map((e) => e.incident.tenantId))]);

  res.json(
    ListSafetyIncidentsResponse.parse(
      all.map((e) =>
        serializeIncident(
          e.incident,
          names.get(e.incident.tenantId) ?? `Business #${e.incident.tenantId}`,
          e.direction,
          counts.get(e.incident.id) ?? { recipientCount: 0, acknowledgedCount: 0, smsSentCount: 0 },
          e.acknowledgedAt
        )
      )
    )
  );
});

// ── POST /coop/safety/incidents — raise + broadcast to accepted partners ────
router.post("/coop/safety/incidents", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const parsed = CreateSafetyIncidentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  if (!(INCIDENT_TYPES as readonly string[]).includes(parsed.data.incidentType)) {
    res.status(400).json({ message: "Unknown incident type" });
    return;
  }
  const [me] = await db
    .select({ id: tenantsTable.id, brandName: tenantsTable.brandName })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId));
  if (!me) {
    res.status(404).json({ message: "Business not found" });
    return;
  }

  const description = parsed.data.description.trim();
  const location = parsed.data.location?.trim() || null;

  const [incident] = await db
    .insert(safetyIncidentsTable)
    .values({
      tenantId,
      incidentType: parsed.data.incidentType,
      description: encryptIncidentText(description),
      location,
    })
    .returning();

  const recipientIds = await acceptedPartnerTenantIds(tenantId);
  if (recipientIds.length > 0) {
    await db.insert(safetyIncidentRecipientsTable).values(
      recipientIds.map((recipientTenantId) => ({
        incidentId: incident.id,
        recipientTenantId,
      }))
    );
  }

  // Broadcast event opens the audit trail.
  await db.insert(safetyIncidentEventsTable).values({
    incidentId: incident.id,
    actorTenantId: tenantId,
    kind: "broadcast",
    body: encryptIncidentText(description),
  });

  // Notify each partner operator via the unified messaging layer. Simulated
  // SMS when Twilio isn't configured; every send (or skip) is recorded in the
  // messages audit trail either way. The alert text deliberately does NOT
  // include the sensitive description — partners read details in-app.
  let smsSentCount = 0;
  if (recipientIds.length > 0) {
    const settings = await db
      .select({
        tenantId: sosSettingsTable.tenantId,
        publicPhone: sosSettingsTable.publicPhone,
        smsFromNumber: sosSettingsTable.smsFromNumber,
      })
      .from(sosSettingsTable)
      .where(inArray(sosSettingsTable.tenantId, recipientIds));
    const typeLabel = INCIDENT_TYPE_LABELS[incident.incidentType] ?? incident.incidentType;
    for (const recipientTenantId of recipientIds) {
      const s = settings.find((x) => x.tenantId === recipientTenantId);
      const phone = s?.publicPhone?.trim() || s?.smsFromNumber?.trim() || null;
      const sent = await sendMessageSafe({
        tenantId: recipientTenantId,
        toNumber: phone,
        kind: "safety_alert",
        body: `SAFETY ALERT from co-op partner ${me.brandName}: ${typeLabel}${location ? ` near ${location}` : ""}. Open Safety Alerts in Get Next In Line for details and updates.`,
        context: { incidentId: incident.id, originTenantId: tenantId },
      });
      if (sent && (sent.status === "sent" || sent.status === "simulated")) smsSentCount++;
    }
  }

  res.status(201).json(
    CreateSafetyIncidentResponse.parse({
      ...serializeIncident(
        incident,
        me.brandName,
        "raised",
        { recipientCount: recipientIds.length, acknowledgedCount: 0, smsSentCount },
        null
      ),
    })
  );
});

// ── GET /coop/safety/incidents/:id/timeline — full audit trail ──────────────
router.get("/coop/safety/incidents/:id/timeline", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const id = Number(req.params.id);
  const found = Number.isInteger(id) ? await visibleIncident(id, tenantId) : null;
  if (!found) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  const events = await db
    .select()
    .from(safetyIncidentEventsTable)
    .where(eq(safetyIncidentEventsTable.incidentId, id))
    .orderBy(asc(safetyIncidentEventsTable.createdAt), asc(safetyIncidentEventsTable.id));
  const names = await tenantNames([...new Set(events.map((e) => e.actorTenantId))]);
  res.json(
    GetSafetyIncidentTimelineResponse.parse(
      events.map((e) => ({
        id: e.id,
        kind: e.kind,
        actorTenantId: e.actorTenantId,
        actorTenantName: names.get(e.actorTenantId) ?? `Business #${e.actorTenantId}`,
        body: decryptSafe(e.body),
        createdAt: e.createdAt.toISOString(),
      }))
    )
  );
});

// ── POST /coop/safety/incidents/:id/updates — originator status update ──────
router.post("/coop/safety/incidents/:id/updates", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const parsed = CreateSafetyIncidentUpdateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const id = Number(req.params.id);
  const found = Number.isInteger(id) ? await visibleIncident(id, tenantId) : null;
  if (!found) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  if (found.incident.tenantId !== tenantId) {
    res.status(403).json({ message: "Only the business that raised the alert can post updates" });
    return;
  }
  if (found.incident.status !== "active") {
    res.status(409).json({ message: "Incident is already resolved" });
    return;
  }
  await db.insert(safetyIncidentEventsTable).values({
    incidentId: id,
    actorTenantId: tenantId,
    kind: "update",
    body: encryptIncidentText(parsed.data.body.trim()),
  });
  const [updated] = await db
    .update(safetyIncidentsTable)
    .set({ updatedAt: new Date() })
    .where(eq(safetyIncidentsTable.id, id))
    .returning();
  res.json(CreateSafetyIncidentUpdateResponse.parse(await serializeFor(updated, tenantId, null)));
});

// ── POST /coop/safety/incidents/:id/acknowledge — recipient ack ─────────────
router.post("/coop/safety/incidents/:id/acknowledge", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const id = Number(req.params.id);
  const found = Number.isInteger(id) ? await visibleIncident(id, tenantId) : null;
  if (!found) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  if (found.incident.tenantId === tenantId || !found.recipient) {
    res.status(403).json({ message: "Only a recipient partner can acknowledge an alert" });
    return;
  }
  let ackAt = found.recipient.acknowledgedAt;
  if (ackAt == null) {
    // Conditional update guards against a concurrent double-acknowledge: only
    // the request that actually flips NULL→now records the timeline event.
    const now = new Date();
    const [flipped] = await db
      .update(safetyIncidentRecipientsTable)
      .set({ acknowledgedAt: now })
      .where(
        and(
          eq(safetyIncidentRecipientsTable.id, found.recipient.id),
          isNull(safetyIncidentRecipientsTable.acknowledgedAt)
        )
      )
      .returning();
    if (flipped) {
      ackAt = flipped.acknowledgedAt;
      await db.insert(safetyIncidentEventsTable).values({
        incidentId: id,
        actorTenantId: tenantId,
        kind: "acknowledgment",
        body: null,
      });
    } else {
      const [re] = await db
        .select({ acknowledgedAt: safetyIncidentRecipientsTable.acknowledgedAt })
        .from(safetyIncidentRecipientsTable)
        .where(eq(safetyIncidentRecipientsTable.id, found.recipient.id));
      ackAt = re?.acknowledgedAt ?? now;
    }
  }
  res.json(AcknowledgeSafetyIncidentResponse.parse(await serializeFor(found.incident, tenantId, ackAt)));
});

// ── POST /coop/safety/incidents/:id/resolve — originator resolves ───────────
router.post("/coop/safety/incidents/:id/resolve", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const id = Number(req.params.id);
  const found = Number.isInteger(id) ? await visibleIncident(id, tenantId) : null;
  if (!found) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  if (found.incident.tenantId !== tenantId) {
    res.status(403).json({ message: "Only the business that raised the alert can resolve it" });
    return;
  }
  const now = new Date();
  // Conditional update: only the request that flips active→resolved records
  // the resolution event, so concurrent resolves can't double-log.
  const [resolved] = await db
    .update(safetyIncidentsTable)
    .set({ status: "resolved", resolvedAt: now, updatedAt: now })
    .where(and(eq(safetyIncidentsTable.id, id), eq(safetyIncidentsTable.status, "active")))
    .returning();
  if (!resolved) {
    res.status(409).json({ message: "Incident is already resolved" });
    return;
  }
  await db.insert(safetyIncidentEventsTable).values({
    incidentId: id,
    actorTenantId: tenantId,
    kind: "resolution",
    body: null,
  });
  res.json(ResolveSafetyIncidentResponse.parse(await serializeFor(resolved, tenantId, null)));
});

// ── Seeded defaults for contacts & templates ─────────────────────────────────

const DEFAULT_CONTACTS = [
  { label: "Police (non-emergency)", phone: "911", category: "law_enforcement", sortOrder: 0 },
  { label: "Medical / EMS", phone: "911", category: "medical", sortOrder: 1 },
  { label: "Property management", phone: "", category: "property_management", sortOrder: 2 },
];

const DEFAULT_TEMPLATES = [
  {
    title: "Silent panic",
    incidentType: "silent_panic",
    body: "Silent alarm raised at our location. Please stay alert and avoid sending customers our way until we post an all-clear.",
  },
  {
    title: "Suspicious person nearby",
    incidentType: "suspicious_activity",
    body: "Suspicious activity reported near our storefront. Keep an eye on your entrance and secure valuables.",
  },
  {
    title: "Severe weather warning",
    incidentType: "severe_weather",
    body: "Severe weather approaching the area. Consider securing outdoor fixtures and checking on staff travel plans.",
  },
];

/** Idempotently seed default contacts/templates once per tenant. */
async function ensureSafetyDefaults(tenantId: number): Promise<void> {
  const [marker] = await db
    .select()
    .from(safetyDefaultsSeededTable)
    .where(eq(safetyDefaultsSeededTable.tenantId, tenantId));
  if (marker) return;
  try {
    await db.insert(safetyDefaultsSeededTable).values({ tenantId });
  } catch {
    // Unique violation: another request seeded concurrently — nothing to do.
    return;
  }
  // Skip 911 placeholders with empty phones only where noted; contacts with
  // blank phones are still useful placeholders the merchant fills in.
  await db.insert(safetyEmergencyContactsTable).values(
    DEFAULT_CONTACTS.map((c) => ({ ...c, tenantId }))
  );
  await db.insert(safetyBroadcastTemplatesTable).values(
    DEFAULT_TEMPLATES.map((t) => ({ ...t, tenantId }))
  );
}

// ── Emergency contacts CRUD ──────────────────────────────────────────────────

function serializeContact(c: typeof safetyEmergencyContactsTable.$inferSelect) {
  return {
    id: c.id,
    label: c.label,
    phone: c.phone,
    category: c.category,
    sortOrder: c.sortOrder,
    createdAt: c.createdAt.toISOString(),
  };
}

router.get("/coop/safety/contacts", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  await ensureSafetyDefaults(tenantId);
  const rows = await db
    .select()
    .from(safetyEmergencyContactsTable)
    .where(eq(safetyEmergencyContactsTable.tenantId, tenantId))
    .orderBy(asc(safetyEmergencyContactsTable.sortOrder), asc(safetyEmergencyContactsTable.id));
  res.json(ListSafetyContactsResponse.parse(rows.map(serializeContact)));
});

router.post("/coop/safety/contacts", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const parsed = CreateSafetyContactBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const [row] = await db
    .insert(safetyEmergencyContactsTable)
    .values({
      tenantId,
      label: parsed.data.label.trim(),
      phone: parsed.data.phone.trim(),
      category: parsed.data.category ?? "other",
      sortOrder: parsed.data.sortOrder ?? 0,
    })
    .returning();
  res.status(201).json(CreateSafetyContactResponse.parse(serializeContact(row)));
});

router.patch("/coop/safety/contacts/:id", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const id = Number(req.params.id);
  const parsed = UpdateSafetyContactBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const updates: Partial<typeof safetyEmergencyContactsTable.$inferInsert> = {};
  if (parsed.data.label !== undefined) updates.label = parsed.data.label.trim();
  if (parsed.data.phone !== undefined) updates.phone = parsed.data.phone.trim();
  if (parsed.data.category !== undefined) updates.category = parsed.data.category;
  if (parsed.data.sortOrder !== undefined) updates.sortOrder = parsed.data.sortOrder;
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ message: "No fields to update" });
    return;
  }
  updates.updatedAt = new Date();
  const [row] = await db
    .update(safetyEmergencyContactsTable)
    .set(updates)
    .where(
      and(
        eq(safetyEmergencyContactsTable.id, Number.isInteger(id) ? id : -1),
        eq(safetyEmergencyContactsTable.tenantId, tenantId)
      )
    )
    .returning();
  if (!row) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  res.json(UpdateSafetyContactResponse.parse(serializeContact(row)));
});

router.delete("/coop/safety/contacts/:id", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const id = Number(req.params.id);
  const [row] = await db
    .delete(safetyEmergencyContactsTable)
    .where(
      and(
        eq(safetyEmergencyContactsTable.id, Number.isInteger(id) ? id : -1),
        eq(safetyEmergencyContactsTable.tenantId, tenantId)
      )
    )
    .returning();
  if (!row) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  res.status(204).end();
});

// ── Broadcast templates CRUD ─────────────────────────────────────────────────

function serializeTemplate(t: typeof safetyBroadcastTemplatesTable.$inferSelect) {
  return {
    id: t.id,
    title: t.title,
    incidentType: t.incidentType,
    body: t.body,
    createdAt: t.createdAt.toISOString(),
  };
}

router.get("/coop/safety/templates", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  await ensureSafetyDefaults(tenantId);
  const rows = await db
    .select()
    .from(safetyBroadcastTemplatesTable)
    .where(eq(safetyBroadcastTemplatesTable.tenantId, tenantId))
    .orderBy(asc(safetyBroadcastTemplatesTable.id));
  res.json(ListSafetyTemplatesResponse.parse(rows.map(serializeTemplate)));
});

router.post("/coop/safety/templates", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const parsed = CreateSafetyTemplateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const [row] = await db
    .insert(safetyBroadcastTemplatesTable)
    .values({
      tenantId,
      title: parsed.data.title.trim(),
      incidentType: parsed.data.incidentType,
      body: parsed.data.body.trim(),
    })
    .returning();
  res.status(201).json(CreateSafetyTemplateResponse.parse(serializeTemplate(row)));
});

router.patch("/coop/safety/templates/:id", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const id = Number(req.params.id);
  const parsed = UpdateSafetyTemplateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const updates: Partial<typeof safetyBroadcastTemplatesTable.$inferInsert> = {};
  if (parsed.data.title !== undefined) updates.title = parsed.data.title.trim();
  if (parsed.data.incidentType !== undefined) updates.incidentType = parsed.data.incidentType;
  if (parsed.data.body !== undefined) updates.body = parsed.data.body.trim();
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ message: "No fields to update" });
    return;
  }
  updates.updatedAt = new Date();
  const [row] = await db
    .update(safetyBroadcastTemplatesTable)
    .set(updates)
    .where(
      and(
        eq(safetyBroadcastTemplatesTable.id, Number.isInteger(id) ? id : -1),
        eq(safetyBroadcastTemplatesTable.tenantId, tenantId)
      )
    )
    .returning();
  if (!row) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  res.json(UpdateSafetyTemplateResponse.parse(serializeTemplate(row)));
});

router.delete("/coop/safety/templates/:id", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  if (tenantId == null) {
    res.status(400).json({ message: "x-tenant-id header is required" });
    return;
  }
  const id = Number(req.params.id);
  const [row] = await db
    .delete(safetyBroadcastTemplatesTable)
    .where(
      and(
        eq(safetyBroadcastTemplatesTable.id, Number.isInteger(id) ? id : -1),
        eq(safetyBroadcastTemplatesTable.tenantId, tenantId)
      )
    )
    .returning();
  if (!row) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  res.status(204).end();
});

export default router;
