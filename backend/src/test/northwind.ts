import type { ExtractedPo } from '../domain/po'

/**
 * "Northwind": an invented retailer with six branch cards on one GSTIN (every code, name and amount is made up).
 * ZN05 is its DC at site T9QA, which already has SAP SO/25-26/9 for PO 4400012345 (invoiced TF/25-26/9). ZFGN500 is a
 * 500 g pack whose carton and salt are short now but on order: the shape of a real retailer PO's check. Its HSN in SAP
 * is 99990001 (OCHP 7); the PO prints 21069091.
 */
export const GSTIN = '32AAACN9999Q1ZB'

export const NORTHWIND_SAP = `
INSERT INTO sap.oitm (itemcode, itemname, itmsgrpcod, invntryuom, u_itmctg, u_npu, u_taxrate, treetype, manbtchnum, frozenfor) VALUES
  ('ZFGN500', 'Zeta Banana Chips 500g', 100, 'Pcs', 'FG', 30, '5', 'P', 'N', 'N'),
  ('ZPMLMN', 'Laminate-Zeta Big', 150, 'Kg', 'PM', NULL, '18', 'N', 'N', 'N'),
  ('ZPMCN5', 'Carton- Zeta 5 Ply Big', 150, 'Nos', 'PM', NULL, '18', 'N', 'N', 'N'),
  ('ZFLSALT', 'Flavour-Stabilised Salt Test', 159, 'Kg', 'RW', NULL, '12', 'N', 'N', 'N'),
  ('ZOILP', 'Oil-Palm Test', 100, NULL, 'RW', NULL, '5', 'N', 'N', 'N'),
  ('ZPMTP', 'Tape-Zeta', 150, NULL, 'PM', NULL, '18', 'N', 'N', 'N'),
  ('ZCSRIB', 'Consumable Ribbon Test', 129, NULL, 'PM', NULL, '18', 'N', 'N', 'N');
INSERT INTO sap.oitw (itemcode, whscode, onhand, iscommited, onorder, avgprice, stockvalue) VALUES
  ('ZFGN500', 'FG01', 400, 1900, 0, 0, 0),
  ('ZPMLMN', 'RM01', 90, 0, 0, 300, 27000),
  ('ZPMCN5', 'RM01', 30, 22, 500, 40, 1200),
  ('ZFLSALT', 'RM01', 0.5, 2.5, 200, 90, 45),
  ('ZOILP', 'RM01', 1400, 300, 5, 120, 168000),
  ('ZPMTP', 'RM01', 0, 0, 0, 0, 0),
  ('ZCSRIB', 'RM01', 0, 1, 0, 0, 0);
UPDATE sap.oitm SET chapterid = 7 WHERE itemcode = 'ZFGN500';
UPDATE sap.oitw SET onhand = 30000, iscommited = 5000 WHERE itemcode = 'ZRMBN' AND whscode = 'RM01';
INSERT INTO sap.oitt (code, treetype, qauntity) VALUES ('ZFGN500', 'P', 10000);
INSERT INTO sap.itt1 (father, childnum, visorder, code, quantity, warehouse, issuemthd) VALUES
  ('ZFGN500', 0, 0, 'ZOILP', 1250, 'RM01', 'M'),
  ('ZFGN500', 1, 1, 'ZFLSALT', 40, 'RM01', 'M'),
  ('ZFGN500', 2, 2, 'ZPMCN5', 333.33, 'RM01', 'M'),
  ('ZFGN500', 3, 3, 'ZPMLMN', 110, 'RM01', 'M'),
  ('ZFGN500', 4, 4, 'ZPMTP', 20, 'RM01', 'M'),
  ('ZFGN500', 5, 5, 'ZCSRIB', 2, 'RM01', 'M'),
  ('ZFGN500', 6, 6, 'ZRMBN', 17000, 'RM01', 'M');
INSERT INTO sap.opor (docentry, docnum, series, canceled, docstatus, docdate, docduedate, cardcode, cardname, numatcard, vatsum, doctotal, createdate, createts, usersign) VALUES
  (403, 3, 14, 'N', 'O', '2026-03-25', '2026-04-05', 'ZV002', 'Gamma Packaging Co', 'GQ-15', 0, 20000, '2026-03-25', 90000, 1);
INSERT INTO sap.por1 (docentry, linenum, visorder, itemcode, dscription, quantity, openqty, unitmsr, price, linetotal, opensum, vatprcnt, linestatus) VALUES
  (403, 0, 0, 'ZPMCN5', 'Carton- Zeta 5 Ply Big', 500, 500, 'Nos', 40, 20000, 20000, 18, 'O');
INSERT INTO sap.ocrd (cardcode, cardname, cardtype, groupcode, city, state1, balance, billtodef, shiptodef, frozenfor) VALUES
  ('ZN01', 'Northwind Angamaly DC', 'C', 100, 'Angamaly', 'KL', 0, 'SHIP', 'SHIP', 'N'),
  ('ZN02', 'Northwind Thrissur DC', 'C', 100, 'Thrissur', 'KL', 0, 'SHIP', 'SHIP', 'N'),
  ('ZN03', 'Northwind Calicut DC', 'C', 100, 'Calicut', 'KL', 0, 'SHIP', 'SHIP', 'N'),
  ('ZN04', 'Northwind Paravur DC', 'C', 100, 'Paravur', 'KL', 0, 'SHIP', 'SHIP', 'N'),
  ('ZN05', 'Northwind Kalamassery DC', 'C', 100, 'Ernakulam', 'KL', 0, 'SHIP', 'SHIP', 'N'),
  ('ZN06', 'Northwind Vyttila', 'C', 100, 'Ernakulam', 'KL', 0, 'SHIP', 'SHIP', 'N');
INSERT INTO sap.crd1 (cardcode, address, adrestype, linenum, gstregnno, street, city, zipcode) VALUES
  ('ZN01', 'SHIP', 'S', 0, '${GSTIN}', 'Survey 12 Inkel Tower Angamaly South', 'Angamaly', '683573'),
  ('ZN02', 'SHIP', 'S', 0, '${GSTIN}', 'CWC Compound Kuriachira', 'Thrissur', '680006'),
  ('ZN03', 'SHIP', 'S', 0, '${GSTIN}', 'Metro Logistics Thenhipalam', 'Tirurangadi', '673636'),
  ('ZN04', 'SHIP', 'S', 0, '${GSTIN}', 'Airport Road Mannam North Paravur', 'Paravur', '683520'),
  ('ZN05', 'SHIP', 'S', 0, '${GSTIN}', 'Plot 7 Test Industrial Estate Kalamassery', 'Ernakulam', '683104'),
  ('ZN06', 'SHIP', 'S', 0, '${GSTIN}', 'Chandrika Chambers Vyttila', 'Ernakulam', '682019');
INSERT INTO sap.ordr (docentry, docnum, series, canceled, docstatus, docdate, docduedate, taxdate, cardcode, cardname, numatcard, shiptocode, vatsum, doctotal, createdate, createts, usersign, wddstatus) VALUES
  (109, 9, 10, 'N', 'C', '2026-03-05', '2026-03-10', '2026-03-02', 'ZN05', 'Northwind Kalamassery DC', '4400012345', 'SHIP', 637.2, 13381, '2026-03-05', 101500, 5, 'P');
INSERT INTO sap.rdr1 (docentry, linenum, visorder, itemcode, dscription, quantity, openqty, price, linetotal, vatprcnt, taxcode, whscode, linestatus, targettype, trgetentry, unitmsr) VALUES
  (109, 0, 0, 'ZFGA100', '700100200 Zeta Banana Chips 100g', 150, 0, 24.96, 3744, 5, 'GST@5', 'FG01', 'C', 13, 209, 'Pcs');
INSERT INTO sap.oinv (docentry, docnum, series, canceled, docstatus, docdate, cardcode, cardname, numatcard, vatsum, doctotal, createdate, createts) VALUES
  (209, 9, 11, 'N', 'C', '2026-03-05', 'ZN05', 'Northwind Kalamassery DC', '4400012345', 637.2, 13381, '2026-03-05', 120000);
INSERT INTO sap.inv1 (docentry, linenum, visorder, basetype, baseentry, baseline, itemcode, dscription, quantity, price, linetotal, vatprcnt, taxcode, whscode) VALUES
  (209, 0, 0, 17, 109, 0, 'ZFGA100', '700100200 Zeta Banana Chips 100g', 150, 24.96, 3744, 5, 'GST@5', 'FG01');
`

export function northwindPo(overrides: Partial<ExtractedPo> = {}): ExtractedPo {
  return {
    poNumber: '4400099999',
    poDate: '2026-03-20',
    deliveryDate: '2026-04-01',
    buyerName: 'Northwind Retail Limited',
    buyerCode: 'NWBUY01',
    vendorCode: '99887766',
    siteCode: 'T9QA',
    shipToGstin: GSTIN,
    shipToAddress: 'Distribution Center, Plot 7, Test Industrial Estate, Kalamassery, ERNAKULAM, Kerala - 683104',
    basicTotal: 50400,
    taxTotal: 2520,
    total: 52920,
    notes: [],
    lines: [
      {
        lineNo: 1,
        articleNo: '700100900',
        ean: null,
        description: 'ZETA PRM KERELA BANANA CHIPS 500G PP',
        hsn: '21069091',
        qty: 12,
        uom: 'C01',
        eaQty: null,
        mrp: 9000,
        eaMrp: null,
        baseCost: 4200,
        gstPct: 5,
        taxAmount: 2520,
        lineTotal: 50400,
        deliveryDate: '2026-04-01',
      },
    ],
    ...overrides,
  }
}
