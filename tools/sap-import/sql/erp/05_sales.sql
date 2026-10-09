-- Sales orders, invoices and credit notes.
-- Cancellations come in pairs: the original gets CANCELED = 'Y' and SAP adds a mirror document with CANCELED = 'C'
-- in its own series (TFC-yy / CAN-yy). Sales-order status: cancelled when CANCELED <> 'N', else DocStatus O/C.

CREATE VIEW erp.sales_orders AS
WITH lines AS (
  SELECT docentry, count(*) AS line_count, sum(quantity) AS total_qty
  FROM sap.rdr1 GROUP BY docentry
), inv AS (
  SELECT l.baseentry AS so_entry, count(DISTINCT l.docentry) AS invoice_count
  FROM sap.inv1 l JOIN sap.oinv h ON h.docentry = l.docentry AND h.canceled = 'N'
  WHERE l.basetype = 17
  GROUP BY l.baseentry
)
SELECT o.docentry AS doc_entry,
       erp.doc_no(n.seriesname, o.docnum) AS doc_no,
       o.docnum AS doc_num,
       n.seriesname AS series_name,
       o.docdate AS doc_date,
       o.docduedate AS due_date,
       -- TaxDate ("document date") carries the customer's PO date; DocDate is when the SO was keyed
       o.taxdate AS po_date,
       erp.sap_ts(o.createdate, o.createts) AS created_at,
       o.cardcode AS card_code,
       o.cardname AS card_name,
       nullif(btrim(o.numatcard), '') AS customer_po_no,
       -- who placed the PO: the PAN, so branch cards of one company count as one customer; else the card
       coalesce(g.pan, o.cardcode) AS party_key,
       o.shiptocode AS ship_to_code,
       o.doctotal AS total,
       o.vatsum AS tax_total,
       CASE WHEN o.canceled <> 'N' THEN 'cancelled' WHEN o.docstatus = 'O' THEN 'open' ELSE 'closed' END AS status,
       -- WddStatus: P/A/Y posted from an approved draft, W waiting, N rejected, '-' no approval needed
       CASE o.wddstatus WHEN 'P' THEN 'approved' WHEN 'A' THEN 'approved' WHEN 'Y' THEN 'approved'
                        WHEN 'W' THEN 'pending' WHEN 'N' THEN 'rejected' WHEN 'C' THEN 'cancelled'
                        ELSE 'not_required' END AS approval_status,
       o.canceled = 'N' AND o.docstatus = 'O'
         AND o.docdate < (SELECT data_as_of FROM erp.import_info) - 90 AS stale,
       coalesce(l.line_count, 0) AS line_count,
       coalesce(l.total_qty, 0) AS total_qty,
       coalesce(i.invoice_count, 0) AS invoice_count,
       u.u_name AS created_by,
       o.comments
FROM sap.ordr o
LEFT JOIN sap.nnm1 n ON n.series = o.series
LEFT JOIN erp.party_gstins g ON g.card_code = o.cardcode
LEFT JOIN lines l ON l.docentry = o.docentry
LEFT JOIN inv i ON i.so_entry = o.docentry
LEFT JOIN sap.ousr u ON u.userid = o.usersign;

CREATE VIEW erp.sales_order_lines AS
SELECT l.docentry AS doc_entry,
       l.linenum AS line_num,
       l.itemcode AS item_code,
       l.dscription AS item_name,
       l.quantity AS qty,
       l.openqty AS open_qty,
       l.price,
       l.linetotal AS line_total,
       l.taxcode AS tax_code,
       l.vatprcnt AS tax_pct,
       l.whscode AS whs_code,
       CASE l.linestatus WHEN 'O' THEN 'open' ELSE 'closed' END AS line_status,
       CASE WHEN l.targettype = 13 THEN l.trgetentry END AS invoice_doc_entry,
       l.unitmsr AS uom,
       l.shipdate AS ship_date,
       l.visorder AS sort_order
FROM sap.rdr1 l;

-- e-invoice (IRN) per A/R invoice: SAP keeps every attempt. Prefer the newest successful, not-cancelled row,
-- then the newest successful one, then the newest attempt. irn_status: generated | cancelled | failed.
CREATE VIEW erp.einvoice_latest AS
SELECT DISTINCT ON (u_basetype, u_baseentry)
       erp.int_or_null(u_basetype) AS base_type, erp.int_or_null(u_baseentry) AS base_entry,
       u_irn AS irn,
       CASE WHEN u_status = 'S' AND u_candt IS NULL THEN 'generated'
            WHEN u_status = 'S' THEN 'cancelled'
            ELSE 'failed' END AS irn_status,
       u_ackno AS ack_no,
       -- U_AckDt has no time of day; the e-invoice row's creation time is when the IRN came back
       CASE WHEN u_ackdt IS NOT NULL THEN erp.sap_ts_hhmm(createdate, createtime) END AS ack_at,
       u_ackdt AS ack_date,
       u_candt AS cancelled_on,
       u_qrpath AS qr_file
