-- Every business document in one place, for lookups by number ("send me SO/yy-yy/123").
-- sap_object is SAP's object type: 17 SO, 13 invoice, 14 credit note, 22 PO, 20 GRN, 18 A/P invoice,
-- 19 A/P credit note, 202 production order.
-- is_cancellation marks SAP's cancellation mirrors (CANCELED = 'C'). A mirror can carry the same number as the
-- document it cancels, so (doc_type, doc_no) is unique only over the rows that are not mirrors.
CREATE VIEW erp.documents AS
SELECT '17' AS sap_object, doc_entry, doc_no, 'sales_order' AS doc_type, doc_date, card_code, card_name, total,
       status = 'cancelled' AS cancelled, false AS is_cancellation
FROM erp.sales_orders
UNION ALL
SELECT '13', doc_entry, doc_no, 'invoice', doc_date, card_code, card_name, total, cancelled OR is_cancellation,
       is_cancellation
FROM erp.invoices
UNION ALL
SELECT '14', doc_entry, doc_no, 'credit_note', doc_date, card_code, card_name, total, cancelled, is_cancellation
FROM erp.credit_notes
UNION ALL
SELECT '22', doc_entry, doc_no, 'purchase_order', doc_date, card_code, card_name, total, status = 'cancelled', false
FROM erp.purchase_orders
UNION ALL
SELECT '20', doc_entry, doc_no, 'grn', doc_date, card_code, card_name, total, cancelled, is_cancellation
FROM erp.grns
UNION ALL
SELECT '18', doc_entry, doc_no, 'ap_invoice', doc_date, card_code, card_name, total, cancelled, is_cancellation
FROM erp.ap_invoices
UNION ALL
SELECT '19', doc_entry, doc_no, 'ap_credit_note', doc_date, card_code, card_name, total, cancelled, is_cancellation
FROM erp.ap_credit_notes
UNION ALL
SELECT '202', doc_entry, doc_no, 'production_order', post_date, card_code, customer_name, received_value,
       status = 'cancelled', false
FROM erp.production_orders;
