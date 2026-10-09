-- P3: customer PO intake v2 and the real inventory check.
-- Overlays on SAP (natural keys only, no cross-schema foreign keys): which SAP card a customer's delivery site is,
-- the customer's article / EAN for a Tierra item, who owns a material when SAP cannot tell, and short names for cards.
-- Then the received purchase orders, their lines, and the stock / BOM checks run against them.
-- order_documents also stores generated PDFs from P4 on: a kind, the record it belongs to and a version.
ALTER TABLE "order_documents" ADD COLUMN "kind" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_documents" ADD COLUMN "subject_type" text;--> statement-breakpoint
ALTER TABLE "order_documents" ADD COLUMN "subject_id" text;--> statement-breakpoint
ALTER TABLE "order_documents" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_documents" ADD CONSTRAINT "order_documents_kind_check" CHECK ("order_documents"."kind" in ('customer_po', 'other', 'so_pdf', 'so_annex', 'report'));--> statement-breakpoint
CREATE INDEX "order_documents_subject" ON "order_documents" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE TABLE "customer_sites" (
	"party_group_id" text NOT NULL,
	"site_code" text NOT NULL,
	"card_code" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_sites_party_group_id_site_code_pk" PRIMARY KEY("party_group_id","site_code")
);--> statement-breakpoint
ALTER TABLE "customer_sites" ADD CONSTRAINT "customer_sites_party_group_id_party_groups_id_fk" FOREIGN KEY ("party_group_id") REFERENCES "public"."party_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "customer_item_refs" (
	"id" text PRIMARY KEY NOT NULL,
	"party_group_id" text NOT NULL,
	"article_no" text,
	"ean" text,
	"item_code" text NOT NULL,
	"buyer_uom" text,
	"pcs_per_uom" numeric(12, 3),
	"last_price" numeric(14, 4),
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_item_refs_key_check" CHECK ("customer_item_refs"."article_no" is not null or "customer_item_refs"."ean" is not null)
);--> statement-breakpoint
ALTER TABLE "customer_item_refs" ADD CONSTRAINT "customer_item_refs_party_group_id_party_groups_id_fk" FOREIGN KEY ("party_group_id") REFERENCES "public"."party_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_item_refs_article" ON "customer_item_refs" USING btree ("party_group_id","article_no") WHERE "customer_item_refs"."article_no" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_item_refs_ean" ON "customer_item_refs" USING btree ("party_group_id","ean") WHERE "customer_item_refs"."ean" is not null;--> statement-breakpoint
CREATE TABLE "item_owner_overrides" (
	"item_code" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"owner_card_code" text,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_owner_overrides_owner_check" CHECK ("item_owner_overrides"."owner" in ('tierra', 'customer'))
);--> statement-breakpoint
CREATE TABLE "party_aliases" (
	"card_code" text PRIMARY KEY NOT NULL,
	"alias" text NOT NULL
);--> statement-breakpoint
CREATE TABLE "customer_pos" (
	"id" text PRIMARY KEY NOT NULL,
	"party_group_id" text,
	"po_no" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"card_code" text,
	"site_code" text,
	"ship_to_gstin" text,
	"ship_to_address" text,
	"buyer_name" text,
	"vendor_code" text,
	"po_date" date,
	"delivery_date" date,
	"basic_total" numeric(14, 2),
	"tax_total" numeric(14, 2),
	"total" numeric(14, 2),
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reader" text,
	"resolution" jsonb,
	"review_reason" text,
	"repeat_of" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"document_id" text,
	"source_chat" text,
	"source_message_id" text,
	"source_sender" text,
	"raised_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_pos_status_check" CHECK ("customer_pos"."status" in ('received', 'needs_review', 'awaiting_proceed', 'short', 'checked', 'cancelled'))
);--> statement-breakpoint
ALTER TABLE "customer_pos" ADD CONSTRAINT "customer_pos_party_group_id_party_groups_id_fk" FOREIGN KEY ("party_group_id") REFERENCES "public"."party_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_pos" ADD CONSTRAINT "customer_pos_document_id_order_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."order_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_pos" ADD CONSTRAINT "customer_pos_raised_by_users_id_fk" FOREIGN KEY ("raised_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_pos_live" ON "customer_pos" USING btree ("party_group_id","po_no","revision") WHERE "customer_pos"."status" <> 'cancelled';--> statement-breakpoint
CREATE UNIQUE INDEX "customer_pos_message" ON "customer_pos" USING btree ("source_message_id") WHERE "customer_pos"."source_message_id" is not null;--> statement-breakpoint
CREATE INDEX "customer_pos_po_no" ON "customer_pos" USING btree ("po_no");--> statement-breakpoint
CREATE TABLE "customer_po_lines" (
	"customer_po_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"article_no" text,
	"ean" text,
	"description" text NOT NULL,
	"hsn" text,
	"qty" numeric(14, 3) NOT NULL,
	"uom" text,
	"ea_qty" numeric(14, 3),
	"mrp" numeric(14, 2),
	"base_cost" numeric(14, 4),
	"gst_pct" numeric(6, 2),
	"tax_amount" numeric(14, 2),
	"line_total" numeric(14, 2),
	"delivery_date" date,
	"item_code" text,
	"item_name" text,
	"match_method" text,
	"match_confirmed" boolean DEFAULT false NOT NULL,
	"pcs" numeric(14, 3),
	"pcs_source" text,
	"pcs_per_uom" numeric(12, 3),
	"unit_price" numeric(14, 4),
	"note" text,
	CONSTRAINT "customer_po_lines_customer_po_id_line_no_pk" PRIMARY KEY("customer_po_id","line_no"),
	CONSTRAINT "customer_po_lines_match_check" CHECK ("customer_po_lines"."match_method" is null or "customer_po_lines"."match_method" in ('article', 'ean', 'history', 'name', 'manual')),
	CONSTRAINT "customer_po_lines_pcs_source_check" CHECK ("customer_po_lines"."pcs_source" is null or "customer_po_lines"."pcs_source" in ('ea', 'ref', 'npu', 'pcs'))
);--> statement-breakpoint
ALTER TABLE "customer_po_lines" ADD CONSTRAINT "customer_po_lines_customer_po_id_customer_pos_id_fk" FOREIGN KEY ("customer_po_id") REFERENCES "public"."customer_pos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "inventory_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_po_id" text,
	"kind" text NOT NULL,
	"verdict" text NOT NULL,
	"data_as_of" date,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_checks_kind_check" CHECK ("inventory_checks"."kind" in ('po', 'dry_run')),
	CONSTRAINT "inventory_checks_verdict_check" CHECK ("inventory_checks"."verdict" in ('pass', 'pass_with_incoming', 'fail'))
);--> statement-breakpoint
ALTER TABLE "inventory_checks" ADD CONSTRAINT "inventory_checks_customer_po_id_customer_pos_id_fk" FOREIGN KEY ("customer_po_id") REFERENCES "public"."customer_pos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_checks" ADD CONSTRAINT "inventory_checks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_checks_po" ON "inventory_checks" USING btree ("customer_po_id","created_at");--> statement-breakpoint
CREATE TABLE "inventory_check_lines" (
	"check_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"kind" text NOT NULL,
	"item_code" text NOT NULL,
	"item_name" text,
	"role" text,
	"uom" text,
	"need" numeric(16, 4) NOT NULL,
	"on_hand" numeric(16, 4) DEFAULT 0 NOT NULL,
	"committed" numeric(16, 4) DEFAULT 0 NOT NULL,
	"reserved" numeric(16, 4) DEFAULT 0 NOT NULL,
	"adjustments" numeric(16, 4) DEFAULT 0 NOT NULL,
	"free" numeric(16, 4) DEFAULT 0 NOT NULL,
	"on_order" numeric(16, 4) DEFAULT 0 NOT NULL,
	"short_now" numeric(16, 4) DEFAULT 0 NOT NULL,
	"short_after_incoming" numeric(16, 4) DEFAULT 0 NOT NULL,
	"from_stock" numeric(16, 4),
	"to_make" numeric(16, 4),
	"owner" text,
	"owner_card_code" text,
	"owner_name" text,
	"checked" boolean DEFAULT true NOT NULL,
	"estimated" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"incoming" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"for_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	CONSTRAINT "inventory_check_lines_check_id_line_no_pk" PRIMARY KEY("check_id","line_no"),
	CONSTRAINT "inventory_check_lines_kind_check" CHECK ("inventory_check_lines"."kind" in ('fg', 'component')),
	CONSTRAINT "inventory_check_lines_status_check" CHECK ("inventory_check_lines"."status" in ('ok', 'short_now', 'short')),
	CONSTRAINT "inventory_check_lines_owner_check" CHECK ("inventory_check_lines"."owner" is null or "inventory_check_lines"."owner" in ('tierra', 'customer', 'customer_unknown'))
);--> statement-breakpoint
ALTER TABLE "inventory_check_lines" ADD CONSTRAINT "inventory_check_lines_check_id_inventory_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."inventory_checks"("id") ON DELETE cascade ON UPDATE no action;
