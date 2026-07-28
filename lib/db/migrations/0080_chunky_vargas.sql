CREATE TABLE "mrr_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"snapshot_date" text NOT NULL,
	"total_mrr" numeric(12, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mrr_snapshots_snapshot_date_unique" UNIQUE("snapshot_date")
);
