CREATE TABLE "procurement_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"production_entry_id" text NOT NULL,
	"item_id" text NOT NULL,
	"quantity_kg" numeric(14, 3) NOT NULL,
	"unit" text NOT NULL,
	"assignee_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "production_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"finished_goods_kg" numeric(14, 3) NOT NULL,
	"kg_banana_per_kg_chips" numeric(8, 3) NOT NULL,
	"banana_kg" numeric(14, 3) NOT NULL,
	"source_months" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "items" DROP CONSTRAINT "items_kind_check";--> statement-breakpoint
ALTER TABLE "procurement_orders" ADD CONSTRAINT "procurement_orders_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_orders" ADD CONSTRAINT "procurement_orders_production_entry_id_production_entries_id_fk" FOREIGN KEY ("production_entry_id") REFERENCES "public"."production_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_orders" ADD CONSTRAINT "procurement_orders_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_orders" ADD CONSTRAINT "procurement_orders_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_entries" ADD CONSTRAINT "production_entries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_kind_check" CHECK ("items"."kind" in ('finished_good', 'laminate', 'seasoning', 'carton', 'raw_material'));