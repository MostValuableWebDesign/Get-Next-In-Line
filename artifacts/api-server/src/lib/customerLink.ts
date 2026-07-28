import { db, sosCustomersTable, clientProfilesTable, type ClientProfile } from "@workspace/db";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { normalizeToE164 } from "./sms";
import { logger } from "./logger";

// ── SOS customer ⇄ concierge client profile link ─────────────────────────────
// The link is an explicit FK (sos_customers.client_profile_id) so it survives
// phone edits. Phone matching is only used to *establish* the link.

/**
 * Find the concierge client profile that matches a phone number.
 * Returns the profile only when exactly one distinct profile matches the
 * normalized number — ambiguous matches are never auto-linked.
 */
export async function findProfileByPhone(
  phone: string | null | undefined,
): Promise<ClientProfile | null> {
  const target = normalizeToE164(phone);
  if (!target) return null;
  const last10 = target.replace(/\D/g, "").slice(-10);
  if (!last10) return null;
  // Bounded lookup: prefilter in SQL on the last 10 digits (served by the
  // client_profiles_phone_digits_idx expression index) instead of loading the
  // whole table. Any profile that normalizes to `target` necessarily shares
  // those digits, so the candidate set is a superset of the true matches.
  const candidates = await db
    .select()
    .from(clientProfilesTable)
    .where(
      and(
        isNotNull(clientProfilesTable.phone),
        sql`right(regexp_replace(${clientProfilesTable.phone}, '\\D', '', 'g'), 10) = ${last10}`,
      ),
    )
    .limit(PHONE_MATCH_CANDIDATE_LIMIT);
  // A truncated candidate set can't prove uniqueness — treat as ambiguous.
  if (candidates.length >= PHONE_MATCH_CANDIDATE_LIMIT) return null;
  const matches = candidates.filter((p) => normalizeToE164(p.phone) === target);
  return matches.length === 1 ? matches[0] : null;
}

/** More same-digit candidates than this is inherently ambiguous — never auto-link. */
const PHONE_MATCH_CANDIDATE_LIMIT = 25;

/**
 * Try to link an unlinked SOS customer to a concierge profile by phone match.
 * Returns the linked profile, or null when no unambiguous match exists.
 */
export async function autoLinkCustomer(customer: {
  id: number;
  phone: string | null;
  clientProfileId: number | null;
}): Promise<ClientProfile | null> {
  if (customer.clientProfileId != null) return null;
  const profile = await findProfileByPhone(customer.phone);
  if (!profile) return null;
  await db
    .update(sosCustomersTable)
    .set({ clientProfileId: profile.id })
    .where(eq(sosCustomersTable.id, customer.id));
  logger.info(
    { customerId: customer.id, clientProfileId: profile.id },
    "Linked SOS customer to concierge client profile by phone match",
  );
  return profile;
}

/**
 * Idempotent backfill: link every unlinked SOS customer to a concierge
 * profile when its normalized phone matches exactly one profile. Uses the
 * same unambiguous-match rule as autoLinkCustomer. Safe to run repeatedly
 * (e.g. at startup) — already-linked customers are never touched.
 */
export async function backfillCustomerLinks(): Promise<number> {
  // Bounded: only unlinked customers with a phone can possibly be linked, so
  // never load already-linked or phoneless rows.
  const [customers, profiles] = await Promise.all([
    db
      .select({
        id: sosCustomersTable.id,
        phone: sosCustomersTable.phone,
        clientProfileId: sosCustomersTable.clientProfileId,
      })
      .from(sosCustomersTable)
      .where(and(isNull(sosCustomersTable.clientProfileId), isNotNull(sosCustomersTable.phone))),
    db.select().from(clientProfilesTable).where(isNotNull(clientProfilesTable.phone)),
  ]);
  const byPhone = new Map<string, ClientProfile[]>();
  for (const p of profiles) {
    const key = normalizeToE164(p.phone);
    if (!key) continue;
    const list = byPhone.get(key) ?? [];
    list.push(p);
    byPhone.set(key, list);
  }
  let linked = 0;
  for (const c of customers) {
    if (c.clientProfileId != null) continue;
    const key = normalizeToE164(c.phone);
    if (!key) continue;
    const matches = byPhone.get(key) ?? [];
    if (matches.length !== 1) continue;
    await db
      .update(sosCustomersTable)
      .set({ clientProfileId: matches[0].id })
      .where(eq(sosCustomersTable.id, c.id));
    linked++;
  }
  if (linked > 0) {
    logger.info({ linked }, "Backfilled SOS customer → concierge profile links");
  }
  return linked;
}

export interface ProfileSyncFields {
  name?: string;
  phone?: string | null;
  email?: string | null;
  smsOptIn?: boolean;
}

/**
 * Propagate core contact fields / opt-in state from an SOS customer to its
 * linked concierge profile so automations see consistent data.
 */
export async function syncLinkedProfile(
  clientProfileId: number | null,
  fields: ProfileSyncFields,
): Promise<void> {
  if (clientProfileId == null) return;
  const updates: Partial<typeof clientProfilesTable.$inferInsert> = {};
  if (fields.name !== undefined) updates.name = fields.name;
  if (fields.phone !== undefined) updates.phone = fields.phone;
  if (fields.email !== undefined) updates.email = fields.email;
  if (fields.smsOptIn !== undefined) updates.smsOptIn = fields.smsOptIn;
  if (Object.keys(updates).length === 0) return;
  await db
    .update(clientProfilesTable)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(clientProfilesTable.id, clientProfileId));
}

/** Fetch the linked concierge profile for a customer, if any. */
export async function getLinkedProfile(
  clientProfileId: number | null,
): Promise<ClientProfile | null> {
  if (clientProfileId == null) return null;
  const [profile] = await db
    .select()
    .from(clientProfilesTable)
    .where(eq(clientProfilesTable.id, clientProfileId));
  return profile ?? null;
}
