ALTER TABLE "workforce_compensations" ALTER COLUMN "amount_cents" SET DATA TYPE numeric(20, 0);--> statement-breakpoint
ALTER TABLE "workforce_payroll_runs" ALTER COLUMN "gross_pay_cents" SET DATA TYPE numeric(20, 0);--> statement-breakpoint
ALTER TABLE "workforce_payroll_runs" ALTER COLUMN "net_pay_cents" SET DATA TYPE numeric(20, 0);