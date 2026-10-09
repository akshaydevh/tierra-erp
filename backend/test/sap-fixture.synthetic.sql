-- Hand-written synthetic SAP rows for the backend's query and route tests. Every code, name and amount is
-- invented; only the shapes follow SAP B1. Loaded into an empty `sap` schema (test/sap-schema.sql) before the erp
-- views are refreshed (SELECT erp.refresh()). The data date is 2026-03-31, so "this month" is March 2026.

INSERT INTO sap._import (key, value) VALUES
  ('backup', 'synthetic_fixture'),
  ('imported_at', '2026-04-01T02:30:00Z'),
  ('data_as_of', '2026-03-31'),
  ('row_counts', '{}');

-- Masters ------------------------------------------------------------------------------------------------------

INSERT INTO sap.owhs (whscode, whsname, inactive, locked) VALUES
  ('FG01', 'Finished goods store', 'N', 'N'),
  ('RM01', 'Raw material store', 'N', 'N');

INSERT INTO sap.oitb (itmsgrpcod, itmsgrpnam) VALUES
  (100, 'Finished Goods'),
  (129, 'Consumables'),
  (144, 'Raw Banana'),
  (150, 'Laminate'),
  (159, 'Flavours');

-- ZPMLMA has no unit: the BOM uses 80 per 10,000 pieces, so it is inferred as kg.
-- HSN codes (OCHP): the finished goods print 99990001 on invoices.
INSERT INTO sap.ochp (absentry, chapter) VALUES (7, '99990001'), (8, '99990002');

INSERT INTO sap.oitm (itemcode, itemname, itmsgrpcod, invntryuom, u_itmctg, u_npu, u_taxrate, treetype, manbtchnum, frozenfor, chapterid) VALUES
  ('ZFGA100', 'Zeta Banana Chips 100g', 100, 'Pcs', 'FG', 50, '5', 'P', 'N', 'N', 7),
  ('ZFGB200', 'Zeta Cassava Chips 200g', 100, 'Pcs', 'FG', 30, '5', 'P', 'N', 'N', 7),
  ('ZPMLMA', 'Laminate-Zeta Banana 100g', 150, NULL, 'PM', NULL, '18', 'N', 'N', 'N', NULL),
  ('ZPMLMCS', 'Laminate-Customer Brand Small', 150, 'Kg', 'PM', NULL, '18', 'N', 'N', 'N', NULL),
  ('ZPMCN', 'Carton- Zeta 5 Ply', 150, 'Nos', 'PM', NULL, '18', 'N', 'N', 'N', NULL),
  ('ZRMBN', 'Raw Banana- Test Farm', 144, 'KG', 'RW', NULL, NULL, 'N', 'Y', 'N', NULL),
  ('ZFLV', 'Flavour Salt Test', 159, 'Kg', 'RW', NULL, '12', 'N', 'N', 'N', NULL);

-- ZFGA100 is short (more committed than on hand); ZPMLMCS is customer-supplied laminate.
INSERT INTO sap.oitw (itemcode, whscode, onhand, iscommited, onorder, avgprice, stockvalue) VALUES
  ('ZFGA100', 'FG01', 300, 500, 0, 100, 30000),
  ('ZFGB200', 'FG01', 120, 20, 0, 40, 4800),
  ('ZPMLMA', 'RM01', 50, 0, 0, 100, 5000),
  ('ZPMLMCS', 'RM01', 12.5, 0, 0, 0, 0),
  ('ZPMCN', 'RM01', 400, 0, 1000, 10, 4000),
  ('ZRMBN', 'RM01', 800, 0, 0, 40, 32000),
  ('ZFLV', 'RM01', 5, 0, 0, 200, 1000),
  ('ZFLV', 'FG01', 0, 0, 0, 0, 0);

INSERT INTO sap.ocrg (groupcode, groupname, grouptype) VALUES
  (100, 'Customers', 'C'),
  (101, 'Suppliers', 'S');

-- ZV001 is the vendor twin of customer ZC001 (same PAN), used for free-issue material.
INSERT INTO sap.ocrd (cardcode, cardname, cardtype, groupcode, city, state1, phone1, cellular, e_mail, balance, billtodef, shiptodef, frozenfor) VALUES
  ('ZC001', 'Alpha Snacks Pvt Ltd', 'C', 100, 'Kochi', 'KL', '0484000001', '9000000001', 'buyer@alpha.test', 125000, 'BILL', 'SHIP', 'N'),
  ('ZC002', 'Beta Retail LLP', 'C', 100, 'Bengaluru', 'KA', NULL, '9000000002', NULL, 0, 'BILL', 'SHIP', 'N'),
  ('ZV001', 'Alpha Snacks Pvt Ltd - Vendor', 'S', 101, 'Kochi', 'KL', NULL, NULL, NULL, 0, 'BILL', NULL, 'N'),
  ('ZV002', 'Gamma Packaging Co', 'S', 101, 'Chennai', 'TN', NULL, NULL, NULL, -36000, 'BILL', NULL, 'N');

INSERT INTO sap.crd1 (cardcode, address, adrestype, linenum, gstregnno) VALUES
  ('ZC001', 'BILL', 'B', 0, '32AAACZ1234A1Z5'),
  ('ZC001', 'SHIP', 'S', 1, '32AAACZ1234A1Z5'),
  ('ZC002', 'BILL', 'B', 0, '29AABCB5678B1Z2'),
  ('ZV001', 'BILL', 'B', 0, '32AAACZ1234A2Z4'),
  ('ZV002', 'BILL', 'B', 0, '33AACCG9012C1Z3');

INSERT INTO sap.nnm1 (series, objectcode, seriesname) VALUES
  (10, '17', 'SO/25-26'),
  (11, '13', 'TF/25-26'),
  (12, '13', 'TFC-25'),
  (13, '14', 'CN/25-26'),
  (14, '22', 'PO/25-26'),
  (15, '20', 'GR/25-26'),
  (16, '202', 'PR/25-26'),
  (17, '18', 'AP/25-26'),
  (18, '59', 'RC/25-26'),
  (19, '60', 'IS/25-26');

INSERT INTO sap.ousr (userid, user_code, u_name) VALUES
  (1, 'manager', 'TEST ADMIN'),
  (5, 'zoffice', 'ZED OFFICE');

-- Bills of materials: ZFGA100 per 10,000 pieces with a placeholder banana quantity of 1; ZFGB200 per 1,000.
INSERT INTO sap.oitt (code, treetype, qauntity) VALUES
  ('ZFGA100', 'P', 10000),
  ('ZFGB200', 'P', 1000);

