-- Small helpers shared by the erp views. Everything in erp reads schema sap only.

-- SAP keeps a date plus a separate time of day: CreateTS as HHMMSS (093015), DocTime / CreateTime as HHMM (0930).
-- Times are Indian local time.
CREATE FUNCTION erp.sap_ts(d date, hhmmss integer) RETURNS timestamptz
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN (d + make_time(coalesce(hhmmss, 0) / 10000, coalesce(hhmmss, 0) / 100 % 100, coalesce(hhmmss, 0) % 100))
       AT TIME ZONE 'Asia/Kolkata';

CREATE FUNCTION erp.sap_ts_hhmm(d date, hhmm integer) RETURNS timestamptz
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN erp.sap_ts(d, coalesce(hhmm, 0) * 100);

-- A number kept in a SAP text field (the e-invoice add-on's U_BaseType / U_BaseEntry), or NULL when it is not
-- one; a stray value must never make a view fail to read.
CREATE FUNCTION erp.int_or_null(raw text) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN CASE WHEN raw ~ '^\d{1,9}$' THEN raw::integer END;

-- Free-text unit of measure -> one spelling (Kg/KG/kg -> kg, Nos/no -> nos, Pcs/PCS -> pcs ...).
CREATE FUNCTION erp.norm_uom(raw text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN CASE lower(btrim(raw, ' .'))
         WHEN '' THEN NULL
         WHEN 'kgs' THEN 'kg' WHEN 'kilogram' THEN 'kg'
         WHEN 'no' THEN 'nos' WHEN 'nos' THEN 'nos' WHEN 'number' THEN 'nos'
         WHEN 'pc' THEN 'pcs' WHEN 'pcs' THEN 'pcs'
         WHEN 'l' THEN 'ltr' WHEN 'litre' THEN 'ltr' WHEN 'ltrs' THEN 'ltr'
         ELSE lower(btrim(raw, ' .'))
       END;

-- Display number: numbering-series name + DocNum, e.g. SO/yy-yy/123 (DocNum restarts every financial year).
CREATE FUNCTION erp.doc_no(series_name text, doc_num integer) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN CASE WHEN series_name IS NULL THEN doc_num::text ELSE series_name || '/' || doc_num END;
