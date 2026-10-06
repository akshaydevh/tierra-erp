ALTER TABLE "orders" DROP CONSTRAINT "orders_source_check";--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_source_check" CHECK ("orders"."source" in ('seed', 'whatsapp', 'desk'));