INSERT INTO sap.itt1 (father, childnum, visorder, code, quantity, warehouse, issuemthd) VALUES
  ('ZFGA100', 0, 0, 'ZRMBN', 1, 'RM01', 'M'),
  ('ZFGA100', 1, 1, 'ZPMLMA', 80, 'RM01', 'B'),
  ('ZFGA100', 2, 2, 'ZPMCN', 200, 'RM01', 'B'),
  ('ZFGB200', 0, 0, 'ZRMBN', 450, 'RM01', 'M'),
  ('ZFGB200', 1, 1, 'ZFLV', 5, 'RM01', 'M');

-- Sales orders: 101 open, 102 closed (invoiced by 201), 103 cancelled, 104 open and stale (over 90 days old).
-- 104 is from another customer that happens to use the same PO number as 101/103.
INSERT INTO sap.ordr (docentry, docnum, series, canceled, docstatus, docdate, docduedate, taxdate, cardcode, cardname, numatcard, shiptocode, vatsum, doctotal, createdate, createts, usersign, wddstatus) VALUES
  (101, 1, 10, 'N', 'O', '2026-03-30', '2026-04-05', '2026-03-28', 'ZC001', 'Alpha Snacks Pvt Ltd', 'APO-7001', 'SHIP', 500, 10500, '2026-03-30', 101500, 5, 'P'),
  (102, 2, 10, 'N', 'C', '2026-03-20', '2026-03-25', '2026-03-19', 'ZC002', 'Beta Retail LLP', 'BPO-55', 'SHIP', 250, 5250, '2026-03-20', 93000, 5, '-'),
  (103, 3, 10, 'Y', 'C', '2026-03-10', '2026-03-15', '2026-03-09', 'ZC001', 'Alpha Snacks Pvt Ltd', 'APO-7001', 'SHIP', 100, 2100, '2026-03-10', 120000, 5, '-'),
  (104, 4, 10, 'N', 'O', '2025-11-15', '2025-11-30', '2025-11-14', 'ZC002', 'Beta Retail LLP', 'APO-7001', 'SHIP', 150, 3150, '2025-11-15', 110000, 1, '-');

INSERT INTO sap.rdr1 (docentry, linenum, visorder, itemcode, dscription, quantity, openqty, price, linetotal, vatprcnt, taxcode, whscode, linestatus, targettype, trgetentry, unitmsr) VALUES
  (101, 0, 0, 'ZFGA100', 'Zeta Banana Chips 100g', 400, 360, 25, 10000, 5, 'IGST@5', 'FG01', 'O', 13, 204, 'Pcs'),
  (102, 0, 0, 'ZFGB200', 'Zeta Cassava Chips 200g', 100, 0, 50, 5000, 5, 'IGST@5', 'FG01', 'C', 13, 201, 'Pcs'),
  (103, 0, 0, 'ZFGA100', 'Zeta Banana Chips 100g', 80, 0, 25, 2000, 5, 'IGST@5', 'FG01', 'C', -1, NULL, 'Pcs'),
  (104, 0, 0, 'ZFGA100', 'Zeta Banana Chips 100g', 100, 100, 30, 3000, 5, 'IGST@5', 'FG01', 'O', -1, NULL, 'Pcs');

-- Invoices: 201 with an e-way bill and an IRN (after one failed attempt); 202/203 a cancellation pair;
-- 204 whose IRN failed and whose only e-way bill was cancelled; 205 earlier in the month.
INSERT INTO sap.oinv (docentry, docnum, series, canceled, docstatus, docdate, cardcode, cardname, numatcard, vatsum, doctotal, createdate, createts) VALUES
  (201, 1, 11, 'N', 'C', '2026-03-31', 'ZC002', 'Beta Retail LLP', 'BPO-55', 250, 5250, '2026-03-31', 143005),
  (202, 2, 11, 'Y', 'C', '2026-03-31', 'ZC001', 'Alpha Snacks Pvt Ltd', 'APO-6999', 200, 4200, '2026-03-31', 150000),
  (203, 1, 12, 'C', 'C', '2026-03-31', 'ZC001', 'Alpha Snacks Pvt Ltd', 'APO-6999', 200, 4200, '2026-03-31', 151000),
  (204, 3, 11, 'N', 'O', '2026-03-31', 'ZC001', 'Alpha Snacks Pvt Ltd', 'APO-7001', 50, 1050, '2026-03-31', 160000),
  (205, 4, 11, 'N', 'C', '2026-03-05', 'ZC002', 'Beta Retail LLP', 'BPO-50', 95.24, 2000, '2026-03-05', 110000);

INSERT INTO sap.inv1 (docentry, linenum, visorder, basetype, baseentry, baseline, itemcode, dscription, quantity, price, linetotal, vatprcnt, taxcode, whscode) VALUES
  (201, 0, 0, 17, 102, 0, 'ZFGB200', 'Zeta Cassava Chips 200g', 100, 50, 5000, 5, 'IGST@5', 'FG01'),
  (202, 0, 0, -1, NULL, NULL, 'ZFGA100', 'Zeta Banana Chips 100g', 160, 25, 4000, 5, 'IGST@5', 'FG01'),
  (203, 0, 0, 13, 202, 0, 'ZFGA100', 'Zeta Banana Chips 100g', 160, 25, 4000, 5, 'IGST@5', 'FG01'),
  (204, 0, 0, 17, 101, 0, 'ZFGA100', 'Zeta Banana Chips 100g', 40, 25, 1000, 5, 'IGST@5', 'FG01'),
  (205, 0, 0, -1, NULL, NULL, 'ZFGB200', 'Zeta Cassava Chips 200g', 38.1, 50, 1904.76, 5, 'IGST@5', 'FG01');

INSERT INTO sap.ccs_eoinv (docentry, u_basetype, u_baseentry, u_status, u_irn, u_ackno, u_ackdt, u_candt, createdate, createtime) VALUES
  (1, '13', '201', 'F', NULL, NULL, NULL, NULL, '2026-03-31', 1430),
  (2, '13', '201', 'S', 'IRN-TEST-0201', 'ACK-0201', '2026-03-31', NULL, '2026-03-31', 1431),
  (3, '13', '204', 'F', NULL, NULL, NULL, NULL, '2026-03-31', 1601),
  -- stray add-on rows: a base type and a base entry that are not numbers must be skipped, not break the views
  (4, 'A/R', '201', 'S', 'IRN-TEST-BAD1', NULL, NULL, NULL, '2026-03-31', 1700),
  (5, '13', '99999999999', 'S', 'IRN-TEST-BAD2', NULL, NULL, NULL, '2026-03-31', 1701);

