ALTER TABLE "retention_tasks" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "retention_tasks" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "retention_tasks_state_schedule_idx" ON "retention_tasks" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "retention_tasks_state_lease_idx" ON "retention_tasks" USING btree ("state","lease_until");