import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  numeric,
  timestamp,
} from "drizzle-orm/pg-core";
import { clientProfilesTable } from "./concierge";

// SOS operations platform tables (separate product from GNIL OS agency tables)

export const sosSettingsTable = pgTable("sos_settings", {
  id: serial("id").primaryKey(),
  businessName: text("business_name").notNull().default("SOS Operations"),
  industryType: text("industry_type").notNull().default("salon"),
  resourceLabel: text("resource_label").notNull().default("Chair"),
  aiReceptionistEnabled: boolean("ai_receptionist_enabled").notNull().default(true),
  waitlistAutoFillEnabled: boolean("waitlist_auto_fill_enabled").notNull().default(true),
  smsFromNumber: text("sms_from_number"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const sosResourcesTable = pgTable("sos_resources", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  resourceType: text("resource_type").notNull(),
  // available | occupied | cleaning | offline
  status: text("status").notNull().default("available"),
  currentVisitId: integer("current_visit_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const sosCustomersTable = pgTable("sos_customers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone"),
  email: text("email"),
  smsOptIn: boolean("sms_opt_in").notNull().default(true),
  // Explicit link to a concierge client_profiles row (marketing record for the
  // same person). Established by phone matching but survives phone edits.
  clientProfileId: integer("client_profile_id").references(
    () => clientProfilesTable.id,
    { onDelete: "set null" },
  ),
  visitCount: integer("visit_count").notNull().default(0),
  lastVisitAt: timestamp("last_visit_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const sosVisitsTable = pgTable("sos_visits", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id")
    .notNull()
    .references(() => sosCustomersTable.id),
  // checked_in | queued | assigned | notified | in_service | payment | checked_out
  status: text("status").notNull().default("checked_in"),
  serviceType: text("service_type").notNull(),
  partySize: integer("party_size").notNull().default(1),
  resourceId: integer("resource_id").references(() => sosResourcesTable.id),
  estimatedWaitMinutes: integer("estimated_wait_minutes"),
  paymentAmount: numeric("payment_amount", { precision: 10, scale: 2 }),
  checkedInAt: timestamp("checked_in_at").notNull().defaultNow(),
  serviceStartedAt: timestamp("service_started_at"),
  checkedOutAt: timestamp("checked_out_at"),
});

export const sosAppointmentsTable = pgTable("sos_appointments", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id")
    .notNull()
    .references(() => sosCustomersTable.id),
  serviceType: text("service_type").notNull(),
  startsAt: timestamp("starts_at").notNull(),
  endsAt: timestamp("ends_at").notNull(),
  // booked | cancelled | completed | filled
  status: text("status").notNull().default("booked"),
  // staff | ai_receptionist | waitlist_fill | self_book
  source: text("source").notNull().default("staff"),
  resourceId: integer("resource_id").references(() => sosResourcesTable.id),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const sosWaitlistTable = pgTable("sos_waitlist_entries", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id")
    .notNull()
    .references(() => sosCustomersTable.id),
  desiredService: text("desired_service").notNull(),
  // waiting | notified | booked | expired
  status: text("status").notNull().default("waiting"),
  notifiedAt: timestamp("notified_at"),
  openSlotStartsAt: timestamp("open_slot_starts_at"),
  openSlotEndsAt: timestamp("open_slot_ends_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const sosCallsTable = pgTable("sos_calls", {
  id: serial("id").primaryKey(),
  fromNumber: text("from_number").notNull(),
  callerName: text("caller_name"),
  intent: text("intent").notNull(),
  transcriptSummary: text("transcript_summary"),
  // booked | followup_sms | message_taken | no_action
  outcome: text("outcome").notNull().default("no_action"),
  appointmentId: integer("appointment_id").references(() => sosAppointmentsTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
