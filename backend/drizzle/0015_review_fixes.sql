-- P2-P4 review fixes.
-- Tierra sales orders: 'approved_unsent' (approved, but the bot sent nothing to the customer: no group, sales orders
-- switched off, or a send it could not confirm) and 'in_sap' (the office keyed it into SAP: SAP's open SO now holds
-- the stock, so the TSO stops reserving). The SAP sales order it was linked to is kept. Cess is carried separately
-- from GST so the TSO adds up to the PO.
-- Stock adjustments say when and why they stopped counting (absorbed by a GRN, cancelled, aged out).
-- Desk turns are stamped when their reply is in, so the desk stops waiting on that turn and not on any later post.
-- P1-era customer PO PDFs (stored before order_documents had a kind) are marked customer_po.
ALTER TABLE "sales_orders" DROP CONSTRAINT "sales_orders_status_check";--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_status_check" CHECK ("sales_orders"."status" in ('draft', 'pending_approval', 'approved', 'approved_unsent', 'sent', 'in_sap', 'rejected', 'cancelled'));--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "cess" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "sap_doc_entry" integer;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "sap_doc_no" text;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_orders_sap_doc_entry" ON "sales_orders" USING btree ("sap_doc_entry") WHERE "sales_orders"."sap_doc_entry" is not null;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD COLUMN "cess_amount" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_po_lines" ADD COLUMN "cess_amount" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD COLUMN "closed_note" text;--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ADD COLUMN "answered_at" timestamp with time zone;--> statement-breakpoint
UPDATE "order_documents" SET "kind" = 'customer_po'
WHERE "kind" = 'other'
  AND "id" IN (SELECT "subject_id" FROM "tasks" WHERE "kind" = 'review' AND "subject_type" = 'document' AND "title" LIKE 'Review PO%');
