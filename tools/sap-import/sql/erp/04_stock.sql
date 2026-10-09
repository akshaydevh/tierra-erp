-- Customer-supplied material (sap-ops.md §2). SAP does not model ownership; free-issue material arrives on a GRPO
-- from the customer's twin vendor card at price 0. Rule: an item is customer_supplied when its most recent
-- (non-cancelled) GRPO line is priced 0; the owner is the customer card that shares the vendor's PAN (bill-to
-- GSTIN). When several customer cards share the PAN, the one with the most production orders wins. No twin
-- (e.g. a printer that shipped free) -> owner null, supplied_by still set.
CREATE VIEW erp.item_last_receipt AS
SELECT DISTINCT ON (l.itemcode)
       l.itemcode AS item_code, h.docentry AS grn_doc_entry, h.docdate AS grn_date,
       h.cardcode AS vendor_card_code, l.price, l.price = 0 AS free_issue
FROM sap.pdn1 l
JOIN sap.opdn h ON h.docentry = l.docentry
WHERE h.canceled = 'N' AND l.itemcode IS NOT NULL
ORDER BY l.itemcode, h.docdate DESC, h.docentry DESC, l.linenum DESC;

CREATE VIEW erp.vendor_customer_twins AS
SELECT DISTINCT ON (v.card_code)
       v.card_code AS vendor_card_code, c.card_code AS customer_card_code, c.card_name AS customer_name
FROM erp.party_gstins v
JOIN sap.ocrd vc ON vc.cardcode = v.card_code AND vc.cardtype = 'S'
JOIN erp.party_gstins cg ON cg.pan = v.pan
JOIN erp.parties c ON c.card_code = cg.card_code AND c.card_type = 'customer'
LEFT JOIN (SELECT cardcode, count(*) n FROM sap.owor GROUP BY 1) w ON w.cardcode = c.card_code
ORDER BY v.card_code, coalesce(w.n, 0) DESC, c.card_code;

-- Ownership per item, materialized so stock pages do not redo the receipt and twin lookups per row.
CREATE MATERIALIZED VIEW erp.item_ownership AS
SELECT r.item_code,
       r.free_issue AS customer_supplied,
       CASE WHEN r.free_issue THEN r.vendor_card_code END AS supplied_by_card_code,
       t.customer_card_code AS owner_card_code,
       t.customer_name AS owner_name,
       r.grn_date AS last_receipt_date
FROM erp.item_last_receipt r
LEFT JOIN erp.vendor_customer_twins t ON t.vendor_card_code = r.vendor_card_code AND r.free_issue;

CREATE UNIQUE INDEX item_ownership_item_code_idx ON erp.item_ownership (item_code);

-- One row per item and warehouse with any quantity. value = OITW.StockValue, which equals the FIFO/batch layer
-- value (sum of IVL1.TransValue) on every row of this backup; OITW.AvgPrice is 0 for batch-valued items, so
-- avg_price is value / on_hand.
CREATE VIEW erp.stock AS
SELECT w.itemcode AS item_code,
       w.whscode AS whs_code,
       w.onhand AS on_hand,
       w.iscommited AS committed,
       w.onorder AS on_order,
       w.onhand - w.iscommited AS free,
       CASE WHEN w.onhand <> 0 THEN round(w.stockvalue / w.onhand, 6) ELSE w.avgprice END AS avg_price,
       w.stockvalue AS value,
       o.owner_card_code,
       o.owner_name,
       coalesce(o.customer_supplied, false) AS customer_supplied,
       o.supplied_by_card_code,
       o.last_receipt_date
FROM sap.oitw w
LEFT JOIN erp.item_ownership o ON o.item_code = w.itemcode
WHERE w.onhand <> 0 OR w.iscommited <> 0 OR w.onorder <> 0;
