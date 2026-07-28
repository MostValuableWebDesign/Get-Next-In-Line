import { pgTable, varchar, json, timestamp, index } from "drizzle-orm/pg-core";

// ── Express session store ────────────────────────────────────────────────────
// Backing table for connect-pg-simple (express-session Postgres store) so
// login sessions survive server restarts/redeploys. Shape must match the
// store's expected DDL: sid PK, JSON session payload, expire timestamp with
// an index (the store's pruner deletes rows where expire < now()).
export const sessionTable = pgTable(
  "session",
  {
    sid: varchar("sid").primaryKey(),
    sess: json("sess").notNull(),
    expire: timestamp("expire", { precision: 6 }).notNull(),
  },
  (t) => [index("IDX_session_expire").on(t.expire)],
);
