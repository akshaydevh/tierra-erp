-- Hand-written synthetic HR rows (schema hr, tools/sap-import/sql/hr.sql) for the payroll tests. Every name, code and
-- amount is invented. February 2026: a Voyon payroll of 3, a salary register of 3 in three categories (one person
-- not on Voyon), 2 temporary workers, a few attendance days, leave requests and two peelers.

INSERT INTO hr.employees (employee_id, name, name_key, code_voyon, code_register, department, designation, reporting_officer_id,
                          category, employment, on_voyon_payroll, punch_status, punch_in, matched_by, sources) VALUES
  ('TF901', 'Asha Kumar', 'asha kumar', 'TF901', 'T901', 'Admin', 'Director', NULL, 'office_admin', 'permanent', true, 'Present', '09:00 AM', 'joins_file', '{voyon_master,voyon_payroll,register,attendance}'),
  ('TF902', 'Bala Nair', 'bala nair', 'TF902', 'TFL902', 'Production', 'Production Assistant', 'TF901', 'peeling', 'permanent', true, 'Leave', NULL, 'name', '{voyon_master,voyon_payroll,register,attendance}'),
  ('TF903', 'Chitra Das', 'chitra das', 'TF903', NULL, 'QC', 'Executive QA', 'TF901', NULL, 'permanent', true, 'Not Yet Reported', NULL, NULL, '{voyon_master,voyon_payroll}'),
  ('T904', 'Dev Menon', 'dev menon', NULL, 'T904', NULL, NULL, NULL, 'sales_promotion', 'permanent', false, NULL, NULL, NULL, '{register,attendance}');

INSERT INTO hr.temp_workers (worker_id, name, name_key, block, employee_id) VALUES
  ('TMP-001', 'Ela Temp', 'ela temp', 'temporary', NULL),
  ('TMP-002', 'Fia Temp', 'fia temp', 'sales_promotion_temp', NULL);

INSERT INTO hr.payroll_runs (run_id, month, source, file_name, headcount, gross_earned, total_earning, deductions, net) VALUES
  ('voyon-2026-02', '2026-02-01', 'voyon', 'payroll-voyon-2026-02.xlsx', 3, 60000, 64000, 2890, 61110),
  ('register-2026-02', '2026-02-01', 'register', 'salary-register-2026-02.xlsm', 3, 58000, 62000, 2800, 59200),
  ('temp_sheet-2026-02', '2026-02-01', 'temp_sheet', 'temp-wages-2026-02.xlsx', 2, 18400, 20300, 1093, 19207);

INSERT INTO hr.payroll_lines (run_id, line_no, employee_id, code, name, category, department, designation, days_paid, basic,
                              gross_fixed, gross_earned, peeling_incentive, attendance_incentive, total_earning, pf, esi, tds,
                              advance, total_deductions, net) VALUES
  ('voyon-2026-02', 1, 'TF901', 'TF901', 'Asha Kumar', 'Admin', 'Admin', 'Director', 28, 30000, 30000, 30000, 0, 0, 30000, 0, 0, 1000, 0, 1000, 29000),
  ('voyon-2026-02', 2, 'TF902', 'TF902', 'Bala Nair', 'Production', 'Production', 'Production Assistant', 28, 15000, 18000, 18000, 4000, 0, 22000, 1800, 0, 0, 0, 1800, 20200),
  ('voyon-2026-02', 3, 'TF903', 'TF903', 'Chitra Das', 'QC', 'QC', 'Executive QA', 26, 12000, 12000, 12000, 0, 0, 12000, 0, 90, 0, 0, 90, 11910),
  ('register-2026-02', 1, 'TF901', 'T901', 'Asha Kumar', 'office_admin', NULL, 'Director', 28, 30000, 30000, 30000, 0, 0, 30000, 0, 0, 1000, 0, 1000, 29000),
  ('register-2026-02', 2, 'TF902', 'TFL902', 'Bala Nair', 'peeling', NULL, 'Production Assistant', 28, 15000, 18000, 18000, 4000, 0, 22000, 1800, 0, 0, 0, 1800, 20200),
  ('register-2026-02', 3, 'T904', 'T904', 'Dev Menon', 'sales_promotion', NULL, NULL, 25, 10000, 10000, 10000, 0, 0, 10000, 0, 0, 0, 0, 0, 10000),
  ('temp_sheet-2026-02', 1, 'TMP-001', NULL, 'Ela Temp', 'temporary', NULL, NULL, 26, 0, 0, 10400, 600, 1300, 12300, 0, 93, 0, 0, 93, 12207),
  ('temp_sheet-2026-02', 2, 'TMP-002', NULL, 'Fia Temp', 'sales_promotion_temp', NULL, NULL, 20, 0, 0, 8000, 0, 0, 8000, 0, 0, 0, 1000, 1000, 7000);

INSERT INTO hr.attendance_days (employee_id, code_register, work_date, code) VALUES
  ('TF901', 'T901', '2026-02-02', 'P'), ('TF901', 'T901', '2026-02-03', 'P'), ('TF901', 'T901', '2026-02-04', 'W/OFF'),
  ('TF902', 'TFL902', '2026-02-02', 'P'), ('TF902', 'TFL902', '2026-02-03', 'LWP'), ('TF902', 'TFL902', '2026-02-04', 'CL'),
  ('T904', 'T904', '2026-02-02', 'P'), ('T904', 'T904', '2026-02-03', 'P'), ('T904', 'T904', '2026-02-04', 'Offday');

INSERT INTO hr.leave_requests (request_no, employee_id, code_voyon, employee_name, requested_at, leave_type, from_date, to_date, days, reason, requested_by, status) VALUES
  (1, 'TF902', 'TF902', 'Bala Nair', '2026-02-02 04:00', 'Casual Leave', '2026-02-04', '2026-02-04', 1, NULL, 'TF901', 'Approved'),
  (2, 'TF903', 'TF903', 'Chitra Das', '2026-02-09 05:00', 'Unpaid Leave', '2026-02-10', '2026-02-11', 2, 'fever', 'TF901', 'Approved'),
  (3, 'TF902', 'TF902', 'Bala Nair', '2026-03-01 05:00', 'Unpaid Leave', '2026-03-02', '2026-03-02', 1, NULL, 'TF902', 'Cancelled');

INSERT INTO hr.peeling_output (month, row_no, worker_name, name_key, worker_class, employee_id, work_date, kg, incentive) VALUES
  ('2026-02-01', 5, 'Bala Nair', 'bala nair', 'permanent', 'TF902', '2026-02-02', 210, 157.50),
  ('2026-02-01', 5, 'Bala Nair', 'bala nair', 'permanent', 'TF902', '2026-02-03', 170, 42.50),
  ('2026-02-01', 30, 'Ela Temp', 'ela temp', 'temporary', 'TMP-001', '2026-02-02', 160, 120),
  ('2026-02-01', 30, 'Ela Temp', 'ela temp', 'temporary', 'TMP-001', '2026-02-03', 100, 0);

INSERT INTO hr._import (key, value) VALUES ('imported_at', '2026-03-02T04:00:00Z'), ('months', '["2026-02"]');
