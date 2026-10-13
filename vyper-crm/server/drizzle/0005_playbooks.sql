CREATE TABLE "playbooks" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"goal" text DEFAULT '' NOT NULL,
	"offer" text DEFAULT '' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"handoff_rules" text DEFAULT '' NOT NULL,
	"first_message" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "playbook_id" integer;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_playbook_id_playbooks_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."playbooks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leads_playbook_idx" ON "leads" USING btree ("playbook_id");