INSERT INTO sap.ccs_eoewb (docentry, u_basetype, u_baseentry, u_ewbno, u_ewbdt, u_ewbvalidtill, u_candt, createdate, createtime) VALUES
  (1, '13', '201', 'EWB-900201', '2026-03-31', '2026-04-02', NULL, '2026-03-31', 1432),
  (2, '13', '204', 'EWB-900204', '2026-03-31', '2026-04-02', '2026-03-31', '2026-03-31', 1610),
  (3, '13', '2O1', 'EWB-900299', '2026-03-31', '2026-04-02', NULL, '2026-03-31', 1702),
  (4, '13', '99999999999', 'EWB-900298', '2026-03-31', '2026-04-02', NULL, '2026-03-31', 1703);

INSERT INTO sap.orin (docentry, docnum, series, canceled, docstatus, docdate, cardcode, cardname, doctotal, vatsum) VALUES
  (301, 1, 13, 'N', 'C', '2026-03-25', 'ZC002', 'Beta Retail LLP', 525, 25);

INSERT INTO sap.rin1 (docentry, linenum, basetype, baseentry, baseline, itemcode, dscription, quantity, price, linetotal) VALUES
  (301, 0, 13, 201, 0, 'ZFGB200', 'Zeta Cassava Chips 200g', 10, 50, 500);

-- Purchasing: PO 401 open with one line, PO 402 closed with two; GRN 501 free issue from the customer's twin
-- vendor card, GRN 502 a priced receipt with a batch, GRN 503 cancelled.
INSERT INTO sap.opor (docentry, docnum, series, canceled, docstatus, docdate, docduedate, cardcode, cardname, numatcard, vatsum, doctotal, createdate, createts, usersign) VALUES
  (401, 1, 14, 'N', 'O', '2026-03-15', '2026-03-29', 'ZV002', 'Gamma Packaging Co', 'GQ-12', 1800, 11800, '2026-03-15', 90000, 1),
  (402, 2, 14, 'N', 'C', '2026-02-10', '2026-02-20', 'ZV002', 'Gamma Packaging Co', 'GQ-09', 1000, 11000, '2026-02-10', 90000, 1);

INSERT INTO sap.por1 (docentry, linenum, visorder, itemcode, dscription, quantity, openqty, unitmsr, price, linetotal, opensum, vatprcnt, linestatus) VALUES
  (401, 0, 0, 'ZPMCN', 'Carton- Zeta 5 Ply', 1000, 1000, 'Nos', 10, 10000, 10000, 18, 'O'),
  (402, 0, 0, 'ZPMCN', 'Carton- Zeta 5 Ply', 400, 0, 'Nos', 10, 4000, 0, 18, 'C'),
  (402, 1, 1, 'ZPMLMA', 'Laminate-Zeta Banana 100g', 20, 0, NULL, 250, 5000, 0, 18, 'C');

INSERT INTO sap.opdn (docentry, docnum, series, canceled, docstatus, docdate, cardcode, cardname, numatcard, doctotal, createdate, createts) VALUES
  (501, 1, 15, 'N', 'C', '2026-03-20', 'ZV001', 'Alpha Snacks Pvt Ltd - Vendor', 'DC-31', 0, '2026-03-20', 100000),
  (502, 2, 15, 'N', 'C', '2026-03-22', 'ZV002', 'Gamma Packaging Co', 'INV-88', 36000, '2026-03-22', 100000),
  (503, 3, 15, 'Y', 'C', '2026-03-23', 'ZV002', 'Gamma Packaging Co', 'INV-89', 500, '2026-03-23', 100000);

INSERT INTO sap.pdn1 (docentry, linenum, visorder, basetype, baseentry, baseline, itemcode, dscription, quantity, unitmsr, price, linetotal, whscode) VALUES
  (501, 0, 0, -1, NULL, NULL, 'ZPMLMCS', 'Laminate-Customer Brand Small', 12.5, 'Kg', 0, 0, 'RM01'),
  (502, 0, 0, 22, 402, 0, 'ZPMCN', 'Carton- Zeta 5 Ply', 400, 'Nos', 10, 4000, 'RM01'),
  (502, 1, 1, -1, NULL, NULL, 'ZRMBN', 'Raw Banana- Test Farm', 800, 'KG', 40, 32000, 'RM01'),
  (503, 0, 0, -1, NULL, NULL, 'ZPMCN', 'Carton- Zeta 5 Ply', 50, 'Nos', 10, 500, 'RM01');

INSERT INTO sap.obtn (absentry, itemcode, sysnumber, distnumber) VALUES
  (1, 'ZRMBN', 1, 'B-TEST-01');

INSERT INTO sap.oitl (logentry, itemcode, docentry, docline, doctype, docdate) VALUES
  (1, 'ZRMBN', 502, 1, 20, '2026-03-22');

INSERT INTO sap.itl1 (logentry, itemcode, sysnumber, quantity, mdabsentry) VALUES
  (1, 'ZRMBN', 1, 800, 1);

-- A/P invoice 602 was cancelled; its mirror 603 sits in the same series with the same number.
INSERT INTO sap.opch (docentry, docnum, series, canceled, docstatus, docdate, docduedate, cardcode, cardname, numatcard, doctotal, vatsum) VALUES
  (601, 1, 17, 'N', 'O', '2026-03-25', '2026-04-24', 'ZV002', 'Gamma Packaging Co', 'INV-88', 36000, 0),
  (602, 2, 17, 'Y', 'C', '2026-03-26', '2026-04-25', 'ZV002', 'Gamma Packaging Co', 'INV-90', 1200, 0),
  (603, 2, 17, 'C', 'C', '2026-03-26', '2026-04-25', 'ZV002', 'Gamma Packaging Co', 'INV-90', 1200, 0);

-- Production: 701 standard and closed with issues and a receipt; 702 a released disassembly; 703 planned;
-- 704 cancelled.
INSERT INTO sap.owor (docentry, docnum, series, itemcode, prodname, status, type, plannedqty, cmpltqty, postdate, startdate, duedate, closedate, cardcode, u_cardname, u_potype, warehouse, uom, createdate, createts) VALUES
  (701, 1, 16, 'ZFGA100', 'Zeta Banana Chips 100g', 'L', 'S', 1000, 1000, '2026-03-18', '2026-03-18', '2026-03-19', '2026-03-19', 'ZC001', NULL, 'CSP', 'FG01', 'Pcs', '2026-03-18', 80000),
  (702, 2, 16, 'ZFGB200', 'Zeta Cassava Chips 200g', 'R', 'D', 50, 0, '2026-03-28', '2026-03-28', '2026-03-30', NULL, NULL, NULL, 'IHSP', 'FG01', 'Pcs', '2026-03-28', 80000),
  (703, 3, 16, 'ZFGB200', 'Zeta Cassava Chips 200g', 'P', 'S', 200, 0, '2026-03-30', '2026-03-31', '2026-04-02', NULL, 'ZC002', NULL, 'IHSP', 'FG01', 'Pcs', '2026-03-30', 80000),
  (704, 4, 16, 'ZFGA100', 'Zeta Banana Chips 100g', 'C', 'S', 500, 0, '2026-03-12', '2026-03-12', '2026-03-13', NULL, 'ZC001', NULL, 'CSP', 'FG01', 'Pcs', '2026-03-12', 80000);

