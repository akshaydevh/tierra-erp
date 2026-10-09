-- SAP approval history (OWDD = one request per draft, WDD1 = the approver's decision; one stage per template).
-- doc_entry is the document created from the approved draft (null while waiting or when rejected); doc_no and
-- total come from that document, or for outgoing payments (object 46) from the payment / payment draft.
-- Drafts of other objects (ODRF) are not imported, so a waiting or rejected SO has no number or total.
CREATE VIEW erp.approvals_hist AS
SELECT a.objtype AS doc_object,
       a.docentry AS doc_entry,
       a.draftentry AS draft_entry,
       coalesce(d.doc_no, erp.doc_no(pn.seriesname, p.docnum)) AS doc_no,
       CASE a.status WHEN 'Y' THEN 'approved' WHEN 'N' THEN 'rejected' ELSE 'waiting' END AS status,
       uo.u_name AS originator,
       ua.u_name AS approver,
       erp.sap_ts_hhmm(a.createdate, a.createtime) AS requested_at,
       CASE WHEN s.status IN ('Y', 'N') THEN erp.sap_ts_hhmm(s.updatedate, s.updatetime) END AS decided_at,
       coalesce(d.total, p.doctotal, pd.doctotal) AS total,
       a.wddcode AS request_id,
       t.name AS template,
       coalesce(nullif(s.remarks, ''), nullif(a.remarks, '')) AS remarks,
       coalesce(d.card_name, p.cardname, pd.cardname) AS card_name,
       d.doc_type
FROM sap.owdd a
LEFT JOIN sap.wdd1 s ON s.wddcode = a.wddcode
LEFT JOIN sap.ousr uo ON uo.userid = a.usersign
LEFT JOIN sap.ousr ua ON ua.userid = s.userid
LEFT JOIN sap.owtm t ON t.wtmcode = a.wtmcode
LEFT JOIN erp.documents d ON d.sap_object = a.objtype AND d.doc_entry = a.docentry
LEFT JOIN sap.ovpm p ON a.objtype = '46' AND p.docentry = a.docentry
LEFT JOIN sap.nnm1 pn ON pn.series = p.series
LEFT JOIN sap.opdf pd ON a.objtype = '46' AND pd.docentry = a.draftentry;
