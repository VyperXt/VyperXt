CREATE TABLE "lead_samples" (
	"id" serial PRIMARY KEY NOT NULL,
	"lead_id" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'generating' NOT NULL,
	"trigger" text NOT NULL,
	"instruction" text,
	"title" text,
	"caption" text,
	"notes" text,
	"content" text,
	"image_png" text,
	"slug" text,
	"public_url" text,
	"error" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	CONSTRAINT "lead_samples_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "lead_samples" ADD CONSTRAINT "lead_samples_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_samples" ADD CONSTRAINT "lead_samples_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lead_samples_lead_idx" ON "lead_samples" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "lead_samples_generating_uq" ON "lead_samples" USING btree ("lead_id") WHERE status = 'generating';