INSERT INTO sap.wor1 (docentry, linenum, visorder, itemcode, baseqty, plannedqty, issuedqty, issuetype, warehouse, itemname) VALUES
  (701, 0, 0, 'ZRMBN', 0.1, 100, 100, 'M', 'RM01', 'Raw Banana- Test Farm'),
  (701, 1, 1, 'ZPMLMA', 0.008, 8, 8, 'B', 'RM01', 'Laminate-Zeta Banana 100g'),
  (701, 2, 2, 'ZPMCN', 0.02, 20, 20, 'B', 'RM01', 'Carton- Zeta 5 Ply'),
  (702, 0, 0, 'ZRMBN', 0.4, 20, 0, 'M', 'RM01', 'Raw Banana- Test Farm'),
  (703, 0, 0, 'ZRMBN', 0.45, 90, 0, 'M', 'RM01', 'Raw Banana- Test Farm');

INSERT INTO sap.oige (docentry, docnum, series, canceled, docdate, doctotal) VALUES
  (801, 1, 19, 'N', '2026-03-18', 5000);

INSERT INTO sap.ige1 (docentry, linenum, basetype, baseentry, baseline, itemcode, quantity, stockprice) VALUES
  (801, 0, 202, 701, 0, 'ZRMBN', 100, 40),
  (801, 1, 202, 701, 1, 'ZPMLMA', 8, 100),
  (801, 2, 202, 701, 2, 'ZPMCN', 20, 10);

INSERT INTO sap.oign (docentry, docnum, series, canceled, docdate, doctotal) VALUES
  (802, 1, 18, 'N', '2026-03-19', 5000);

INSERT INTO sap.ign1 (docentry, linenum, basetype, baseentry, baseline, itemcode, quantity, stockprice) VALUES
  (802, 0, 202, 701, NULL, 'ZFGA100', 1000, 5);

-- Approvals: SO 101 was approved from draft 9001; another SO draft is still waiting.
INSERT INTO sap.owtm (wtmcode, name, active) VALUES
  (1, 'Sales order approval', 'Y');

INSERT INTO sap.owdd (wddcode, wtmcode, docentry, objtype, status, usersign, createdate, createtime, draftentry, remarks) VALUES
  (1, 1, 101, '17', 'Y', 5, '2026-03-30', 1010, 9001, 'Rate below list'),
  (2, 1, NULL, '17', 'W', 5, '2026-03-31', 1700, 9002, NULL);

INSERT INTO sap.wdd1 (wddcode, stepcode, userid, status, updatedate, updatetime) VALUES
  (1, 1, 1, 'Y', '2026-03-30', 1012),
  (2, 1, 1, 'W', NULL, NULL);

-- Attachments (schema att, written by `run.py attachments`): invented files. Invoice 204 (Alpha) has its print, a
-- QR image and an internal-only supporting file; invoice 201 (Beta) only an e-way bill; GRN 502 a supplier bill (also
-- linked to the payment to Gamma, 4003). Finance-only files: a gas receipt on payment 4001 and Alpha's KYC paper.
-- Tests write the bytes into a temporary file store under these keys.
INSERT INTO att.files (sha256, storage_key, file_name, mime, size_bytes, kind, text_excerpt, source, file_time) VALUES
  ('1111111111111111111111111111111111111111111111111111111111111111', 'sap/11/11/1111111111111111111111111111111111111111111111111111111111111111.pdf',
   'AR Invoice [Approved]_20260331_160500.pdf', 'application/pdf', 1200, 'sap_print', 'Invoice No : TF/25-26/3', 'sap_print', '2026-03-31T10:35:00Z'),
  ('2222222222222222222222222222222222222222222222222222222222222222', 'sap/22/22/2222222222222222222222222222222222222222222222222222222222222222.png',
   'GSTZENQRtest0204.png', 'image/png', 300, 'einvoice_qr', NULL, 'sap_ccs', '2026-03-31T10:31:00Z'),
  ('3333333333333333333333333333333333333333333333333333333333333333', 'sap/33/33/3333333333333333333333333333333333333333333333333333333333333333.pdf',
   'alpha-mail.pdf', 'application/pdf', 900, 'attachment', NULL, 'sap_atc1', '2026-03-31T10:00:00Z'),
  ('4444444444444444444444444444444444444444444444444444444444444444', 'sap/44/44/4444444444444444444444444444444444444444444444444444444444444444.pdf',
   '900201000000.pdf', 'application/pdf', 800, 'ewaybill', NULL, 'sap_atc1', '2026-03-31T09:05:00Z'),
  ('5555555555555555555555555555555555555555555555555555555555555555', 'sap/55/55/5555555555555555555555555555555555555555555555555555555555555555.pdf',
   'gamma-bill.pdf', 'application/pdf', 700, 'attachment', NULL, 'sap_atc1', '2026-03-22T05:00:00Z'),
  ('6666666666666666666666666666666666666666666666666666666666666666', 'sap/66/66/6666666666666666666666666666666666666666666666666666666666666666.pdf',
   'gas-receipt.pdf', 'application/pdf', 500, 'attachment', NULL, 'sap_atc1', '2026-03-31T06:30:00Z'),
  ('7777777777777777777777777777777777777777777777777777777777777777', 'sap/77/77/7777777777777777777777777777777777777777777777777777777777777777.pdf',
   'alpha-kyc.pdf', 'application/pdf', 400, 'attachment', NULL, 'sap_atc1', '2026-01-10T06:00:00Z');

