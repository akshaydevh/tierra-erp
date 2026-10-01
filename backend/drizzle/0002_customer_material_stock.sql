ALTER TABLE "items" ADD COLUMN "kind" text DEFAULT 'finished_good' NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_kind_check" CHECK ("items"."kind" in ('finished_good', 'laminate', 'seasoning', 'carton'));--> statement-breakpoint
ALTER TABLE "items" ALTER COLUMN "kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "inventory_balances" DROP CONSTRAINT "inventory_balances_pkey";--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD COLUMN "id" text;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD COLUMN "customer_id" text;--> statement-breakpoint
UPDATE "inventory_balances" SET "id" = 'bal_' || "item_id" WHERE "id" IS NULL;--> statement-breakpoint
ALTER TABLE "inventory_balances" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_pkey" PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_balances_plant_item" ON "inventory_balances" USING btree ("item_id") WHERE "inventory_balances"."customer_id" is null;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_owner_item" UNIQUE("customer_id","item_id");