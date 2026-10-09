-- Purchase orders, goods receipts (GRPO) and A/P invoices. Purchasing is receipt-first: most GRN lines have no PO.

CREATE VIEW erp.purchase_orders AS
WITH lines AS (
  SELECT docentry, count(*) AS line_count,
         -- open value includes tax, like total: open line amount x (1 + line GST %)
         sum(CASE WHEN linestatus = 'O' THEN opensum * (1 + coalesce(vatprcnt, 0) / 100) ELSE 0 END) AS open_value
  FROM sap.por1 GROUP BY docentry
)
SELECT h.docentry AS doc_entry,
       erp.doc_no(n.seriesname, h.docnum) AS doc_no,
       h.docdate AS doc_date,
       h.docduedate AS due_date,
       h.cardcode AS card_code,
       h.cardname AS card_name,
       nullif(btrim(h.numatcard), '') AS vendor_ref,
       h.doctotal AS total,
       CASE WHEN h.canceled <> 'N' THEN 'cancelled' WHEN h.docstatus = 'O' THEN 'open' ELSE 'closed' END AS status,
       coalesce(l.line_count, 0) AS line_count,
       CASE WHEN h.canceled = 'N' AND h.docstatus = 'O' THEN round(coalesce(l.open_value, 0), 2) ELSE 0 END AS open_value,
       h.docnum AS doc_num,
       h.vatsum AS tax_total,
       erp.sap_ts(h.createdate, h.createts) AS created_at,
       u.u_name AS created_by,
       h.comments
FROM sap.opor h
LEFT JOIN sap.nnm1 n ON n.series = h.series
LEFT JOIN lines l ON l.docentry = h.docentry
LEFT JOIN sap.ousr u ON u.userid = h.usersign;

CREATE VIEW erp.purchase_order_lines AS
SELECT l.docentry AS doc_entry,
       l.linenum AS line_num,
       l.itemcode AS item_code,
       l.dscription AS item_name,
       l.quantity AS qty,
       l.openqty AS open_qty,
       coalesce(erp.norm_uom(l.unitmsr), i.uom) AS uom,
       l.price,
       l.linetotal AS line_total,
       CASE l.linestatus WHEN 'O' THEN 'open' ELSE 'closed' END AS line_status,
       l.vatprcnt AS tax_pct,
       l.shipdate AS due_date,
       i.material_role
FROM sap.por1 l
LEFT JOIN erp.items i ON i.item_code = l.itemcode;

-- Batch numbers received on each GRN line (batch log OITL/ITL1 -> OBTN).
CREATE VIEW erp.grn_line_batches AS
SELECT o.docentry AS doc_entry, o.docline AS line_num,
       string_agg(DISTINCT b.distnumber, ', ' ORDER BY b.distnumber) AS batch_no
FROM sap.oitl o
JOIN sap.itl1 t ON t.logentry = o.logentry
JOIN sap.obtn b ON b.absentry = t.mdabsentry
WHERE o.doctype = 20
GROUP BY o.docentry, o.docline;

CREATE VIEW erp.grn_lines AS
SELECT l.docentry AS doc_entry,
       l.linenum AS line_num,
       l.itemcode AS item_code,
       l.dscription AS item_name,
       i.material_role,
       l.quantity AS qty,
       coalesce(erp.norm_uom(l.unitmsr), i.uom) AS uom,
       l.price,
       l.linetotal AS line_total,
       -- free issue: material the customer supplies, received from its twin vendor card at price 0
       l.price = 0 AS free_issue,
       CASE WHEN l.basetype = 22 THEN l.baseentry END AS base_po_doc_entry,
       b.batch_no,
       CASE WHEN l.basetype = 22 THEN l.baseline END AS base_po_line,
       l.whscode AS whs_code
FROM sap.pdn1 l
LEFT JOIN erp.items i ON i.item_code = l.itemcode
LEFT JOIN erp.grn_line_batches b ON b.doc_entry = l.docentry AND b.line_num = l.linenum;

-- free_issue on the header: every line priced 0. line_summary: "<item> <qty> <unit>" or "<first line> +N more".
CREATE VIEW erp.grns AS
WITH lines AS (
  SELECT l.docentry, count(*) AS line_count,
         bool_and(l.price = 0) AS free_issue,
         count(*) FILTER (WHERE l.price = 0) AS free_issue_lines,
         (array_agg(coalesce(l.itemcode, l.dscription) || ' ' || trim(trailing '.' from to_char(l.quantity, 'FM999,999,990.999'))
                    || coalesce(' ' || erp.norm_uom(l.unitmsr), '') ORDER BY l.linenum))[1] AS first_line
  FROM sap.pdn1 l GROUP BY l.docentry
)
SELECT h.docentry AS doc_entry,
       erp.doc_no(n.seriesname, h.docnum) AS doc_no,
       h.docdate AS doc_date,
       erp.sap_ts(h.createdate, h.createts) AS created_at,
       h.cardcode AS card_code,
       h.cardname AS card_name,
       nullif(btrim(h.numatcard), '') AS vendor_ref,
       h.doctotal AS total,
       h.canceled <> 'N' AS cancelled,
       coalesce(l.free_issue, false) AS free_issue,
       h.canceled = 'C' AS is_cancellation,
       h.docnum AS doc_num,
       coalesce(l.line_count, 0) AS line_count,
       coalesce(l.free_issue_lines, 0) AS free_issue_lines,
       l.first_line || CASE WHEN l.line_count > 1 THEN ' +' || (l.line_count - 1) || ' more' ELSE '' END AS line_summary,
       h.comments
FROM sap.opdn h
LEFT JOIN sap.nnm1 n ON n.series = h.series
LEFT JOIN lines l ON l.docentry = h.docentry;

CREATE VIEW erp.ap_invoices AS
SELECT h.docentry AS doc_entry,
       erp.doc_no(n.seriesname, h.docnum) AS doc_no,
       h.docdate AS doc_date,
       h.cardcode AS card_code,
       h.cardname AS card_name,
       nullif(btrim(h.numatcard), '') AS vendor_ref,
       h.doctotal AS total,
       h.canceled <> 'N' AS cancelled,
       h.canceled = 'C' AS is_cancellation,
       h.docnum AS doc_num,
       h.vatsum AS tax_total,
       h.docduedate AS due_date,
       h.comments
FROM sap.opch h
LEFT JOIN sap.nnm1 n ON n.series = h.series;

-- A/P credit memos (vendor returns / price corrections), series AP/yy-yy and PC/yy-yy.
CREATE VIEW erp.ap_credit_notes AS
SELECT h.docentry AS doc_entry,
       erp.doc_no(n.seriesname, h.docnum) AS doc_no,
       h.docdate AS doc_date,
       h.cardcode AS card_code,
       h.cardname AS card_name,
       nullif(btrim(h.numatcard), '') AS vendor_ref,
       h.doctotal AS total,
       h.canceled <> 'N' AS cancelled,
       h.canceled = 'C' AS is_cancellation,
       h.docnum AS doc_num,
       h.comments
FROM sap.orpc h
LEFT JOIN sap.nnm1 n ON n.series = h.series;