INSERT INTO att.links (sha256, sap_object, doc_entry, doc_no, card_code, doc_date, role, link_method, confidence) VALUES
  ('1111111111111111111111111111111111111111111111111111111111111111', '13', 204, 'TF/25-26/3', 'ZC001', '2026-03-31', 'invoice_pdf', 'content_doc_no', 'content'),
  ('2222222222222222222222222222222222222222222222222222222222222222', '13', 204, 'TF/25-26/3', 'ZC001', '2026-03-31', 'einvoice_qr', 'ccs_eoinv', 'exact'),
  ('3333333333333333333333333333333333333333333333333333333333333333', '13', 204, 'TF/25-26/3', 'ZC001', '2026-03-31', 'supporting', 'atc1', 'exact'),
  ('4444444444444444444444444444444444444444444444444444444444444444', '13', 201, 'TF/25-26/1', 'ZC002', '2026-03-31', 'ewaybill', 'atc1', 'exact'),
  ('5555555555555555555555555555555555555555555555555555555555555555', '20', 502, 'GR/25-26/2', 'ZV002', '2026-03-22', 'supporting', 'atc1', 'exact'),
  ('5555555555555555555555555555555555555555555555555555555555555555', '46', 4003, 'PA/25-26/23', 'ZV002', '2026-03-31', 'supporting', 'atc1', 'exact'),
  ('6666666666666666666666666666666666666666666666666666666666666666', '46', 4001, 'PA/25-26/21', NULL, '2026-03-31', 'supporting', 'atc1', 'exact'),
  ('7777777777777777777777777777777777777777777777777777777777777777', '2', NULL, 'ZC001', 'ZC001', NULL, 'supporting', 'atc1', 'exact');

-- Finance (P6) ---------------------------------------------------------------------------------------------------
-- Chart of accounts: two banks under a "Bank accounts" heading (ZBANK1 is the house bank in DSC1), a cash account,
-- expense / income accounts and the control accounts. Every amount and name below is invented.
INSERT INTO sap.oact (acctcode, acctname, formatcode, fathernum, levels, postable, finanse, frozenfor, validfor) VALUES
  ('Z10304', 'Balances with banks', NULL, 'Z103', 3, 'N', 'N', 'N', 'N'),
  ('Z1030401', 'Bank accounts', NULL, 'Z10304', 4, 'N', 'N', 'N', 'N'),
  ('Z1030301', 'Cash on hand', NULL, 'Z103', 4, 'N', 'N', 'N', 'N'),
  ('ZBANK1', 'Zeta Bank, Testville-000111 (TRA)', '1030401001TRA', 'Z1030401', 5, 'Y', 'Y', 'N', 'N'),
  ('ZBANK2', 'Omega Bank A/c 000222 (TRA)', '1030401002TRA', 'Z1030401', 5, 'Y', 'Y', 'N', 'N'),
  ('ZBANK3', 'Dormant Bank A/c 000333 (TRA)', '1030401003TRA', 'Z1030401', 5, 'Y', 'N', 'N', 'N'),
  ('ZCASH', 'Cash-Testville Office (TRA)', '1030301001TRA', 'Z1030301', 5, 'Y', 'Y', 'N', 'N'),
  ('ZGAS', 'Industrial Gas Expenses (TRA)', '5030101001TRA', 'Z503', 5, 'Y', 'N', 'N', 'N'),
  ('ZREP', 'Repairs & Maintenance-Others (TRA)', '5030101002TRA', 'Z503', 5, 'Y', 'N', 'N', 'N'),
  ('ZMISC', 'Misc Income (TRA)', '4010201001TRA', 'Z401', 5, 'Y', 'N', 'N', 'N'),
  ('ZSALES', 'Sales Revenue (TRA)', '4010101001TRA', 'Z401', 5, 'Y', 'N', 'N', 'N'),
  ('ZCAP', 'Share Capital (TRA)', '2010101001TRA', 'Z201', 5, 'Y', 'N', 'N', 'N'),
  ('ZPURCH', 'Purchases (TRA)', '5010101001TRA', 'Z501', 5, 'Y', 'N', 'N', 'N');

INSERT INTO sap.dsc1 (absentry, bankcode, account, glaccount) VALUES (1, 'ZETA', '000111', 'ZBANK1');

INSERT INTO sap.nnm1 (series, objectcode, seriesname) VALUES
  (20, '24', 'RT/25-26'),
  (21, '46', 'PA/25-26'),
  (22, '30', 'JV/25-26');

-- Incoming payments: 3001 Alpha 5,000 into ZBANK1; 3002 a transfer of 3,000 from ZBANK1 into ZBANK2; 3003 misc
-- income 1.10 into ZBANK2 dated 30-Mar but keyed on 31-Mar (the report test moves it to 31-Mar).
INSERT INTO sap.orct (docentry, docnum, series, doctype, canceled, docdate, cardcode, cardname, trsfracct, trsfrsum, doctotal, paynodoc, nodocsum, comments, jrnlmemo, transid, createdate, createts) VALUES
  (3001, 11, 20, 'C', 'N', '2026-03-31', 'ZC001', 'Alpha Snacks Pvt Ltd', 'ZBANK1', 5000, 5000, 'Y', 5000, 'Payment from Alpha', 'Payment from Alpha', 9002, '2026-03-31', 101500),
  (3002, 12, 20, 'A', 'N', '2026-03-31', 'ZBANK1', 'Zeta Bank, Testville-000111 (TRA)', 'ZBANK2', 3000, 3000, 'Y', 3000, 'Payment from Zeta Bank', 'Payment from Zeta Bank', 9005, '2026-03-31', 110000),
  (3003, 13, 20, 'A', 'N', '2026-03-30', 'ZMISC', 'Misc Income (TRA)', 'ZBANK2', 1.10, 1.10, 'Y', 1.10, 'Payment from Misc Income', 'Payment from Misc Income', 9006, '2026-03-31', 93000);

INSERT INTO sap.rct4 (docnum, lineid, acctcode, sumapplied, acctname) VALUES
  (3002, 0, 'ZBANK1', 3000, 'Zeta Bank, Testville-000111 (TRA)'),
  (3003, 0, 'ZMISC', 1.10, 'Misc Income (TRA)');

-- Outgoing payments: 4001 gas 1,200 and 4002 repairs 800 (account payments), 4003 to supplier ZV002 10,000;
-- 4004 a cancelled payment (left out of lists and totals).
INSERT INTO sap.ovpm (docentry, docnum, series, doctype, canceled, docdate, cardcode, cardname, trsfracct, trsfrsum, doctotal, paynodoc, nodocsum, comments, jrnlmemo, transid, createdate, createts) VALUES
  (4001, 21, 21, 'A', 'N', '2026-03-31', 'ZGAS', NULL, 'ZBANK1', 1200, 1200, 'Y', 1200, 'Paid to ramesh - 2 gas cylinders', 'Paid to ramesh - 2 gas cylinders', 9003, '2026-03-31', 120000),
  (4002, 22, 21, 'A', 'N', '2026-03-31', 'ZREP', NULL, 'ZBANK1', 800, 800, 'Y', 800, 'Paid to suresh for welding work', 'Outgoing Payments - 5030101002-TRA', 9004, '2026-03-31', 121000),
  (4003, 23, 21, 'S', 'N', '2026-03-31', 'ZV002', 'Gamma Packaging Co', 'ZBANK1', 10000, 10000, 'Y', 10000, 'Paid to Gamma', 'Paid to Gamma', 9007, '2026-03-31', 130000),
  (4004, 24, 21, 'A', 'Y', '2026-03-20', 'ZGAS', NULL, 'ZBANK1', 999, 999, 'Y', 999, 'Paid twice by mistake', 'Paid twice by mistake', NULL, '2026-03-20', 120000);

