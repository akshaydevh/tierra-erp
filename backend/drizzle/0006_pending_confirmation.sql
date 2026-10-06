ALTER TABLE "procurement_orders" ALTER COLUMN "order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "procurement_orders" ALTER COLUMN "production_entry_id" DROP NOT NULL;--> statement-breakpoint
CREATE TABLE "pending_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"po_number" text NOT NULL,
	"po_date" date,
	"remote_jid" text NOT NULL,
	"document_id" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_orders_status_check" CHECK ("pending_orders"."status" in ('awaiting_admin', 'confirmed', 'declined'))
);--> statement-breakpoint
CREATE TABLE "pending_order_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"pending_order_id" text NOT NULL,
	"item_id" text NOT NULL,
	"description" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit" text NOT NULL,
	"unit_price" numeric(12, 2)
);--> statement-breakpoint
ALTER TABLE "pending_orders" ADD CONSTRAINT "pending_orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_orders" ADD CONSTRAINT "pending_orders_document_id_order_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."order_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_order_lines" ADD CONSTRAINT "pending_order_lines_pending_order_id_pending_orders_id_fk" FOREIGN KEY ("pending_order_id") REFERENCES "public"."pending_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_order_lines" ADD CONSTRAINT "pending_order_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_orders" ADD COLUMN "pending_order_id" text;--> statement-breakpoint
ALTER TABLE "procurement_orders" ADD CONSTRAINT "procurement_orders_pending_order_id_pending_orders_id_fk" FOREIGN KEY ("pending_order_id") REFERENCES "public"."pending_orders"("id") ON DELETE cascade ON UPDATE no action;