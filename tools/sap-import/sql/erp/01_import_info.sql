CREATE VIEW erp.import_info AS
SELECT max(value) FILTER (WHERE key = 'backup')                    AS backup,
       max(value) FILTER (WHERE key = 'imported_at')::timestamptz  AS imported_at,
       max(value) FILTER (WHERE key = 'data_as_of')::date          AS data_as_of
FROM sap._import;