INSERT INTO sap.vpm4 (docnum, lineid, acctcode, sumapplied, acctname) VALUES
  (4001, 0, 'ZGAS', 1200, 'Industrial Gas Expenses (TRA)'),
  (4002, 0, 'ZREP', 800, 'Repairs & Maintenance-Others (TRA)'),
  (4004, 0, 'ZGAS', 999, 'Industrial Gas Expenses (TRA)');

-- A payment waiting for approval (draft 5001, 2,500 for unloading) and one approved earlier (paid as 4001).
INSERT INTO sap.opdf (docentry, docnum, series, objtype, doctype, canceled, docdate, cardcode, trsfracct, doctotal, comments) VALUES
  (5001, 1, 21, '46', 'A', 'N', '2026-03-31', 'ZGAS', 'ZBANK1', 2500, 'Banana unloading charge'),
  (5002, 2, 21, '46', 'A', 'N', '2026-03-31', 'ZGAS', 'ZBANK1', 1200, 'Paid to ramesh - 2 gas cylinders');

INSERT INTO sap.pdf4 (docnum, lineid, acctcode, sumapplied) VALUES
  (5001, 0, 'ZGAS', 2500),
  (5002, 0, 'ZGAS', 1200);

INSERT INTO sap.owdd (wddcode, wtmcode, docentry, objtype, status, usersign, createdate, createtime, draftentry, remarks) VALUES
  (3, 1, NULL, '46', 'W', 5, '2026-03-31', 1500, 5001, NULL),
  (4, 1, 4001, '46', 'Y', 5, '2026-03-31', 1100, 5002, NULL);

INSERT INTO sap.wdd1 (wddcode, stepcode, userid, status, updatedate, updatetime) VALUES
  (3, 1, 1, 'W', NULL, NULL),
  (4, 1, 1, 'Y', '2026-03-31', 1155);

-- The journal. Bank lines: ZBANK1 opens at 10,000 (01-Mar); on 31-Mar +5,000 Alpha, -1,200 gas, -800 repairs,
-- -3,000 transfer to ZBANK2, -10,000 Gamma; ZBANK2 +3,000 transfer and +1.10 misc income (dated 30-Mar).
-- Business-partner lines: invoices 201 / 204 / 205, an older Alpha invoice (Dec), credit note 301, A/P invoice 601.
INSERT INTO sap.ojdt (transid, transtype, baseref, createdby, refdate, memo, number, series, createdate, createtime, usersign, loctotal) VALUES
  (9001, '30', '1', 1, '2026-03-01', 'Opening funds', 1, 22, '2026-03-01', 900, 1, 10000),
  (9002, '24', '11', 3001, '2026-03-31', 'Payment from Alpha', 11, 22, '2026-03-31', 1015, 5, 5000),
  (9003, '46', '21', 4001, '2026-03-31', 'Paid to ramesh - 2 gas cylinders', 21, 22, '2026-03-31', 1200, 5, 1200),
  (9004, '46', '22', 4002, '2026-03-31', 'Outgoing Payments - 5030101002-TRA', 22, 22, '2026-03-31', 1210, 5, 800),
  (9005, '24', '12', 3002, '2026-03-31', 'Payment from Zeta Bank', 12, 22, '2026-03-31', 1100, 5, 3000),
  (9006, '24', '13', 3003, '2026-03-30', 'Payment from Misc Income', 13, 22, '2026-03-31', 930, 5, 1.10),
  (9007, '46', '23', 4003, '2026-03-31', 'Paid to Gamma', 23, 22, '2026-03-31', 1300, 5, 10000),
  (9101, '13', '1', 201, '2026-03-31', 'A/R invoice', 101, 22, '2026-03-31', 1430, 5, 5250),
  (9102, '13', '3', 204, '2026-03-31', 'A/R invoice', 102, 22, '2026-03-31', 1600, 5, 1050),
  (9103, '13', '4', 205, '2026-03-05', 'A/R invoice', 103, 22, '2026-03-05', 1100, 5, 2000),
  (9104, '30', '2', 2, '2025-12-01', 'Alpha opening invoice', 2, 22, '2025-12-01', 1000, 1, 10000),
  (9105, '14', '1', 301, '2026-03-25', 'A/R credit memo', 105, 22, '2026-03-25', 1000, 5, 525),
  (9106, '18', '1', 601, '2026-03-25', 'A/P invoice', 106, 22, '2026-03-25', 1000, 5, 36000);

