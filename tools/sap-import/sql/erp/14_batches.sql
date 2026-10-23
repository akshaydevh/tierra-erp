-- Batches (OBTN) and every stock movement of each (batch log OITL/ITL1), for the find_batch tool: a packet's
-- batch code -> the item, its production order, where it sits and which customers it was invoiced to.
-- With ERP_BACKEND=erpnext these two views are replaced by views over ERPNext's "SAP Batch" records
-- (backend/src/erp/erpnext/compat.ts), which tools/erpnext-import fills from these views.

-- The documents a batch moves on: object code, entry, series and number (for the printed doc_no).
CREATE VIEW erp.batch_doc_heads AS
SELECT 13 AS doc_type, docentry, series, docnum FROM sap.oinv
UNION ALL SELECT 14, docentry, series, docnum FROM sap.orin
UNION ALL SELECT 18, docentry, series, docnum FROM sap.opch
UNION ALL SELECT 19, docentry, series, docnum FROM sap.orpc
UNION ALL SELECT 20, docentry, series, docnum FROM sap.opdn
UNION ALL SELECT 59, docentry, series, docnum FROM sap.oign
UNION ALL SELECT 60, docentry, series, docnum FROM sap.oige
UNION ALL SELECT 202, docentry, series, docnum FROM sap.owor;

-- One row per batch and stock movement. qty is signed: + into stock, - out of it. production_order is the
-- production order a receipt (the batch was made) or an issue (the batch went into it) is based on.
CREATE VIEW erp.batch_movements AS
SELECT b.absentry AS batch_id,
       b.distnumber AS batch_no,
       b.itemcode AS item_code,
       o.logentry AS log_entry,
       CASE o.doctype
         WHEN 13 THEN 'invoice'
         WHEN 14 THEN 'credit_note'
         WHEN 15 THEN 'delivery'
         WHEN 16 THEN 'return'
         WHEN 18 THEN 'ap_invoice'
         WHEN 19 THEN 'ap_credit_note'
         WHEN 20 THEN 'grn'
         WHEN 21 THEN 'goods_return'
         WHEN 59 THEN CASE WHEN o.basetype = 202 THEN 'production_receipt' ELSE 'goods_receipt' END
         WHEN 60 THEN CASE WHEN o.basetype = 202 THEN 'production_issue' ELSE 'goods_issue' END
         WHEN 67 THEN 'transfer'
         WHEN 10000071 THEN 'stock_count'
         WHEN 310000001 THEN 'opening_balance'
         ELSE 'other'
       END AS kind,
       coalesce(erp.doc_no(n.seriesname, h.docnum), o.docnum::text) AS doc_no,
       o.docdate AS doc_date,
       CASE WHEN o.doctype IN (13, 14, 15, 16, 18, 19, 20, 21) THEN o.cardcode END AS party_code,
       CASE WHEN o.doctype IN (13, 14, 15, 16, 18, 19, 20, 21) THEN o.cardname END AS party_name,
       o.loccode AS whs_code,
       i.quantity AS qty,
       CASE WHEN o.basetype = 202 THEN erp.doc_no(pn.seriesname, w.docnum) END AS production_order,
       CASE WHEN o.basetype = 202 THEN o.baseentry END AS production_entry
FROM sap.obtn b
JOIN sap.itl1 i ON i.mdabsentry = b.absentry
JOIN sap.oitl o ON o.logentry = i.logentry AND o.stockeff = 1
LEFT JOIN erp.batch_doc_heads h ON h.doc_type = o.doctype AND h.docentry = o.docentry
LEFT JOIN sap.nnm1 n ON n.series = h.series
LEFT JOIN sap.owor w ON o.basetype = 202 AND w.docentry = o.baseentry
LEFT JOIN sap.nnm1 pn ON pn.series = w.series;

-- One row per batch: received (in) and issued (out) totals over its movements, and stock by warehouse (OBTQ).
CREATE VIEW erp.batches AS
WITH moves AS (
  SELECT batch_id,
         sum(qty) FILTER (WHERE qty > 0) AS qty_in,
         -sum(qty) FILTER (WHERE qty < 0) AS qty_out
  FROM erp.batch_movements GROUP BY batch_id
), stock AS (
  SELECT mdabsentry AS batch_id,
         sum(quantity) AS on_hand,
         string_agg(whscode || ' ' || trim_scale(quantity)::text, ', ' ORDER BY whscode) AS warehouses
  FROM sap.obtq WHERE quantity <> 0 GROUP BY mdabsentry
)
SELECT b.absentry AS batch_id,
       b.distnumber AS batch_no,
       b.itemcode AS item_code,
       coalesce(it.itemname, b.itemname) AS item_name,
       b.indate AS in_date,
       b.mnfdate AS mnf_date,
       b.expdate AS exp_date,
       coalesce(m.qty_in, 0) AS qty_in,
       coalesce(m.qty_out, 0) AS qty_out,
       coalesce(s.on_hand, 0) AS on_hand,
       s.warehouses
FROM sap.obtn b
LEFT JOIN sap.oitm it ON it.itemcode = b.itemcode
LEFT JOIN moves m ON m.batch_id = b.absentry
LEFT JOIN stock s ON s.batch_id = b.absentry;
