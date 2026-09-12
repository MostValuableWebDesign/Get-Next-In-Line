import {
  boolean,
  foreignKey,
  index,
  integer,
  numeric,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./agency";
import { sosResourcesTable, sosStaffMembersTable } from "./sos";

export const workforceIntegrationConnectionsTable = pgTable(
  "workforce_integration_connections",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    status: text("status").notNull().default("not_connected"),
    accessTokenEncrypted: text("access_token_encrypted"),
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    providerAccountId: text("provider_account_id"),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    lastSuccessfulSyncAt: timestamp("last_successful_sync_at", { withTimezone: true }),
    lastSyncAttemptAt: timestamp("last_sync_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("workforce_connections_tenant_provider_unique").on(
      table.tenantId,
      table.providerId,
    ),
    index("workforce_connections_tenant_status_idx").on(table.tenantId, table.status),
  ],
);

export const tenantIntegrationCapabilitiesTable = pgTable(
  "tenant_integration_capabilities",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
    providerId: text("provider_id").notNull(),
    isPrimary: boolean("is_primary").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("tenant_capabilities_provider_unique").on(
      table.tenantId,
      table.capability,
      table.providerId,
    ),
    uniqueIndex("tenant_capabilities_one_primary_idx")
      .on(table.tenantId, table.capability)
      .where(sql`${table.isPrimary} = true`),
    index("tenant_capabilities_tenant_idx").on(table.tenantId),
  ],
);

export const workforceSyncedRecordsTable = pgTable(
  "workforce_synced_records",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    recordType: text("record_type").notNull(),
    externalId: text("external_id").notNull(),
    normalizedData: jsonb("normalized_data").notNull(),
    rawUpdatedAt: timestamp("raw_updated_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("workforce_records_tenant_provider_type_external_unique").on(
      table.tenantId,
      table.providerId,
      table.recordType,
      table.externalId,
    ),
    index("workforce_records_tenant_type_idx").on(table.tenantId, table.recordType),
  ],
);

export const workforceOAuthStatesTable = pgTable(
  "workforce_oauth_states",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    stateHash: text("state_hash").notNull().unique(),
    sessionBindingHash: text("session_binding_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("workforce_oauth_states_tenant_provider_idx").on(
      table.tenantId,
      table.providerId,
      table.createdAt.desc(),
    ),
  ],
);

export const workforceConnectionEventsTable = pgTable(
  "workforce_connection_events",
  {
    id: serial("id").primaryKey(),
    connectionId: integer("connection_id")
      .notNull()
      .references(() => workforceIntegrationConnectionsTable.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    details: text("details"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("workforce_connection_events_connection_created_idx").on(
      table.connectionId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
  ],
);

export const workforcePeopleTable = pgTable(
  "workforce_people",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    externalId: text("external_id").notNull(),
    personType: text("person_type").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    displayName: text("display_name").notNull(),
    email: text("email"),
    normalizedEmail: text("normalized_email"),
    phone: text("phone"),
    employmentStatus: text("employment_status").notNull(),
    jobTitle: text("job_title"),
    hireDate: text("hire_date"),
    terminationDate: text("termination_date"),
    providerUpdatedAt: timestamp("provider_updated_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("workforce_people_tenant_provider_external_unique").on(
      table.tenantId,
      table.providerId,
      table.externalId,
    ),
    unique("workforce_people_tenant_id_id_unique").on(table.tenantId, table.id),
    index("workforce_people_tenant_status_idx").on(
      table.tenantId,
      table.employmentStatus,
    ),
    index("workforce_people_tenant_email_idx").on(table.tenantId, table.normalizedEmail),
  ],
);

export const workforceStaffLinksTable = pgTable(
  "workforce_staff_links",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    workforcePersonId: integer("workforce_person_id").notNull(),
    gnilStaffId: integer("gnil_staff_id"),
    gnilResourceId: integer("gnil_resource_id"),
    linkType: text("link_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("workforce_staff_links_person_unique").on(table.workforcePersonId),
    uniqueIndex("workforce_staff_links_staff_unique")
      .on(table.tenantId, table.gnilStaffId)
      .where(sql`${table.gnilStaffId} is not null`),
    uniqueIndex("workforce_staff_links_resource_unique")
      .on(table.tenantId, table.gnilResourceId)
      .where(sql`${table.gnilResourceId} is not null`),
    index("workforce_staff_links_tenant_idx").on(table.tenantId),
    foreignKey({
      columns: [table.tenantId, table.workforcePersonId],
      foreignColumns: [workforcePeopleTable.tenantId, workforcePeopleTable.id],
      name: "workforce_staff_links_person_tenant_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.gnilStaffId],
      foreignColumns: [sosStaffMembersTable.tenantId, sosStaffMembersTable.id],
      name: "workforce_staff_links_staff_tenant_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.gnilResourceId],
      foreignColumns: [sosResourcesTable.tenantId, sosResourcesTable.id],
      name: "workforce_staff_links_resource_tenant_fk",
    }).onDelete("cascade"),
  ],
);

/**
 * Normalized, read-only payroll runs. Provider payloads are intentionally not
 * retained; the external key is scoped by tenant and provider.
 */
export const workforcePayrollRunsTable = pgTable(
  "workforce_payroll_runs",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    externalId: text("external_id").notNull(),
    status: text("status").notNull(),
    payPeriodStart: text("pay_period_start").notNull(),
    payPeriodEnd: text("pay_period_end").notNull(),
    paymentDate: text("payment_date"),
    processed: boolean("processed").notNull(),
    processedDate: text("processed_date"),
    calculatedAt: timestamp("calculated_at", { withTimezone: true }),
    grossPayCents: numeric("gross_pay_cents", { precision: 20, scale: 0 }),
    netPayCents: numeric("net_pay_cents", { precision: 20, scale: 0 }),
    currency: text("currency").notNull().default("USD"),
    providerUpdatedAt: timestamp("provider_updated_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("workforce_payroll_runs_tenant_provider_external_unique").on(
      table.tenantId,
      table.providerId,
      table.externalId,
    ),
    index("workforce_payroll_runs_tenant_period_idx").on(
      table.tenantId,
      table.payPeriodStart,
    ),
  ],
);

/**
 * Normalized compensation history. Current provider reads are upserted by
 * provider job UUID, with no destructive deletion when a provider omits data.
 */
export const workforceCompensationsTable = pgTable(
  "workforce_compensations",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    externalEmployeeId: text("external_employee_id").notNull(),
    externalJobId: text("external_job_id").notNull(),
    workforcePersonId: integer("workforce_person_id"),
    amountCents: numeric("amount_cents", { precision: 20, scale: 0 }).notNull(),
    currency: text("currency").notNull().default("USD"),
    interval: text("interval").notNull(),
    effectiveFrom: text("effective_from"),
    effectiveTo: text("effective_to"),
    providerUpdatedAt: timestamp("provider_updated_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("workforce_compensations_tenant_provider_job_unique").on(
      table.tenantId,
      table.providerId,
      table.externalJobId,
    ),
    index("workforce_compensations_tenant_employee_idx").on(
      table.tenantId,
      table.externalEmployeeId,
    ),
    foreignKey({
      columns: [table.tenantId, table.workforcePersonId],
      foreignColumns: [workforcePeopleTable.tenantId, workforcePeopleTable.id],
      name: "workforce_compensations_person_tenant_fk",
    }).onDelete("set null"),
  ],
);

