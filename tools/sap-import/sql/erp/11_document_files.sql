-- Files on record per SAP document (att.links -> att.files), with the document's header from erp.documents when it
-- is one (payments, journal entries and business partners are not in erp.documents: their number, date and card
-- come from the link). Empty until `run.py attachments` has run (sql/att.sql creates the tables).
-- role: invoice_pdf | ewaybill | einvoice_qr | credit_note_pdf | debit_note_pdf | ap_invoice_pdf | po_pdf | so_pdf
--       | receipt_pdf | supporting.
CREATE VIEW erp.document_files AS
SELECT l.sap_object,
       l.doc_entry,
       coalesce(d.doc_no, l.doc_no) AS doc_no,
       d.doc_type,
       coalesce(d.doc_date, l.doc_date) AS doc_date,
       coalesce(d.card_code, l.card_code) AS card_code,
       coalesce(d.card_name, p.card_name) AS card_name,
       d.total,
       coalesce(d.cancelled, false) AS cancelled,
       coalesce(d.is_cancellation, false) AS is_cancellation,
       l.role,
       l.link_method,
       l.confidence,
       f.sha256::text AS sha256,
       f.storage_key,
       f.file_name,
       f.mime,
       f.size_bytes,
       f.kind,
       f.file_time
FROM att.links l
JOIN att.files f ON f.sha256 = l.sha256
LEFT JOIN erp.documents d ON d.sap_object = l.sap_object AND d.doc_entry = l.doc_entry
LEFT JOIN erp.parties p ON p.card_code = l.card_code;
