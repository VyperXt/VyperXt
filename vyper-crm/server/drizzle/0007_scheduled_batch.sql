ALTER TABLE "scheduled_messages" ADD COLUMN "batch_id" text;--> statement-breakpoint
CREATE INDEX "scheduled_batch_idx" ON "scheduled_messages" USING btree ("batch_id");