FROM sap.ccs_eoinv
WHERE erp.int_or_null(u_basetype) IS NOT NULL AND erp.int_or_null(u_baseentry) IS NOT NULL
ORDER BY u_basetype, u_baseentry, (u_status = 'S' AND u_candt IS NULL) DESC, (u_status = 'S') DESC, docentry DESC;

-- e-way bill per invoice: newest not-cancelled row, else newest. ewb_at = when the EWB row was created
-- (U_EwbDT carries the date only).
CREATE VIEW erp.ewaybill_latest AS
SELECT DISTINCT ON (u_baseentry)
       erp.int_or_null(u_baseentry) AS base_entry,
       u_ewbno AS ewb_no,
       erp.sap_ts_hhmm(createdate, createtime) AS ewb_at,
       u_ewbdt AS ewb_date,
       u_ewbvalidtill AS valid_till,
       u_candt IS NOT NULL AS ewb_cancelled
FROM sap.ccs_eoewb
WHERE erp.int_or_null(u_basetype) = 13 AND erp.int_or_null(u_baseentry) IS NOT NULL
ORDER BY u_baseentry, (u_candt IS NULL) DESC, docentry DESC;

CREATE VIEW erp.invoices AS
WITH so AS (
  SELECT docentry, array_agg(DISTINCT baseentry ORDER BY baseentry) AS so_doc_entries
  FROM sap.inv1 WHERE basetype = 17 GROUP BY docentry
)
SELECT h.docentry AS doc_entry,
       erp.doc_no(n.seriesname, h.docnum) AS doc_no,
       h.docnum AS doc_num,
       h.docdate AS doc_date,
       erp.sap_ts(h.createdate, h.createts) AS created_at,
       h.cardcode AS card_code,
       h.cardname AS card_name,
       nullif(btrim(h.numatcard), '') AS customer_po_no,
       h.doctotal AS total,
       h.vatsum AS tax_total,
       h.canceled = 'Y' AS cancelled,
       h.canceled = 'C' AS is_cancellation,
       coalesce(so.so_doc_entries, '{}') AS so_doc_entries,
       e.ewb_no,
       e.ewb_at,
       coalesce(e.ewb_cancelled, false) AS ewb_cancelled,
       x.irn,
       x.irn_status,
       x.ack_no,
       x.ack_at,
       n.seriesname AS series_name,
       e.valid_till AS ewb_valid_till,
       h.atcentry AS attachment_entry,
       h.comments
FROM sap.oinv h
LEFT JOIN sap.nnm1 n ON n.series = h.series
LEFT JOIN so ON so.docentry = h.docentry
LEFT JOIN erp.ewaybill_latest e ON e.base_entry = h.docentry
LEFT JOIN erp.einvoice_latest x ON x.base_type = 13 AND x.base_entry = h.docentry;

CREATE VIEW erp.invoice_lines AS
SELECT l.docentry AS doc_entry,
       l.linenum AS line_num,
       l.itemcode AS item_code,
       l.dscription AS item_name,
       l.quantity AS qty,
       l.price,
       l.linetotal AS line_total,
       CASE WHEN l.basetype = 17 THEN l.baseentry END AS base_so_doc_entry,
       CASE WHEN l.basetype = 17 THEN l.baseline END AS base_so_line,
       l.taxcode AS tax_code,
       l.vatprcnt AS tax_pct,
       l.unitmsr AS uom,
       l.stockprice AS unit_cost,
       l.whscode AS whs_code
FROM sap.inv1 l;

CREATE VIEW erp.credit_notes AS
WITH base AS (
  SELECT docentry, array_agg(DISTINCT baseentry ORDER BY baseentry) AS inv
  FROM sap.rin1 WHERE basetype = 13 GROUP BY docentry
)
SELECT h.docentry AS doc_entry,
       erp.doc_no(n.seriesname, h.docnum) AS doc_no,
       h.docdate AS doc_date,
       h.cardcode AS card_code,
       h.cardname AS card_name,
       h.doctotal AS total,
       h.canceled <> 'N' AS cancelled,
       coalesce(b.inv, '{}') AS base_invoice_doc_entries,
       h.canceled = 'C' AS is_cancellation,
       h.docnum AS doc_num,
       h.vatsum AS tax_total,
       nullif(btrim(h.numatcard), '') AS customer_ref,
       x.irn_status,
       h.comments
FROM sap.orin h
LEFT JOIN sap.nnm1 n ON n.series = h.series
LEFT JOIN base b ON b.docentry = h.docentry
LEFT JOIN erp.einvoice_latest x ON x.base_type = 14 AND x.base_entry = h.docentry;