INSERT INTO sap.jdt1 (transid, line_id, account, shortname, contraact, debit, credit, refdate, duedate, transtype, createdby, baseref, linememo) VALUES
  (9001, 0, 'ZBANK1', 'ZBANK1', 'ZCAP', 10000, 0, '2026-03-01', '2026-03-01', '30', 1, '1', 'Opening funds'),
  (9001, 1, 'ZCAP', 'ZCAP', 'ZBANK1', 0, 10000, '2026-03-01', '2026-03-01', '30', 1, '1', 'Opening funds'),
  (9002, 0, 'ZBANK1', 'ZBANK1', 'ZC001', 5000, 0, '2026-03-31', '2026-03-31', '24', 3001, '11', 'Payment from Alpha'),
  (9002, 1, 'ZDEBT', 'ZC001', 'ZBANK1', 0, 5000, '2026-03-31', '2026-03-31', '24', 3001, '11', 'Payment from Alpha'),
  (9003, 0, 'ZBANK1', 'ZBANK1', 'ZGAS', 0, 1200, '2026-03-31', '2026-03-31', '46', 4001, '21', 'Paid to ramesh - 2 gas cylinders'),
  (9003, 1, 'ZGAS', 'ZGAS', 'ZBANK1', 1200, 0, '2026-03-31', '2026-03-31', '46', 4001, '21', 'Paid to ramesh - 2 gas cylinders'),
  (9004, 0, 'ZBANK1', 'ZBANK1', 'ZREP', 0, 800, '2026-03-31', '2026-03-31', '46', 4002, '22', 'Outgoing Payments - 5030101002-TRA'),
  (9004, 1, 'ZREP', 'ZREP', 'ZBANK1', 800, 0, '2026-03-31', '2026-03-31', '46', 4002, '22', 'Outgoing Payments - 5030101002-TRA'),
  (9005, 0, 'ZBANK2', 'ZBANK2', 'ZBANK1', 3000, 0, '2026-03-31', '2026-03-31', '24', 3002, '12', 'Payment from Zeta Bank'),
  (9005, 1, 'ZBANK1', 'ZBANK1', 'ZBANK2', 0, 3000, '2026-03-31', '2026-03-31', '24', 3002, '12', 'Payment from Zeta Bank'),
  (9006, 0, 'ZBANK2', 'ZBANK2', 'ZMISC', 1.10, 0, '2026-03-30', '2026-03-30', '24', 3003, '13', 'Payment from Misc Income'),
  (9006, 1, 'ZMISC', 'ZMISC', 'ZBANK2', 0, 1.10, '2026-03-30', '2026-03-30', '24', 3003, '13', 'Payment from Misc Income'),
  (9007, 0, 'ZBANK1', 'ZBANK1', 'ZV002', 0, 10000, '2026-03-31', '2026-03-31', '46', 4003, '23', 'Paid to Gamma'),
  (9007, 1, 'ZCRED', 'ZV002', 'ZBANK1', 10000, 0, '2026-03-31', '2026-03-31', '46', 4003, '23', 'Paid to Gamma'),
  (9101, 0, 'ZDEBT', 'ZC002', 'ZSALES', 5250, 0, '2026-03-31', NULL, '13', 201, '1', NULL),
  (9101, 1, 'ZSALES', 'ZSALES', 'ZC002', 0, 5250, '2026-03-31', NULL, '13', 201, '1', NULL),
  (9102, 0, 'ZDEBT', 'ZC001', 'ZSALES', 1050, 0, '2026-03-31', NULL, '13', 204, '3', NULL),
  (9102, 1, 'ZSALES', 'ZSALES', 'ZC001', 0, 1050, '2026-03-31', NULL, '13', 204, '3', NULL),
  (9103, 0, 'ZDEBT', 'ZC002', 'ZSALES', 2000, 0, '2026-03-05', NULL, '13', 205, '4', NULL),
  (9103, 1, 'ZSALES', 'ZSALES', 'ZC002', 0, 2000, '2026-03-05', NULL, '13', 205, '4', NULL),
  (9104, 0, 'ZDEBT', 'ZC001', 'ZSALES', 10000, 0, '2025-12-01', NULL, '30', 2, '2', 'Alpha opening invoice'),
  (9104, 1, 'ZSALES', 'ZSALES', 'ZC001', 0, 10000, '2025-12-01', NULL, '30', 2, '2', 'Alpha opening invoice'),
  (9105, 0, 'ZDEBT', 'ZC002', 'ZSALES', 0, 525, '2026-03-25', NULL, '14', 301, '1', NULL),
  (9105, 1, 'ZSALES', 'ZSALES', 'ZC002', 525, 0, '2026-03-25', NULL, '14', 301, '1', NULL),
  (9106, 0, 'ZCRED', 'ZV002', 'ZPURCH', 0, 36000, '2026-03-25', '2026-04-24', '18', 601, '1', NULL),
  (9106, 1, 'ZPURCH', 'ZPURCH', 'ZV002', 36000, 0, '2026-03-25', '2026-04-24', '18', 601, '1', NULL);

-- Cancelled payments. SAP cancels a payment with a reversing journal entry (StornoToTr -> the original) in the same
-- columns with negative amounts: receipt 3004 from Alpha 2,000 dated 29-Mar, cancelled on 30-Mar, and payment 4005
-- for gas 700 on 31-Mar, cancelled the same day. Neither changes a balance or the ageing; the 31-Mar lists leave the
-- pair out and the 30-Mar receipts list shows "cancelled Alpha" -2,000.
INSERT INTO sap.orct (docentry, docnum, series, doctype, canceled, docdate, cardcode, cardname, trsfracct, trsfrsum, doctotal, paynodoc, nodocsum, comments, jrnlmemo, transid, createdate, createts) VALUES
  (3004, 14, 20, 'C', 'Y', '2026-03-29', 'ZC001', 'Alpha Snacks Pvt Ltd', 'ZBANK1', 2000, 2000, 'Y', 2000, 'Payment from Alpha', 'Payment from Alpha', 9008, '2026-03-29', 100000);
INSERT INTO sap.ovpm (docentry, docnum, series, doctype, canceled, docdate, cardcode, cardname, trsfracct, trsfrsum, doctotal, paynodoc, nodocsum, comments, jrnlmemo, transid, createdate, createts) VALUES
  (4005, 25, 21, 'A', 'Y', '2026-03-31', 'ZGAS', NULL, 'ZBANK1', 700, 700, 'Y', 700, 'Paid to ramesh - gas refill', 'Paid to ramesh - gas refill', 9010, '2026-03-31', 140000);
INSERT INTO sap.vpm4 (docnum, lineid, acctcode, sumapplied, acctname) VALUES
  (4005, 0, 'ZGAS', 700, 'Industrial Gas Expenses (TRA)');
INSERT INTO sap.ojdt (transid, transtype, baseref, createdby, refdate, memo, number, series, createdate, createtime, usersign, loctotal, stornototr) VALUES
  (9008, '24', '14', 3004, '2026-03-29', 'Payment from Alpha', 14, 22, '2026-03-29', 1000, 5, 2000, NULL),
  (9009, '24', '14', 3004, '2026-03-30', 'Payment from Alpha', 15, 22, '2026-03-30', 1000, 5, -2000, 9008),
  (9010, '46', '25', 4005, '2026-03-31', 'Paid to ramesh - gas refill', 25, 22, '2026-03-31', 1400, 5, 700, NULL),
  (9011, '46', '25', 4005, '2026-03-31', 'Paid to ramesh - gas refill', 26, 22, '2026-03-31', 1410, 5, -700, 9010);
INSERT INTO sap.jdt1 (transid, line_id, account, shortname, contraact, debit, credit, refdate, duedate, transtype, createdby, baseref, linememo) VALUES
  (9008, 0, 'ZBANK1', 'ZBANK1', 'ZC001', 2000, 0, '2026-03-29', '2026-03-29', '24', 3004, '14', 'Payment from Alpha'),
  (9008, 1, 'ZDEBT', 'ZC001', 'ZBANK1', 0, 2000, '2026-03-29', '2026-03-29', '24', 3004, '14', 'Payment from Alpha'),
  (9009, 0, 'ZBANK1', 'ZBANK1', 'ZC001', -2000, 0, '2026-03-30', '2026-03-30', '24', 3004, '14', 'Payment from Alpha'),
  (9009, 1, 'ZDEBT', 'ZC001', 'ZBANK1', 0, -2000, '2026-03-30', '2026-03-30', '24', 3004, '14', 'Payment from Alpha'),
  (9010, 0, 'ZBANK1', 'ZBANK1', 'ZGAS', 0, 700, '2026-03-31', '2026-03-31', '46', 4005, '25', 'Paid to ramesh - gas refill'),
  (9010, 1, 'ZGAS', 'ZGAS', 'ZBANK1', 700, 0, '2026-03-31', '2026-03-31', '46', 4005, '25', 'Paid to ramesh - gas refill'),
  (9011, 0, 'ZBANK1', 'ZBANK1', 'ZGAS', 0, -700, '2026-03-31', '2026-03-31', '46', 4005, '25', 'Paid to ramesh - gas refill'),
  (9011, 1, 'ZGAS', 'ZGAS', 'ZBANK1', -700, 0, '2026-03-31', '2026-03-31', '46', 4005, '25', 'Paid to ramesh - gas refill');

