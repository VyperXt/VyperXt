ALTER TABLE "leads" ADD COLUMN "wa_jid" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "reply_to_id" integer;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_wa_jid_unique" UNIQUE("wa_jid");--> statement-breakpoint
-- Celulares brasileiros gravados sem o 9 (ex.: 553199998888) passam para o formato canônico
-- (5531999998888). Se os dois formatos já existirem, o registro antigo fica como está:
-- a busca por telefone também encontra a variante sem o 9.
UPDATE "leads" SET "phone" = '55' || substr("phone", 3, 2) || '9' || substr("phone", 5)
WHERE "phone" ~ '^55[0-9]{2}[6-9][0-9]{7}$'
  AND NOT EXISTS (
    SELECT 1 FROM "leads" AS "other"
    WHERE "other"."phone" = '55' || substr("leads"."phone", 3, 2) || '9' || substr("leads"."phone", 5)
  );
