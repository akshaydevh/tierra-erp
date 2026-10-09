-- Schema `att`: SAP attachment files and the documents they belong to, written by `run.py attachments`.
-- It is its own schema so the `sap` swap never touches it; `run.py attachments` replaces the rows (not the tables)
-- in one transaction, so erp.document_files keeps compiling. Every statement is idempotent: the erp step runs this
-- file first, so the views compile before the first attachments import.

CREATE SCHEMA IF NOT EXISTS att;

-- One row per distinct file (content-addressed). The bytes live in the file store under storage_key.
CREATE TABLE IF NOT EXISTS att.files (
  sha256       char(64) PRIMARY KEY,
  storage_key  text NOT NULL,            -- sap/ab/cd/<sha256>.<ext>
  file_name    text NOT NULL,            -- the name SAP gave it
  mime         text NOT NULL,
  size_bytes   bigint NOT NULL,
  kind         text NOT NULL,            -- ewaybill | einvoice_qr | sap_print | attachment
  text_excerpt varchar(2048),            -- pdftotext, first 2 KB, whitespace collapsed
  source       text NOT NULL,            -- sap_atc1 | sap_ccs | sap_print (the strongest link)
  file_time    timestamptz               -- print time from the file name (..._YYYYMMDD_HHMMSS), else the file's mtime
);

-- One row per (file, document, role). doc_entry is NULL for business-partner files (OCRD has no DocEntry).
CREATE TABLE IF NOT EXISTS att.links (
  sha256      char(64) NOT NULL REFERENCES att.files (sha256) ON DELETE CASCADE,
  sap_object  text NOT NULL,             -- SAP object type: 13 invoice, 14 credit note, 18 A/P invoice, 20 GRN ...
  doc_entry   integer,
  doc_no      text,                      -- printed number, e.g. TF/26-27/101 (a card code for OCRD)
  card_code   text,
  doc_date    date,
  role        text NOT NULL,             -- invoice_pdf | ewaybill | einvoice_qr | credit_note_pdf | po_pdf | supporting ...
  link_method text NOT NULL,             -- atc1 | ccs_eoinv | ccs_eoewb | content_doc_no | filename_docnum
  confidence  text NOT NULL              -- exact | content
);
CREATE UNIQUE INDEX IF NOT EXISTS links_key ON att.links (sha256, sap_object, coalesce(doc_entry, -1), coalesce(doc_no, ''), role);
CREATE INDEX IF NOT EXISTS links_doc ON att.links (sap_object, doc_entry);
CREATE INDEX IF NOT EXISTS links_doc_no ON att.links (doc_no);

CREATE TABLE IF NOT EXISTS att._import (key text PRIMARY KEY, value text NOT NULL);
