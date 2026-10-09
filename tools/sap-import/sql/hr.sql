-- Schema `hr`: payroll and attendance from the HR spreadsheets (Voyon exports, the salary register, the temporary
-- workers' sheet, the peeling register), written by `run.py hr`. SAP has none of this (sap-fin.md §6).
--
-- `run.py hr` builds the schema as `hr_next`, gates it, then swaps it in for `hr` in one transaction, so every run
-- replaces the whole schema. `{s}` is the schema name. Nothing in `erp` or the app's tables references it: the
-- backend reads it directly (queries/payroll.ts), admin only.

CREATE SCHEMA {s};

-- One row per person with an employee code. employee_id is the Voyon code (TF…) when the person is on Voyon, else
-- the salary-register code (T… / TFL…). The same person carries up to two codes; the joins come from a local file
-- (~/tierra-data/hr-joins.yaml) and, for the rest, from matching names.
CREATE TABLE {s}.employees (
  employee_id         text PRIMARY KEY,
  name                text NOT NULL,
  name_key            text NOT NULL,          -- lower-case letters only, for matching
  code_voyon          text UNIQUE,
  code_register       text UNIQUE,
  department          text,                   -- Voyon department (Admin, Accounts, HR, Office, QC, Production)
  designation         text,
  reporting_officer_id text,
  category            text,                   -- salary register sheet: office_admin | peeling | production | sales_promotion
  employment          text NOT NULL,          -- permanent (on the Voyon master or the register)
  date_of_joining     date,
  on_voyon_payroll    boolean NOT NULL DEFAULT false,
  punch_status        text,                   -- the Voyon attendance export (one day): Present | Leave | Not Yet Reported
  punch_in            text,
  punch_out           text,
  matched_by          text,                   -- how the register code was joined to the Voyon code: joins_file | name | loose_name
  sources             text[] NOT NULL
);

-- Temporary workers (the informal wages sheet): no codes, names only. worker_id is TMP-<n>, stable within a run.
CREATE TABLE {s}.temp_workers (
  worker_id     text PRIMARY KEY,
  name          text NOT NULL,
  name_key      text NOT NULL,
  block         text NOT NULL,                -- temporary (factory) | sales_promotion_temp
  employee_id   text                          -- when the same name is on the Voyon master
);

-- The monthly attendance grid (salary register, ATTN sheet): one code per person per day.
-- Codes: P present, Offday worked on an off day, W/OFF weekly off, LWP leave without pay, CL casual leave, PH paid
-- holiday, EL earned leave, OD on duty, C/off compensatory off, ESIC on ESIC leave.
CREATE TABLE {s}.attendance_days (
  employee_id   text NOT NULL,
  code_register text,
  work_date     date NOT NULL,
  code          text NOT NULL,
  PRIMARY KEY (employee_id, work_date)
);
CREATE INDEX attendance_days_date_idx ON {s}.attendance_days (work_date);

-- Voyon leave requests.
CREATE TABLE {s}.leave_requests (
  request_no    integer PRIMARY KEY,           -- row order in the export
  employee_id   text,
  code_voyon    text NOT NULL,
  employee_name text,
  requested_at  timestamp,                     -- as exported (no time zone in the file)
  leave_type    text NOT NULL,
  from_date     date,
  to_date       date,
  days          numeric,
  reason        text,
  requested_by  text,                          -- the Voyon code of whoever raised it (often HR, for workers)
  status        text
);

-- One payroll per source and month: voyon (the Voyon payroll export), register (the salary register, one category
-- per sheet), temp_sheet (the temporary workers' wages sheet). Voyon and the register cover the same permanent staff:
-- never add them together.
CREATE TABLE {s}.payroll_runs (
  run_id        text PRIMARY KEY,              -- <source>-<yyyy-mm>
  month         date NOT NULL,
  source        text NOT NULL,
  file_name     text NOT NULL,
  headcount     integer NOT NULL,
  gross_earned  numeric NOT NULL,
  total_earning numeric NOT NULL,
  deductions    numeric NOT NULL,
  net           numeric NOT NULL
);

CREATE TABLE {s}.payroll_lines (
  run_id                text NOT NULL REFERENCES {s}.payroll_runs (run_id),
  line_no               integer NOT NULL,
  employee_id           text,                  -- employees.employee_id, or temp_workers.worker_id for temp_sheet
  code                  text,                  -- the code as the file has it
  name                  text NOT NULL,
  category              text NOT NULL,         -- voyon: department; register: sheet category; temp_sheet: block
  department            text,
  designation           text,
  days_paid             numeric,
  unpaid_days           numeric,
  basic                 numeric NOT NULL DEFAULT 0,  -- monthly rates (Voyon "approved", the register's fixed columns)
  da                    numeric NOT NULL DEFAULT 0,
  hra                   numeric NOT NULL DEFAULT 0,
  conveyance            numeric NOT NULL DEFAULT 0,
  special               numeric NOT NULL DEFAULT 0,
  gross_fixed           numeric NOT NULL DEFAULT 0,
  gross_earned          numeric NOT NULL DEFAULT 0,  -- pro-rated for the days paid (temp sheet: days x day rate)
  off_day_work          numeric NOT NULL DEFAULT 0,
  overtime              numeric NOT NULL DEFAULT 0,
  attendance_incentive  numeric NOT NULL DEFAULT 0,
  performance_incentive numeric NOT NULL DEFAULT 0,
  peeling_incentive     numeric NOT NULL DEFAULT 0,
  production_incentive  numeric NOT NULL DEFAULT 0,
  other_earnings        numeric NOT NULL DEFAULT 0,
  total_earning         numeric NOT NULL DEFAULT 0,
  lop                   numeric NOT NULL DEFAULT 0,  -- Voyon: loss of pay already out of gross_earned
  pf                    numeric NOT NULL DEFAULT 0,
  esi                   numeric NOT NULL DEFAULT 0,
  tds                   numeric NOT NULL DEFAULT 0,
  advance               numeric NOT NULL DEFAULT 0,
  other_deductions      numeric NOT NULL DEFAULT 0,
  total_deductions      numeric NOT NULL DEFAULT 0,  -- without loss of pay
  net                   numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, line_no)
);
CREATE INDEX payroll_lines_employee_idx ON {s}.payroll_lines (employee_id);

-- The peeling register: kg peeled per worker per day (first shift) and the incentive the register's slabs give.
CREATE TABLE {s}.peeling_output (
  month         date NOT NULL,
  row_no        integer NOT NULL,              -- the worker's row in the register (names repeat with other spellings)
  worker_name   text NOT NULL,
  name_key      text NOT NULL,
  worker_class  text NOT NULL,                 -- permanent | temporary | group
  employee_id   text,                          -- employees / temp_workers id when the name matches one person
  work_date     date NOT NULL,
  kg            numeric NOT NULL,
  incentive     numeric NOT NULL,
  PRIMARY KEY (month, row_no, work_date)
);

CREATE TABLE {s}._import (key text PRIMARY KEY, value text NOT NULL);
