-- Item master with a material role, a normalised unit and parsed pack size.
--
-- material_role (sap-ops.md §2): item groups are unreliable (laminates sit in several groups), so the
-- item name decides first, then the code, then the group.
--   laminate   name 'Laminate%', or a *PMLM* code (customer wrappers named after the product)
--   carton     name 'Carton%'
--   seasoning  name 'Flav%', or the Flavour groups 132/159 (colourants)
--   oil        name 'Oil%'
--   tape       name 'Tape%'
--   raw_banana groups 144/161, raw_cassava group 145
--   fg         FG* code or U_ItmCtg = 'FG'
--   overhead   TRCS* outside group 129, TRLBR (power kWh, water KL, other consumables, labour) issued to production
--   consumable group 129 / name 'Consumable%' (LPG, printer ribbon, diesel)
--   other      everything else (spares, fixed assets, bulk bags ...)
CREATE VIEW erp.items_base AS
SELECT i.itemcode AS item_code,
       i.itemname AS item_name,
       i.itmsgrpcod AS group_code,
       g.itmsgrpnam AS group_name,
       i.u_itmctg AS category,
       CASE
         WHEN i.itemname ILIKE 'laminate%' OR i.itemcode ~ '^[A-Z0-9]*PMLM' THEN 'laminate'
         WHEN i.itemname ILIKE 'carton%' THEN 'carton'
         WHEN i.itemname ILIKE 'flav%' OR i.itmsgrpcod IN (132, 159) THEN 'seasoning'
         WHEN i.itemname ILIKE 'oil%' THEN 'oil'
         WHEN i.itemname ILIKE 'tape%' THEN 'tape'
         WHEN i.itmsgrpcod IN (144, 161) THEN 'raw_banana'
         WHEN i.itmsgrpcod = 145 THEN 'raw_cassava'
         WHEN i.itemcode LIKE 'FG%' OR i.u_itmctg = 'FG' THEN 'fg'
         WHEN (i.itemcode LIKE 'TRCS%' AND i.itmsgrpcod <> 129) OR i.itemcode = 'TRLBR' THEN 'overhead'
         WHEN i.itmsgrpcod = 129 OR i.itemname ILIKE 'consumable%' THEN 'consumable'
         ELSE 'other'
       END AS material_role,
       i.invntryuom AS uom_raw,
       erp.norm_uom(i.invntryuom) AS uom_norm,
       nullif(i.u_npu, 0) AS pcs_per_carton,
       CASE WHEN i.u_taxrate ~ '^\d+(\.\d+)?$' THEN i.u_taxrate::numeric END AS gst_rate,
       i.manbtchnum = 'Y' AS batch_managed,
       i.treetype = 'P' AS has_bom,
       i.frozenfor <> 'Y' AS active,
       i.evalsystem AS valuation_method,
       i.dfltwh AS default_whs,
       -- the HSN code SAP prints on invoices (OITM.ChapterID -> OCHP.Chapter), e.g. 20081940
       nullif(trim(h.chapter), '') AS hsn
FROM sap.oitm i
LEFT JOIN sap.oitb g ON g.itmsgrpcod = i.itmsgrpcod
LEFT JOIN sap.ochp h ON h.absentry = i.chapterid;

-- A laminate without a unit is inferred from how BOMs use it: laminate per finished piece is a few grams when it is
-- stocked in kg (well under 0.1 per pc) and ~1 when counted per piece.
-- Materialized (rebuilt on every import): most list views join it, and the regex/BOM work should not repeat per row.
CREATE MATERIALIZED VIEW erp.items AS
WITH bom_use AS (
  SELECT t.code AS item_code, max(t.quantity / nullif(h.qauntity, 0)) AS max_per_unit
  FROM sap.itt1 t JOIN sap.oitt h ON h.code = t.father
  GROUP BY t.code
)
SELECT b.item_code, b.item_name, b.group_code, b.group_name, b.category, b.material_role,
       b.uom_raw,
       coalesce(b.uom_norm,
                CASE WHEN b.material_role = 'laminate' AND u.max_per_unit < 0.1 THEN 'kg'
                     WHEN b.material_role = 'laminate' AND u.max_per_unit >= 0.5 THEN 'pcs' END) AS uom,
       b.uom_norm IS NULL AND b.material_role = 'laminate' AND u.max_per_unit IS NOT NULL
         AND (u.max_per_unit < 0.1 OR u.max_per_unit >= 0.5) AS uom_inferred,
       b.pcs_per_carton,
       -- pack size from the name ("... 100g", "... 1 kg"); finished goods only
       CASE WHEN b.material_role = 'fg' THEN
         (SELECT CASE WHEN lower(m[2]) LIKE 'k%' THEN m[1]::numeric * 1000 ELSE m[1]::numeric END
          FROM regexp_matches(b.item_name, '(\d+(?:\.\d+)?)\s*(kg|kgs|g|gm|gms|gram|grams|grm)\M', 'gi') AS m
          LIMIT 1)
       END AS pack_grams,
       b.gst_rate, b.batch_managed, b.has_bom, b.active, b.valuation_method, b.default_whs, b.hsn
FROM erp.items_base b
LEFT JOIN bom_use u ON u.item_code = b.item_code;

CREATE UNIQUE INDEX items_item_code_idx ON erp.items (item_code);
CREATE INDEX items_material_role_idx ON erp.items (material_role);
