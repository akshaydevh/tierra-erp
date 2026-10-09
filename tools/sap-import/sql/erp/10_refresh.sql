-- The materialized views are filled when this directory is applied. Anything that changes sap rows afterwards
-- (e.g. a test fixture loaded after the views) calls SELECT erp.refresh().
CREATE FUNCTION erp.refresh() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  REFRESH MATERIALIZED VIEW erp.party_gstins;
  REFRESH MATERIALIZED VIEW erp.items;
  REFRESH MATERIALIZED VIEW erp.item_ownership;
  -- reads party_gstins and documents, so last
  REFRESH MATERIALIZED VIEW erp.ar_ap_ageing;
  -- costing (13_costing.sql) reads items, party_gstins and item_ownership
  REFRESH MATERIALIZED VIEW erp.production_costs;
  REFRESH MATERIALIZED VIEW erp.fg_cost_monthly;
  REFRESH MATERIALIZED VIEW erp.sku_margin_monthly;
  REFRESH MATERIALIZED VIEW erp.material_mix_monthly;
  REFRESH MATERIALIZED VIEW erp.stock_valuation;
END
$$;