export const workforceCapabilitySyncsTable = pgTable(
  "workforce_capability_syncs",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    capability: text("capability").notNull(),
    status: text("status").notNull(),
    recordsRead: integer("records_read").notNull().default(0),
    recordsWritten: integer("records_written").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastSuccessfulAt: timestamp("last_successful_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("workforce_capability_sync_tenant_provider_capability_unique").on(
      table.tenantId,
      table.providerId,
      table.capability,
    ),
  ],
);

export const insertWorkforceIntegrationConnectionSchema = createInsertSchema(
  workforceIntegrationConnectionsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertWorkforceIntegrationConnection = z.infer<
  typeof insertWorkforceIntegrationConnectionSchema
>;
export type WorkforceIntegrationConnection =
  typeof workforceIntegrationConnectionsTable.$inferSelect;

export const insertTenantIntegrationCapabilitySchema = createInsertSchema(
  tenantIntegrationCapabilitiesTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertTenantIntegrationCapability = z.infer<
  typeof insertTenantIntegrationCapabilitySchema
>;
export type TenantIntegrationCapability =
  typeof tenantIntegrationCapabilitiesTable.$inferSelect;

export const insertWorkforceSyncedRecordSchema = createInsertSchema(
  workforceSyncedRecordsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertWorkforceSyncedRecord = z.infer<typeof insertWorkforceSyncedRecordSchema>;
export type WorkforceSyncedRecord = typeof workforceSyncedRecordsTable.$inferSelect;

export const insertWorkforceOAuthStateSchema = createInsertSchema(
  workforceOAuthStatesTable,
).omit({ id: true, createdAt: true });
export type InsertWorkforceOAuthState = z.infer<typeof insertWorkforceOAuthStateSchema>;

export const insertWorkforceConnectionEventSchema = createInsertSchema(
  workforceConnectionEventsTable,
).omit({ id: true, createdAt: true });
export type InsertWorkforceConnectionEvent = z.infer<
  typeof insertWorkforceConnectionEventSchema
>;

export const insertWorkforcePersonSchema = createInsertSchema(workforcePeopleTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertWorkforcePerson = z.infer<typeof insertWorkforcePersonSchema>;
export type WorkforcePerson = typeof workforcePeopleTable.$inferSelect;

export const insertWorkforceStaffLinkSchema = createInsertSchema(workforceStaffLinksTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertWorkforceStaffLink = z.infer<typeof insertWorkforceStaffLinkSchema>;
export type WorkforceStaffLink = typeof workforceStaffLinksTable.$inferSelect;
export type WorkforcePayrollRun = typeof workforcePayrollRunsTable.$inferSelect;
export type WorkforceCompensation = typeof workforceCompensationsTable.$inferSelect;
export type WorkforceCapabilitySync = typeof workforceCapabilitySyncsTable.$inferSelect;

export const insertWorkforcePayrollRunSchema = createInsertSchema(workforcePayrollRunsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertWorkforcePayrollRun = z.infer<typeof insertWorkforcePayrollRunSchema>;

export const insertWorkforceCompensationSchema = createInsertSchema(workforceCompensationsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertWorkforceCompensation = z.infer<typeof insertWorkforceCompensationSchema>;

export const insertWorkforceCapabilitySyncSchema = createInsertSchema(workforceCapabilitySyncsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertWorkforceCapabilitySync = z.infer<typeof insertWorkforceCapabilitySyncSchema>;