-- Costing (P7) ---------------------------------------------------------------------------------------------------
-- SAP's cost of goods sold at invoice: ZFGA100 at 6 a piece (production 701 valued it at 5), ZFGB200 at 30 (not
-- produced in March, so its margin falls back to this).
UPDATE sap.inv1 SET stockprice = 6 WHERE itemcode = 'ZFGA100';
UPDATE sap.inv1 SET stockprice = 30 WHERE itemcode = 'ZFGB200';

-- Valuation layers: 300 of the 1,000 ZFGA100 left at 5 (1,500), 800 kg banana at 40 (32,000), customer-supplied
-- laminate at 0. A layer fully used up (ZFLV) drops out.
INSERT INTO sap.oivl (transseq, transtype, createdby, itemcode, loccode, inqty, outqty, docdate) VALUES
  (1, 59, 802, 'ZFGA100', 'FG01', 1000, 700, '2026-03-19'),
  (2, 20, 502, 'ZRMBN', 'RM01', 800, 0, '2026-03-22'),
  (3, 20, 501, 'ZPMLMCS', 'RM01', 12.5, 0, '2026-03-20'),
  (4, 20, 502, 'ZFLV', 'RM01', 2, 2, '2026-03-02');
INSERT INTO sap.ivl1 (transseq, layerid, calcprice, balance, transvalue, layerinqty, layeroutq) VALUES
  (1, 0, 5, 1500, 1500, 1000, 700),
  (2, 0, 40, 32000, 32000, 800, 0),
  (3, 0, 0, 0, 0, 12.5, 0),
  (4, 0, 200, 0, 0, 2, 2);

-- Chart of accounts for the costing and payroll cards: inventories (with the WIP heading), the WIP variance account
-- and the salary accounts. Journal: production order 701 closed with a 120 WIP variance; the February salary JE
-- (Office 30,000 + Others 50,000 to the payable); raw material stock of 33,000 against capital.
INSERT INTO sap.oact (acctcode, acctname, formatcode, fathernum, levels, postable, finanse, frozenfor, validfor) VALUES
  ('ZINV', 'Inventories', NULL, 'Z103', 3, 'N', 'N', 'N', 'N'),
  ('ZRMST', 'Raw Materials Stock(TRA)', '1030101001TRA', 'ZINV', 5, 'Y', 'N', 'N', 'N'),
  ('ZWIPH', 'Work in Progress', NULL, 'ZINV', 4, 'N', 'N', 'N', 'N'),
  ('ZWIP', 'Work in Progress - Production (TRA)', '1030102001TRA', 'ZWIPH', 5, 'Y', 'N', 'N', 'N'),
  ('ZVARH', 'Work in Progress Variance', NULL, 'Z502', 4, 'N', 'N', 'N', 'N'),
  ('ZWIPV', 'Work in Progress Variance (TRA)', '5020102001TRA', 'ZVARH', 5, 'Y', 'N', 'N', 'N'),
  ('ZSALH', 'Salary and Allowances', NULL, 'Z504', 4, 'N', 'N', 'N', 'N'),
  ('ZSALOFF', 'Salary and allowances -Office (TRA)', '5040101001TRA', 'ZSALH', 5, 'Y', 'N', 'N', 'N'),
  ('ZSALOTH', 'Salary and allowances -Others (TRA)', '5040101003TRA', 'ZSALH', 5, 'Y', 'N', 'N', 'N'),
  ('ZSALPAY', 'Salary & Wages Payable (TRA)', '2020501001TRA', 'Z202', 5, 'Y', 'N', 'N', 'N');

INSERT INTO sap.ojdt (transid, transtype, baseref, createdby, refdate, memo, number, series, createdate, createtime, usersign, loctotal) VALUES
  (9201, '202', '1', 701, '2026-03-19', 'Production order', 301, 22, '2026-03-19', 1700, 5, 120),
  (9202, '30', '302', 302, '2026-02-28', 'Salary and wages payable for the month of Feb 26', 302, 22, '2026-02-28', 1800, 1, 80000),
  (9203, '30', '303', 303, '2026-03-01', 'Stock taken over', 303, 22, '2026-03-01', 905, 1, 33000);
INSERT INTO sap.jdt1 (transid, line_id, account, shortname, contraact, debit, credit, refdate, duedate, transtype, createdby, baseref, linememo) VALUES
  (9201, 0, 'ZWIPV', 'ZWIPV', 'ZWIP', 120, 0, '2026-03-19', NULL, '202', 701, '1', NULL),
  (9201, 1, 'ZWIP', 'ZWIP', 'ZWIPV', 0, 120, '2026-03-19', NULL, '202', 701, '1', NULL),
  (9202, 0, 'ZSALOFF', 'ZSALOFF', 'ZSALPAY', 30000, 0, '2026-02-28', NULL, '30', 302, '302', 'Salary and wages payable for the month of Feb 26'),
  (9202, 1, 'ZSALOTH', 'ZSALOTH', 'ZSALPAY', 50000, 0, '2026-02-28', NULL, '30', 302, '302', 'Salary and wages payable for the month of Feb 26'),
  (9202, 2, 'ZSALPAY', 'ZSALPAY', 'ZSALOFF', 0, 80000, '2026-02-28', NULL, '30', 302, '302', 'Salary and wages payable for the month of Feb 26'),
  (9203, 0, 'ZRMST', 'ZRMST', 'ZCAP', 33000, 0, '2026-03-01', NULL, '30', 303, '303', 'Stock taken over'),
  (9203, 1, 'ZCAP', 'ZCAP', 'ZRMST', 0, 33000, '2026-03-01', NULL, '30', 303, '303', 'Stock taken over');

-- Valuation methods (OITM.EvalSystem): batch banana, FIFO finished goods and laminate.
UPDATE sap.oitm SET evalsystem = 'B' WHERE itemcode = 'ZRMBN';
UPDATE sap.oitm SET evalsystem = 'F' WHERE itemcode IN ('ZFGA100', 'ZFGB200', 'ZPMLMCS');
