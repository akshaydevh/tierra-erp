-- P4: Tierra sales orders raised from checked customer POs, their approval by the admin, procurement requests and
-- unposted stock adjustments. TSO numbers come from doc_counters (one row per series and financial year), taken in
-- the same transaction as the sales order insert. Every workflow insert is protected by a unique key so a re-run
-- job cannot make a second TSO, approval or request.
ALTER TABLE "customer_pos" ADD COLUMN "delivery_term" text;--> statement-breakpoint
ALTER TABLE "customer_pos" ADD COLUMN "payment_terms" text;--> statement-breakpoint
CREATE TABLE "doc_counters" (
	"series" text NOT NULL,
	"fy" text NOT NULL,
	"next" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_counters_series_fy_pk" PRIMARY KEY("series","fy")
);--> statement-breakpoint
CREATE TABLE "sales_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"doc_no" text NOT NULL,
	"series" text DEFAULT 'TSO' NOT NULL,
	"fy" text NOT NULL,
	"seq" integer NOT NULL,
	"customer_po_id" text,
	"party_group_id" text,
	"card_code" text NOT NULL,
	"check_id" text,
	"status" text DEFAULT 'pending_approval' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"doc_date" date NOT NULL,
	"delivery_date" date,
	"customer_po_no" text,
	"po_date" date,
	"vendor_code" text,
	"site_code" text,
	"ship_to_gstin" text,
	"place_of_supply" text,
	"state_code" text,
	"tax_kind" text DEFAULT 'cgst_sgst' NOT NULL,
	"basic_total" numeric(14, 2) NOT NULL,
	"cgst" numeric(14, 2) DEFAULT '0' NOT NULL,
	"sgst" numeric(14, 2) DEFAULT '0' NOT NULL,
	"igst" numeric(14, 2) DEFAULT '0' NOT NULL,
	"tax_total" numeric(14, 2) NOT NULL,
	"total" numeric(14, 2) NOT NULL,
	"delivery_term" text,
	"payment_terms" text,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_orders_doc_no_unique" UNIQUE("doc_no"),
	CONSTRAINT "sales_orders_status_check" CHECK ("sales_orders"."status" in ('draft', 'pending_approval', 'approved', 'sent', 'rejected', 'cancelled')),
	CONSTRAINT "sales_orders_tax_kind_check" CHECK ("sales_orders"."tax_kind" in ('cgst_sgst', 'igst'))
);--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_customer_po_id_customer_pos_id_fk" FOREIGN KEY ("customer_po_id") REFERENCES "public"."customer_pos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_party_group_id_party_groups_id_fk" FOREIGN KEY ("party_group_id") REFERENCES "public"."party_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_check_id_inventory_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."inventory_checks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_orders_live_po" ON "sales_orders" USING btree ("customer_po_id") WHERE "sales_orders"."customer_po_id" is not null and "sales_orders"."status" not in ('cancelled', 'rejected');--> statement-breakpoint
CREATE INDEX "sales_orders_status" ON "sales_orders" USING btree ("status");--> statement-breakpoint
CREATE TABLE "sales_order_lines" (
	"sales_order_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"item_code" text NOT NULL,
	"item_name" text,
	"description" text,
	"article_no" text,
	"ean" text,
	"hsn" text,
	"po_hsn" text,
	"uom" text,
	"qty" numeric(14, 3) NOT NULL,
	"pcs" numeric(14, 3) NOT NULL,
	"pcs_per_uom" numeric(12, 3),
	"cartons" numeric(14, 3),
	"mrp" numeric(14, 2),
	"unit_price" numeric(14, 4) NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"gst_pct" numeric(6, 2) NOT NULL,
	"tax_amount" numeric(14, 2) NOT NULL,
	"reserved_pcs" numeric(14, 3) DEFAULT '0' NOT NULL,
	"to_make" numeric(14, 3) DEFAULT '0' NOT NULL,
	CONSTRAINT "sales_order_lines_sales_order_id_line_no_pk" PRIMARY KEY("sales_order_id","line_no")
);--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sales_order_lines_item" ON "sales_order_lines" USING btree ("item_code");--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"version" integer NOT NULL,
	"approver_role" text DEFAULT 'admin' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"channel" text,
	"via" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"note" text,
	"self_raised" boolean DEFAULT false NOT NULL,
	"raised_by" text,
	"wa_message_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"task_id" text,
	"so_pdf_id" text,
	"annex_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_status_check" CHECK ("approvals"."status" in ('pending', 'approved', 'sent_back', 'rejected', 'superseded')),
	CONSTRAINT "approvals_channel_check" CHECK ("approvals"."channel" is null or "approvals"."channel" in ('whatsapp', 'desk')),
	CONSTRAINT "approvals_via_check" CHECK ("approvals"."via" is null or "approvals"."via" in ('reaction', 'reply', 'text', 'llm', 'desk')),
	CONSTRAINT "approvals_approver_role_check" CHECK ("approvals"."approver_role" in ('admin', 'manager', 'office'))
);--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_raised_by_users_id_fk" FOREIGN KEY ("raised_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_so_pdf_id_order_documents_id_fk" FOREIGN KEY ("so_pdf_id") REFERENCES "public"."order_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_annex_id_order_documents_id_fk" FOREIGN KEY ("annex_id") REFERENCES "public"."order_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_subject_version" ON "approvals" USING btree ("subject_type","subject_id","version");--> statement-breakpoint
CREATE INDEX "approvals_status" ON "approvals" USING btree ("status");--> statement-breakpoint
CREATE TABLE "procurement_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"customer_po_id" text,
	"sales_order_id" text,
	"item_code" text NOT NULL,
	"item_name" text,
	"qty" numeric(16, 4) NOT NULL,
	"uom" text,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"task_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "procurement_requests_reason_check" CHECK ("procurement_requests"."reason" in ('production', 'expedite', 'shortage')),
	CONSTRAINT "procurement_requests_status_check" CHECK ("procurement_requests"."status" in ('open', 'done', 'cancelled'))
);--> statement-breakpoint
ALTER TABLE "procurement_requests" ADD CONSTRAINT "procurement_requests_customer_po_id_customer_pos_id_fk" FOREIGN KEY ("customer_po_id") REFERENCES "public"."customer_pos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_requests" ADD CONSTRAINT "procurement_requests_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "procurement_requests_subject_item_reason" ON "procurement_requests" USING btree ("subject_id","item_code","reason");--> statement-breakpoint
CREATE TABLE "stock_adjustments" (
	"id" text PRIMARY KEY NOT NULL,
	"item_code" text NOT NULL,
	"qty" numeric(16, 4) NOT NULL,
	"uom" text,
	"reason" text DEFAULT 'receipt_unposted' NOT NULL,
	"note" text,
	"task_id" text,
	"created_by" text,
	"created_via" text DEFAULT 'dashboard' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_adjustments_status_check" CHECK ("stock_adjustments"."status" in ('active', 'absorbed', 'cancelled')),
	CONSTRAINT "stock_adjustments_created_via_check" CHECK ("stock_adjustments"."created_via" in ('dashboard', 'whatsapp', 'desk', 'system'))
);--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_adjustments_item" ON "stock_adjustments" USING btree ("item_code","status");
