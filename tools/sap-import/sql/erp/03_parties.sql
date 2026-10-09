-- Business partners. PAN = characters 3-12 of the bill-to GSTIN (the default bill-to address first), else of any
-- GSTIN on the card; the placeholder PAN 0000000000 is ignored. Branch cards of one company share a PAN.
-- balance = OCRD.Balance as SAP shows it (a card under payment consolidation shows 0; its parent carries it).
-- Materialized: the twin lookup in 04_stock joins it on PAN.
CREATE MATERIALIZED VIEW erp.party_gstins AS
SELECT DISTINCT ON (a.cardcode)
       a.cardcode AS card_code,
       upper(btrim(a.gstregnno)) AS gstin,
       substr(upper(btrim(a.gstregnno)), 3, 10) AS pan
FROM sap.crd1 a
JOIN sap.ocrd c ON c.cardcode = a.cardcode
WHERE upper(btrim(a.gstregnno)) ~ '^[0-9]{2}[A-Z0-9]{10}[A-Z0-9]{3}$'
  AND substr(btrim(a.gstregnno), 3, 10) <> '0000000000'
ORDER BY a.cardcode,
         (a.adrestype = 'B') DESC,
         (a.address = CASE WHEN a.adrestype = 'B' THEN c.billtodef ELSE c.shiptodef END) DESC,
         a.linenum;

CREATE UNIQUE INDEX party_gstins_card_code_idx ON erp.party_gstins (card_code);
CREATE INDEX party_gstins_pan_idx ON erp.party_gstins (pan);

CREATE VIEW erp.parties AS
SELECT c.cardcode AS card_code,
       c.cardname AS card_name,
       CASE c.cardtype WHEN 'C' THEN 'customer' WHEN 'S' THEN 'supplier' ELSE 'lead' END AS card_type,
       g.groupname AS group_name,
       x.pan,
       x.gstin,
       c.city,
       c.state1 AS state,
       nullif(btrim(c.phone1), '') AS phone,
       nullif(btrim(c.cellular), '') AS mobile,
       nullif(btrim(c.e_mail), '') AS email,
       c.balance,
       c.frozenfor <> 'Y' AS active,
       c.groupcode AS group_code,
       c.createdate AS created_on
FROM sap.ocrd c
LEFT JOIN sap.ocrg g ON g.groupcode = c.groupcode
LEFT JOIN erp.party_gstins x ON x.card_code = c.cardcode;

-- Every address of a card (CRD1): bill-to (B) and ship-to (S) rows with the GSTIN registered on that address. A
-- customer PO names its delivery address and ship-to GSTIN; several branch cards can share one GSTIN, so P3 matches
-- the PO's address against the ship-to rows of those cards.
CREATE VIEW erp.party_addresses AS
SELECT a.cardcode AS card_code,
       c.cardname AS card_name,
       CASE c.cardtype WHEN 'C' THEN 'customer' WHEN 'S' THEN 'supplier' ELSE 'lead' END AS card_type,
       CASE a.adrestype WHEN 'B' THEN 'bill_to' ELSE 'ship_to' END AS address_type,
       a.address AS address_name,
       nullif(concat_ws(', ', nullif(btrim(a.building), ''), nullif(btrim(a.street), ''), nullif(btrim(a.block), ''),
                        nullif(btrim(a.address2), ''), nullif(btrim(a.address3), '')), '') AS street,
       nullif(btrim(a.city), '') AS city,
       nullif(btrim(a.zipcode), '') AS zip_code,
       a.state,
       upper(nullif(btrim(a.gstregnno), '')) AS gstin,
       coalesce(a.address = CASE WHEN a.adrestype = 'B' THEN c.billtodef ELSE c.shiptodef END, false) AS is_default,
       c.frozenfor <> 'Y' AS active
FROM sap.crd1 a
JOIN sap.ocrd c ON c.cardcode = a.cardcode;
