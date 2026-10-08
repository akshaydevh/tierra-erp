ALTER TABLE "tasks" ADD COLUMN "assigned_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "tasks" SET "assigned_at" = "created_at";--> statement-breakpoint
UPDATE "order_documents" SET "message_id" = NULL
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", row_number() OVER (PARTITION BY "message_id" ORDER BY "created_at", "id") AS "copy"
    FROM "order_documents"
    WHERE "message_id" IS NOT NULL
  ) AS "documents"
  WHERE "copy" > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX "order_documents_message" ON "order_documents" USING btree ("message_id") WHERE "order_documents"."message_id" is not null;--> statement-breakpoint
UPDATE "account_relations" AS "relation" SET "phone_number" = '91' || "relation"."phone_number"
WHERE "relation"."phone_number" ~ '^[6-9][0-9]{9}$'
  AND NOT EXISTS (
    SELECT 1 FROM "account_relations" AS "other" WHERE "other"."phone_number" = '91' || "relation"."phone_number"
  );--> statement-breakpoint
UPDATE "account_relations" AS "relation" SET "phone_number" = '91' || substr("relation"."phone_number", 2)
WHERE "relation"."phone_number" ~ '^0[6-9][0-9]{9}$'
  AND NOT EXISTS (
    SELECT 1 FROM "account_relations" AS "other"
    WHERE "other"."phone_number" = '91' || substr("relation"."phone_number", 2)
  );
