-- P1: business data now comes from the SAP import (schemas sap / erp). The hand-made seed model goes.
-- order_documents stays as the store for PDFs received on WhatsApp and the desk; it no longer points at an order.
-- Open tasks about a seed order or a held (pending) order point at rows that are about to go: cancel them.
UPDATE "tasks" SET "status" = 'cancelled' WHERE "subject_type" IN ('order', 'pending_order') AND "status" IN ('todo', 'doing');--> statement-breakpoint
ALTER TABLE "order_documents" DROP COLUMN IF EXISTS "order_id";--> statement-breakpoint
DROP TABLE IF EXISTS "procurement_orders" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "production_entries" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "pending_order_lines" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "pending_orders" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "order_lines" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "orders" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "inventory_balances" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "items" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "customers" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "units" CASCADE;
