# AyurXpert — Project Context for Claude

## What This Project Is
AyurXpert is a **white-label multi-tenant SaaS platform** for the Ayurveda healthcare ecosystem in India.
- Each hospital/clinic/PK centre is a **tenant** with its own data, branding, and staff
- Staff log in to a shared platform but see only their organisation's data
- Public website (ayurxpert.com) is live for ABDM registration — kept completely separate from the app

---

## Tech Stack
- **Frontend**: Vanilla HTML + CSS + JS (no framework, no build step)
- **Backend**: Supabase (PostgreSQL + Auth + Storage + RLS)
- **Hosting**: GitHub Pages (private app repo) + separate public website repo
- **PWA**: manifest.json + sw.js (service worker v7, network-first for JS/CSS)
- **Fonts**: Cormorant Garamond (headings) + DM Sans (body)
- **Design tokens**: --green-deep #1a4a2e, --gold #c9902a, --cream #faf8f3

---

## Supabase Project
- **URL**: https://xvlvifiebafvgzlixdee.supabase.co
- **Anon key**: in js/config/constants.js (safe to be public)
- **Email confirmation**: DISABLED (required for registration to work)

---

## GitHub Repos
- **App (private)**: github.com/AyurXpert/AyurXpert — main development repo
- **Public website (public)**: github.com/AyurXpert/website — ayurxpert.com live site
- **Local app path**: C:\Users\HP\Desktop\AyurXpert ← ONLY folder on desktop, do NOT create AyurXpert-website

### Live Website Sync Workflow (IMPORTANT)
- The live ayurxpert.com is served from `github.com/AyurXpert/website` repo
- App repo is **private** — GitHub Pages not enabled (requires Enterprise). Website repo is public and serves ayurxpert.com
- App repo has NO CNAME file (removed May 2026 to avoid domain conflict with website repo)
- Edit `home.html` in the main AyurXpert folder

#### Deploy steps — FULL SYNC (run every session end):
Claude uses PowerShell to do this automatically. The sync copies ALL changed HTML files + JS deps.
Files EXCLUDED from sync: `home.html` (→ `index.html` only if changed), `index.html` (app dashboard, kept separate), `test.html`, `ABDM_V3_Proof.html`, `ft-report-m1.html`, `consultation.html`.

Manual steps if needed:
```
git clone https://github.com/AyurXpert/website.git C:\Users\HP\Desktop\_ws_temp
# Copy all changed HTML pages (all except exclusions above)
# home.html → _ws_temp/index.html  (only if home.html changed)
# Copy JS deps:
cp js/config/constants.js       → _ws_temp/js/config/constants.js
cp js/config/env.js             → _ws_temp/js/config/env.js
cp js/core/auth.js              → _ws_temp/js/core/auth.js
cp js/core/auditLogger.js       → _ws_temp/js/core/auditLogger.js
cp js/core/db/supabaseClient.js → _ws_temp/js/core/db/supabaseClient.js
cp js/pwa/register-sw.js        → _ws_temp/js/pwa/register-sw.js
# Copy user-guide/ subdirectory
# Copy new assets if any
git add . && git commit && git push
rm -rf _ws_temp
```

#### Files always in sync between repos
| App repo | Website repo |
|----------|-------------|
| `home.html` | `index.html` |
| `admin.html` | `admin.html` |
| `login.html` | `login.html` |
| `reception.html` | `reception.html` |
| `manifest.json` | `manifest.json` |
| `js/config/constants.js` | `js/config/constants.js` |
| `js/config/env.js` | `js/config/env.js` |
| `js/core/auth.js` | `js/core/auth.js` |
| `js/core/auditLogger.js` | `js/core/auditLogger.js` |
| `js/core/db/supabaseClient.js` | `js/core/db/supabaseClient.js` |
| `js/pwa/register-sw.js` | `js/pwa/register-sw.js` |
| `assets/icon.svg` | `assets/icon.svg` |
| `assets/` (new files) | `assets/` (copy new ones) |

- **Whenever `auth.js`, `constants.js`, `env.js`, `supabaseClient.js`, or `auditLogger.js` change in the app repo, they must be resynced to the website repo**
- The `AyurXpert-website` local folder was deleted (May 2026) — do not recreate it
- Staff Login link in home.html is **relative** (`login.html`) — works on both localhost and live

---

## Database Tables (Supabase)

### Core
| Table | Key Columns | Notes |
|-------|-------------|-------|
| `tenants` | id, name, type, tenant_code, is_active, logo_url, tagline, abdm_hiu_id, hfr_id | type CHECK: clinic/hospital/pk_center/dispensary/college/pharma/supplier/dealer/journal. `hfr_id` = ABDM Health Facility Registry ID (set after hospital does HFR registration + Bridge Linking). Used in M2 /discover routing and M3 consent `requester.facility` payload. |
| `profiles` | id, tenant_id, role, full_name, phone, status, is_active, approved_by | status: pending_approval/approved/active/rejected/suspended |
| `patients` | id, tenant_id, name, phone | UNIQUE on abha_number only (not phone — family members share phone) |
| `visits` | id, tenant_id, patient_id, doctor_id, opd_id, status, chief_complaint, token_number, is_on_request, incomplete_reason, incomplete_at | status: waiting/in_progress/completed/incomplete/cancelled |
| `bills` | id, tenant_id, patient_id, visit_id, total_amount, final_amount, registration_fee, consultation_fee, on_request_surcharge, status, bill_type, payer_type, insurance_provider, tpa_name, policy_number, pre_auth_number, pre_auth_status, pre_auth_amount, insurance_approved_amount, insurance_settled_amount, insurance_settlement_date, insurance_claim_status, non_payable_amount, co_payment_pct, pmjay_package_code, is_cashless, pmjay_mo_approved, patient_due (GENERATED) | status: pending/paid/partial/cancelled. payer_type: self_pay/insurance/pmjay/cghs/echs/esi/corporate. insurance_claim_status: not_applicable/pre_auth_pending/pre_auth_approved/submitted/settled/partial_settled/rejected. patient_due = final_amount − insurance_approved_amount (GENERATED ALWAYS AS STORED). Constraint: chk_insurance_workflow_sync enforces payer_type↔insurance_claim_status consistency. |
| `bill_items` | id, bill_id, medicine_id, quantity, price, total | |
| `prescriptions` | id, tenant_id, visit_id, patient_id, status | status: pending/dispensed |
| `prescription_items` | id, prescription_id, medicine_id, medicine_name, dosage, frequency, duration, quantity | medicine_name is TEXT (no FK) |
| `inventory` | id, tenant_id, medicine_id, stock_quantity, mrp, profit_percent, max_stock, expiry_date, inward_date, supplier_name, batch_number | low_stock = floor(max_stock/2) |

### OPD & Fees
| Table | Key Columns | Notes |
|-------|-------------|-------|
| `opds` | id, tenant_id, name, description, is_active, ncism_code | `ncism_code` links OPD to NCISM department |
| `opd_doctors` | id, opd_id, doctor_id, tenant_id, is_active_today | |
| `fee_structures` | id, tenant_id, opd_id, category, fee_type, label, amount, approval_status, is_active, created_by, approved_by_dept, approved_by_super, notes | approval_status: pending/dept_approved/active/rejected |
| `doctor_alerts` | id, tenant_id, doctor_id, visit_id, patient_name, message, is_read | |

### Medicines & Inventory
| Table | Key Columns | Notes |
|-------|-------------|-------|
| `medicines` | id, tenant_id, med_id (auto MED-0001), name, brand, unit, image_url, indications (jsonb), anupana, classical_reference, dosage_text | |
| `ayush_formulations` | id, formulation_code, name_sanskrit, name_common, ingredients (text[]), standard_dosage, dosage_unit, anupana, classical_source, publication_ref, formulation_type | RLS DISABLED. 290 rows (AFI P1+P2). formulation_type: arishta/asava/churna/ghrita/avaleha/guggul/kwatha/vati/taila |
| `formulation_indications` | formulation_id (FK), namc_code | Composite PK. RLS DISABLED. Links formulations to NAMC codes. |

### NAMASTE / Coding (all RLS DISABLED — global reference data)
| Table | Key Columns | Notes |
|-------|-------------|-------|
| `namaste_codes` | namc_id, namc_code, namc_term, namc_term_diacritical, namc_term_devanagari, short_definition, long_definition, ontology_branches, name_english, name_english_index, primary_index | 2,911 rows |
| `icd10_codes` | namc_id, icd10_code, icd10_term, block_title, chapter_name | 11,133 rows |
| `sat_terms` | t_id, sat_code, parent_id, word_sanskrit, short_definition, long_definition, reference, sat_category | 1,259 rows (SAT-A/C/F/G) |

### Consultation Notes
- `consultation_notes` — comprehensive migration fully applied May 2026 (70+ columns covering history, vitals, ashtasthana exam, assessment, diagnosis, Rx, disposition)
- Key columns: diagnosis_namc_code, diagnosis_namc_label, diagnosis_icd10_code, diagnosis_icd10_label
- `chief_complaint` lives in `visits`, NOT in consultation_notes

### IPD / NCISM (added May 2026)
| Table | Key Columns | Notes |
|-------|-------------|-------|
| `departments` | id, tenant_id, name, ncism_code, type, is_active, pg_seats_sanctioned, is_pg_dept, opd_id | NCISM 10 mandatory depts; uuid PK; RLS enabled |
| `beds` | id, tenant_id, department_id, bed_number, ward_name, bed_type, status, floor_number | status: vacant/occupied/maintenance/reserved; RLS enabled |
| `ipd_admissions` | id, tenant_id, patient_id, bed_id, department_id, admitting_doctor_id, admission_date, admitted_at, discharged_at, status, diagnosis_primary, diet_type | status: admitted/discharged/lama/transferred/deceased; FK hints: `profiles!admitting_doctor_id` |
| `pk_therapy_sessions` | id, tenant_id, patient_id, ipd_id, visit_id, therapy_name, phase, therapist_id, scheduled_date, status | phase: purvakarma/pradhanakarma/paschatkarma; status: scheduled/in_progress/completed/skipped |

**NCISM tenants config SQL** (run once — required before register.html NCISM seeding works):
```sql
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ug_intake int DEFAULT 60;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS pg_student_strength int DEFAULT 0;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS opd_daily_target int DEFAULT 120;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS working_days_per_week int DEFAULT 6;
```
- `ug_intake` — NCISM UG intake (60/100/150/200); drives `opd_daily_target = ug_intake × 2`
- register.html Step 4 seeds 10 OPDs + 13 departments + full bed matrix on registration for college/hospital types

### ABDM Tables
| Table | Notes |
|-------|-------|
| `abdm_audit_logs` | ABDM API call audit trail |
| `abdm_rate_limits` | send_otp: 3/15min; enroll_abha: 5/15min |
| `abdm_consents`, `abdm_requests`, `abdm_callbacks`, `abdm_transactions` | Consent architecture. abdm_callbacks: service_role only |
| `abdm_scan_sessions` | Scan & Share sessions. REPLICA IDENTITY FULL. RLS policies present. In supabase_realtime publication. |

### RLS
- All core tables have RLS enabled
- Policies filter by `tenant_id = (SELECT tenant_id FROM profiles WHERE id = auth.uid())`
- Anon can SELECT active tenants — requires BOTH `GRANT SELECT ON tenants TO anon` AND an RLS policy
- 400 error (not 403) from PostgREST when anon lacks table GRANT

### Supabase RPC Functions
| Function | Purpose | Access |
|----------|---------|--------|
| `get_profile_by_email(p_email text)` | Two-step login — returns role, full_name, tenant_name, tenant_type. SECURITY DEFINER. `t.type::text` cast required (ENUM). | anon |
| `get_tenant_by_code(p_code text)` | Staff signup (legacy) — returns id, name, type. SECURITY DEFINER. | anon |
| `get_departments_for_signup(p_tenant_code text)` | Returns active departments for signup dept dropdown. SECURITY DEFINER. | anon |
| `get_tenant_subscription_info(p_code text)` | Signup check — returns plan_type, subscription_status, max_users, current_user_count. SECURITY DEFINER. **Replaces `get_tenant_by_code` in registerStaff.** | anon |
| `platform_update_subscription(...)` | Platform admin updates tenant subscription. Checks `is_platform_admin = true`. SECURITY DEFINER. | authenticated |
| `abdm_rate_limit_increment` | Rate limiting for ABDM OTP/enroll calls | authenticated |

### Auto-generated tenant_code
- BEFORE INSERT trigger on tenants table — generates code from org name + random 4 digits

### Edge Functions
| Function | Notes |
|----------|-------|
| `abdm-auth` | Token caching, ABHA enrollment, OTP send/verify, rate limiting |
| `abdm-webhook` | Receives ABDM callbacks (JWT disabled), Scan & Share on-share handler |
| `receipt-ocr` | AI receipt OCR via Claude Haiku — **PENDING DEPLOYMENT** (needs ANTHROPIC_API_KEY) |

---

## Roles & Routing
```js
ROLES: super_admin, dept_admin, doctor, receptionist, pharmacist, nurse, lab_tech,
       accountant, cashier, finance_manager, therapist, student, public

ROLE_HOME:
  super_admin      → admin.html
  dept_admin       → admin.html
  doctor           → doctor.html
  receptionist     → reception.html
  pharmacist       → dispensaryPOS.html
  nurse            → reception.html
  lab_tech         → reports.html
  accountant       → finance.html
  cashier          → finance.html  (dedicated cashier.html deferred — see memory/deferred_cashier_landing.md)
  finance_manager  → finance.html
  therapist        → therapist.html
  student          → index.html
```

**Finance role tab access:**
- `receptionist` → Insurance Cycles only
- `cashier` → Revenue Tracking + Insurance Cycles (no Expenses)
- `accountant` → all 3 tabs
- `finance_manager` → all 3 tabs + write-off approve/reject in insurance-claims.html

- `super_admin` bypasses `allowedRoles` check in `requireAuth()` — can access any protected page
- auth.js: `if (role !== ROLES.SUPER_ADMIN && !allowedRoles.includes(role))`

---

## Files — Current State

### Built & Working
| File | Notes |
|------|-------|
| `login.html` | Two-step login (email → role card → password), tenant branding via ?t=CODE. Step 1 calls `get_profile_by_email` RPC — unregistered emails blocked before password page with "not registered" message. Email format validated before RPC call. |
| `register.html` | Organisation registration, NCISM seeding via `seed_ncism_data` RPC |
| `signup.html` | Staff join-org flow, pending approval |
| `index.html` | Role-based dashboard, admin approvals, tenant code display |
| `admin.html` | Super Admin / Dept Admin dashboard. 7 sidebar sections: Statistics · Accounts (Financial) · Human Resources · Departments · OPD Management · Settings · Subscription. **Accounts section** (Session 65): 5 KPI cards (Revenue Today, This Month, Self-Pay Pending, Insurance Claims, Outstanding >30d), Revenue Breakdown table (OPD/IPD + Self-Pay/Insurance split), Pending Bills table with payer type chips, insurance approved/patient_due columns, claim status badges. **HR → Login Access tab** (Session 65): staff approval management moved here (4th sub-tab). **Session 69:** Icon-rail sidebar — 52px strip of icons always visible on left; hover expands to 248px showing org name + group labels + item labels; mouse-leave collapses; `margin-left:52px` on content so rail never covers content; sidebar is a direct `<body>` child (not inside `admin-shell`) to avoid `display:none` hiding it. Hash routing: `admin.html#stats` auto-activates that section. |
| `reception.html` | Phone search, family member picker, ABHA enrollment + all 4 verify flows (Aadhaar/ABHA Number/ABHA Address/Mobile), Scan & Share QR, OPD-ready, single bill, payment confirmation, live queue. **OPD dropdown always locked** — new patient auto-routes to Screening OPD; returning patient auto-fills previous specialty OPD + doctor (locked). Category change OPD↔followup handled by `_applyOpdRule`. `_prevOpdId`/`_prevDoctorId` stored on patient select. |
| `doctor.html` | Full 9-tab clinical flow. NAMASTE dual-coding. Classical Rx suggestions. Lab ordering (🧪) + imaging ordering (📡). MHA flag + consent. ADR reporting. Mobile fixed. |
| `dispensaryPOS.html` | Prescription queue (real-time), dispensing, stock deduction, billing, invoice print |
| `fee-admin.html` | Fee Structure admin (dept_admin / super_admin only). Approval workflow: pending → dept_approved → active. |
| `finance.html` | Finance home. 3-group nested layout: 💵 Revenue Tracking (KPI cards, Revenue Breakdown, Pending Bills) · 🏥 Insurance Cycles (Claims Register + Pre-Auth Queue with full 16-field edit modal) · 📊 Expenses & Audits (quick-links to purchase/supplier/disposal). **Role-based tab access (Session 67):** receptionist=Insurance only · cashier=Revenue+Insurance · accountant/finance_manager=all 3. |
| `insurance-claims.html` | **NEW (Session 66)** Phase 3 Insurance Claims Register. 4 tabs: Active Claims (age-banded table, edit modal) · TPA Settlement (provider cards + per-provider table) · PMJAY Codes (17 AYUSH HBP 2.0 codes, assign to claim) · Aging & Write-offs (colour-coded 0-30/31-60/61-90/>90d buckets + Bad Debt Register). Write-off approve/reject: `super_admin` + `finance_manager`. `trg_write_off_approval` trigger clears patient_due. |
| `user-guide/finance.html` | **NEW (Session 66)** Standalone financial management user guide. 10 sections: role matrix, fee setup, OPD billing (4 payer types), pharmacy, IPD discharge, Finance Dashboard, Insurance Claims Register, technical reference, 4 end-to-end scenarios, troubleshooting. Print-friendly, no auth needed. **Session 68:** cashier + finance_manager rows added to §1.2 Role Matrix + §6.1 access table + §7.4 write-off note updated. |
| `js/pages/login.js` | **NEW (Session 73)** Extracted login page JS module — tenant branding IIFE, two-step login (handleContinue + handleLogin), password toggle, alert helpers. Extracted from login.html to fix WASA CSP finding (unsafe-inline). Import paths: `../core/auth.js`, `../core/db/supabaseClient.js`. |
| `user-guide/ABDM_M1M2M3_Summary.html` | **NEW (Session 73)** Print-to-PDF summary of M1/M2/M3 for FT agency meetings. App overview, tech stack grid, all test cases (PASS), architecture steps, WASA status note. No auth needed. |
| `user-guide/ABDM_FT_Agency_MeetingKit.html` | **NEW (Session 67)** Universal FT/WASA agency meeting reference. Sticky sidebar menu — all topics clickable: App overview, tech stack, SBXID/IDs, test credentials, M1/M2/M3 details, self-test evidence (15 TCs all PASS), HMS modules table, WASA status, questions to ask, opening statement, all 9 agency contacts + quote comparison. No auth needed. |
| `reports.html` | Role-based: accountant billing dashboard |
| `opd-admin.html` | Manage OPDs, assign doctors, toggle active/inactive, NCISM code seeding (10 mandatory OPDs), specialty clinic dropdown |
| `bed-admin.html` | NCISM dept + bed matrix: seed 10 mandatory depts, bulk bed creation, visual colour-coded bed grid. **Session 68:** NCISM Table-8 bed compliance per dept card. **Session 72:** ⚡ Quick Setup 2-table physical inventory + proportional NCISM allocation. **Session 74:** Building & Floor Breakdown cards; dept sort by NCISM beds desc; Table 2 Building Sources all-floor fix; `_computeBlockAllocation` block-first + `_blkRemOffset` → exact 30:30. **Session 75:** Bed Matrix filter fix (`window.renderBeds` global exposure); vivid status colours + status pill on every card. User guide: `user-guide/bed-admin.html` (app repo only). |
| `ipd.html` | IPD admission + discharge + MLC tagging, 2-step bed picker, bed status auto-sync, Ward Round Notes, OT procedures |
| `therapist.html` | PK therapy scheduling + completion, phase badges (Purva/Pradhana/Paschatkarma), NCISM 2M+2F therapist alert |
| `ncism-compliance.html` | NCISM compliance monitor: institution OPD (1:2 ratio), UG Table-8 bed ratios, 60%/80% occupancy thresholds, 10-col table; CSV export |
| `roster.html` | 24×7 Duty Roster (§18h/18i): weekly 7-day × 3-shift grid per dept, on-call specialist section, gap detection banner |
| `palha-diet.html` | Palha-Diet Centre (§18bb): today's indent queue, status workflow, SOP panel, realtime updates |
| `formulary-admin.html` | Hospital Formulary (§18as): full CRUD, category filter, review-date traffic-light, CSV export, Import from Inventory |
| `screening.html` | NCISM Screening OPD: triage (Emergency/Urgent/Semi-urgent/Routine), vitals, route patient |
| `user-manual.html` | Full HMS user manual, sidebar nav, all role workflows, troubleshooting table |
| `inventory.html` | Medicine master: Med ID auto, image upload, pricing calc, NAMC indications, expiry/inward, GMP✓ flag, CSV import/export. **Session 24:** student batch flag (§18av) + 🎓 Practical Use action, reason dropdown in adjust stock, disposal logging |
| `purchase-order.html` | Auto-generate PO from low stock, grouped by supplier, CSV export, print |
| `purchase.html` | Full GRN: supplier dropdown (from suppliers table) with GMP status card, block on expired cert (super_admin override), line items, batch/expiry, barcode scan, AI receipt OCR |
| `lab.html` | Diagnostics (4-tab): Pathology Lab (60+ tests, sample collection, critical alerts) + Radiology & Imaging + AERB Log + PCPNDT Register. **Session 24:** Ayurvedic interpretation field + PG Roganidana signatory (§18ay) |
| `nursing.html` | IPD Nursing (5-tab): Vitals Chart + MAR + Intake-Output + Nursing Notes + Shift Handover |
| `emergency.html` | Emergency OPD (4-tab): Case Register + RMO Duty Log + Observation Beds + MLC Register (§4.6) |
| `labour-room.html` | Labour Room (4-tab): Delivery Register + New Delivery (APGAR) + Partograph + Newborn Register (§8.9) |
| `anushastra.html` | Anushastra Karma (§47(c)): Agnikarma · Raktamokshana · Ksharakarma · Pain Management |
| `pharmacovigilance.html` | PV Cell Meeting Register (§48): bimonthly compliance banner, 10-member checklist, ADR review, report submission |
| `iqac.html` | IQAC Meeting Register (§12.1): quarterly compliance banner, live QI pull, 14-member checklist, action items table |
| `nabh-kpi.html` | **NEW (Session 35)** NABH KPI Dashboard — 22 KPIs (hospital) / 5 KPIs (ATWC); 13 auto-computed, 9 manual entry; color-coded cards, alert banner, month selector, PDF export; PSQ.3 CORE |
| `bmw.html` | BMW Management (§10.4, BMW Rules 2016): 4-tab — Daily Log, CBWTF Pickup, Autoclave/Treatment, Monthly SPCB Summary |
| `sterilisation.html` | CSSD / Sterilisation Log (§13): 3-tab — Cycle Log (CI/BI indicators), BI Testing (weekly compliance), Equipment Register |
| `dept-hub.html` | Department Hub — grouped module links per NCISM dept |
| `tele-schedule.html` | **NEW** Doctor Teleconsultation Schedule (§18ao): weekly availability grid, auto-Jitsi rooms, today's tele queue |
| `disposal-register.html` | **NEW** Expiry Medicine Disposal Register (§18aw, NCISM §6(5)): filterable log, CSV export, print-ready |
| `suppliers.html` | **NEW** GMP Supplier Register (§18au-full, NCISM §6(3)): CRUD, GMP traffic-light expiry, CSV export |
| `subscription.html` | **NEW** Platform Admin Subscription Management: list all tenants, edit plan/status/expiry/max_users (is_platform_admin gated) |
| `major-ot.html` | Major OT Register — scheduling, pre-op checklist, intra-op notes, OT logbook, surgeon assignment |
| `minor-ot.html` | Minor OT Procedure Record (SHAL dept) — procedure log, pre/post op |
| `ksharasutra.html` | Kshara Sutra weekly scheduler — thread tracking, weekly change log, session history (§18o) |
| `anc.html` | ANC Multi-visit Register (§18x) — risk auto-detection, vitals, FHR, print ANC card |
| `kriyakalpa.html` | Kriya Kalpa session tracker (§18s/§18u) — Netra + ENT dept tabs, complete/cancel workflow |
| `dpc.html` | Drug Procurement Committee register (§18at) — meeting record, decisions log, print minutes |
| `teaching-opd.html` | Teaching OPD case presentation register (§18k) — PG presenter, faculty rating, date nav. **Session 32:** Bedside Clinics section added (§21l) |
| `physiotherapy.html` | **NEW (Session 32)** §21m Physiotherapy Section — patient register, session log, today's queue, referral tracking, history with CSV export (`physiotherapy_sessions` table) |
| `printPrescription.html` | Reads tenant from sessionStorage, doctor name from profiles |
| `printInvoice.html` | Fixed gstAmount bug; feedback URL printed at footer |
| `feedback.html` | Public patient satisfaction form (`?visit=UUID`); 5 star categories; feeds quality.html Patient Feedback tab |
| `home.html` | Live on ayurxpert.com (redesigned May 2026) |
| `privacy.html`, `terms.html` | DPDPA 2023 compliant |
| `offline.html`, `manifest.json`, `sw.js` | PWA |

### Needs Work / Obsolete
| File | Status |
|------|--------|
| `consultation.html` | ⚠️ Old prototype — superseded by doctor.html. Hardcoded clinic name, missing initNavbar() |

---

## JS Modules
```
js/
  config/constants.js        — roles, ROLE_HOME, PUBLIC_PAGES, SESSION_KEYS
  core/auth.js               — login, logout, requireAuth (super_admin bypass)
  core/db/supabaseClient.js
  components/navbar.js       — initNavbar(), org type + code subtitle, "Powered by AyurXpert" watermark. **Session 69:** `_injectAdminSidebarOverlay()` auto-injects 52px icon-rail sidebar on all super_admin/dept_admin pages except admin.html. Rail has same icons as admin.html sidebar; hover expands to 256px with labels; links go to `admin.html#section` or direct page URLs.
  modules/abdm/abdmService.js — ABHA enrollment, all 4 verify flows (Aadhaar/Number/Address/Mobile), error map (17 codes), RSA-OAEP SHA-1
  modules/billing/billingService.js
  modules/patient/patientService.js
  modules/visit/visitService.js
  pwa/register-sw.js
```

---

## Key Decisions

- **No framework** — plain HTML/CSS/JS; no build step; works on GitHub Pages
- **Multi-tenant via RLS** — all tables have tenant_id; Supabase RLS isolates data
- **Bill created exactly once** — includes visit_id, registration_fee, consultation_fee, on_request_surcharge, bill_type
- **Fee approval**: Accountant creates (pending) → Dept Admin (dept_approved) → Super Admin (active). Super Admin can bypass dept approval.
- **SW strategy**: JS/CSS network-first; images/fonts cache-first
- **Two-step login**: email → format validation → `get_profile_by_email` RPC (unregistered = blocked with message) → password page. Role card shows email only (not name/role) to minimise data disclosure.
- **Family members**: multiple patients share phone number (no UNIQUE on phone); picker shows up to 6 matches
- **Anon tenants access**: requires both `GRANT SELECT ON tenants TO anon` AND RLS policy
- **ABDM encryption**: RSA_PKCS1_OAEP_PADDING + oaepHash:'sha1' (NOT PKCS1 v1.5)
- **QR code**: use qrcodejs/1.0.0 (cdnjs) — browser-native, creates canvas inside `<div>`. Do NOT use node-qrcode in browser.
- **Scan & Share realtime**: abdm_scan_sessions needs REPLICA IDENTITY FULL + supabase_realtime publication + RLS policies
- **NAMASTE dual-coding**: namc_term ILIKE primary; name_english_index ILIKE fallback. ENG_TO_NAMC dictionary maps English→Sanskrit terms.
- **Classical Rx suggestions**: green cards (pharmacy inventory tagged with NAMC) + gold cards (ayush_formulations via formulation_indications)
- **home.html**: does NOT reveal tech architecture or feature details — general description + ABDM commitment only
- **ABDM login verify flows** (official ABDM v3, confirmed working):
  - ABHA Number → `POST /profile/login/request/otp` `otpSystem:'aadhaar'` `scope:['abha-login','aadhaar-verify']`
  - ABHA Address → `POST /phr/web/login/abha/request/otp` `otpSystem:'abdm'` `scope:['abha-address-login','mobile-verify']` → verify at `/phr/web/login/abha/verify` → profile at `GET /phr/web/login/profile/abha-profile`
  - Mobile → `POST /profile/login/request/otp` `loginHint:'mobile'` `scope:['abha-login','mobile-verify']` → verify returns `accounts[]` list (no search step)
  - Verify scope must always match the request scope

---

## Known Issues / Bugs

1. **consultation.html** — stray `console.log`, hardcoded clinic name, missing initNavbar() (old prototype, superseded by doctor.html — low priority)
2. **receipt-ocr Edge Function** — not deployed (needs ANTHROPIC_API_KEY purchase)

---

## ABDM Status (as of 25 June 2026)

| Module | Status |
|--------|--------|
| M1 | Sandbox ✅ → Production REJECTED — needs WASA cert + FT cert + re-upload to portal |
| M2 | ✅ ALL PASS (Sessions 60–62) — HIP-Init 501–506, User-Init 601–607, SMS notify, 606/607 data push |
| M3 | ✅ ALL PASS (Session 59) — HIU_FLOW_102/104/106/107–113/202 |

- **SBXID**: SBXID_033899 | **ABHA (sandbox)**: 91260474441201 / venkateshas031975@sbx
- **WASA**: SecureNexGen LLP — deadline 30 June 2026. On receipt: upload 4 docs to portal → M1 production approval.
- **FT**: Suma Soft onboarding was Mon 29 June. Avasure quote: Rs. 1,68,000 / 10 days. Select agency → FT report (~9 Jul) → NHA HTC.
- **Bridge URL**: `https://xvlvifiebafvgzlixdee.supabase.co/functions/v1/abdm-webhook`
- **Cloudflare**: Transform Rule active ✅ (CSP, X-Frame-Options: DENY on all role-home pages)
- **DHIS**: After M1 production approval → register as DSC with NHA (25% of tenant DHIS earnings)
- **abdm-webhook JWT**: permanently OFF (`verify_jwt = false` in `supabase/config.toml`)
- ⚠️ **Reyna ABHA strike 2/3** — do NOT call generate_link_token for 91367365472870@sbx. Use venkateshas031975@sbx.

> Full Postman envs, WASA tenant credentials, M2/M3 test table, Fidelius quirk, HIU URLs → see memory: `abdm_technical.md`, `wasa_tenant.md`

---

## START NEXT SESSION HERE

### SESSION 77 — NCISM HMS roles + FT agency WO + M1/M2/M3 rerun + WASA email

> ⚠️ Priority order: (1) NCISM roles → (2) WASA email → (3) FT agency WO → (4) M1/M2/M3 rerun → (5) HMS Walkthrough

1. **🔴 NCISM HMS staff roles** — Audit all NCISM-required HMS staff roles not yet in the system; build their landing/role pages. HMS only (no CMS/academic). Once ALL role pages are live → send WASA email to Vamsi.
2. **WASA email — send after NCISM roles deployed** — Draft is in TODO_LATER.md §36. Vamsi: vamsi@securenexgen.in. What's fixed: login.html `<style>` → `css/login.css`; zero `unsafe-inline` in login.html; Lucky13 compensating control noted.
3. **FT agency selection** — Oxygen Consulting (Sachin) quote was due 2–3 Jul; check if received. Nangia still cheapest at Rs. 90,000 + GST. Confirm Suma Soft quote from 1 Jul meeting. Send WO + advance to winner AFTER M1/M2/M3 rerun passes.
4. **⚠️ M1/M2/M3 RERUN** — Mandatory before sending WO. Use `venkateshas031975@sbx` / ABHA `91260474441201`. ⚠️ NOT `91367365472870@sbx` (Reyna — strike 2/3). See checklist below.
5. **HMS Walkthrough Module 3 remaining** — Infrastructure · Packages · Feature Modules · ABDM Bridge · Subscription.
6. **HMS Walkthrough Module 4 (reception.html)** — test OPD auto-routing with WASA tenant.

> **Hard-refresh needed on first load** — sw.js bumped to v7 this session. Open admin.html and press Ctrl+Shift+R once to activate the new service worker and clear the old CSP.

### ⚠️ M1/M2/M3 RERUN CHECKLIST — MANDATORY BEFORE FT KICKOFF

**Why:** The `get_cert` bug (ABDM cert endpoint 401) was fixed on 1 Jul 2026. This affected ALL RSA encryption steps — ABHA enrollment, verify flows, OTP sends. Run all flows on sandbox BEFORE giving the FT agency the go-ahead, so no surprises during the official test.

**Use sandbox credentials:** `venkateshas031975@sbx` / ABHA `91260474441201`. ⚠️ Do NOT use `91367365472870@sbx` (Reyna — strike 2/3).

#### M1 — ABHA Enrollment & Verification (reception.html)
- [ ] **CRT_ABHA_101** — New ABHA creation via Aadhaar OTP
- [ ] **CRT_ABHA_109** — Comm mobile differs from Aadhaar mobile (2nd OTP flow)
- [ ] **VRFY_ABHA_201** — Verify via ABHA Number + Aadhaar OTP
- [ ] **VRFY_ABHA_301** — Verify via Aadhaar number OTP
- [ ] **VRFY_ABHA_401** — Verify via ABHA Address OTP
- [ ] **VRFY_ABHA_501** — Verify via Mobile OTP
- [ ] **Scan & Share** — QR scan session → patient demographics returned

#### M2 — HIP Linking (Postman + reception.html)
- [ ] **HIP_INTI_LINK_501–506** — HIP-initiated demographic auth + link token flow
- [ ] **USER_INIT_LINK_601–607** — User-initiated deep linking + care context add
- [ ] **SMS notify** — `sms/notify2` callback received

#### M3 — HIU Consent Flow (Postman + doctor.html)
- [ ] **HIU_FLOW_102** — Consent request raised
- [ ] **HIU_FLOW_104** — Consent granted callback received
- [ ] **HIU_FLOW_106** — Health data fetch triggered
- [ ] **HIU_FLOW_107–113** — Data push received + processed
- [ ] **HIU_FLOW_202** — Consent revoke handled

**All PASS → send WO to FT agency. Any FAIL → fix first, then send WO.**

**HMS Walkthrough progress**: Module 1 ✅ · Module 2 ✅ · Module 3: Statistics ✅ · Accounts ✅ · HR ✅ · Departments ✅ · OPD Management ✅ · Infrastructure/Packages/Feature Modules/ABDM Bridge/Subscription pending · Module 4 (reception.html) pending.

**FT Quote Summary (as of 1 Jul 2026):**
| Agency | FT Base | FT + GST | Timeline | Status |
|--------|---------|----------|----------|--------|
| **Nangia** | **Rs. 90,000** | **Rs. 1,06,200** | ⚠️ TBD — ask Asif 7977505911 | CHEAPEST |
| Oxygen Consulting | TBD | TBD | TBD | ⏳ Quote in 1–2 days (Sachin met 1 Jul) |
| Code Decode | Rs. 1,00,000 | Rs. 1,18,000 | 10–12 days ⚠️ | Wrong name; timeline exceeds NHA limit |
| Avasure | Rs. 1,32,000 | Rs. 1,55,760 | 8–9 days ⚠️ | Clarify calendar vs working days |
| Suma Soft | TBD | TBD | ~7 days | ⏳ Quote from 1 Jul meeting |

**Session 76 ✅ COMPLETE (2 July 2026):**
- **login.html CSS extraction (WASA remediation)**: extracted `<style>` block → `css/login.css`; removed `style-src 'unsafe-inline'` from meta CSP; 6 inline `style=""` attributes converted to CSS classes. login.html now has zero `unsafe-inline` anywhere. Evidence ready for Vamsi (SecureNexGen) re-assessment.
- **admin.html HR — NCISM Schedule XX + Schedule I staffing compliance panel (5 new commits):**
  - **NCISM Requirements sub-tab**: full compliance panel — 15 zone accordions (Administration, Teaching Faculty, Clinical, Nursing, Pharmacy, Therapy, Diagnostics, Allied Health, Wellness, Admin & MRD, Housekeeping, Security, Infrastructure, Finance & Accounts, PG Departments). Each zone: designation rows with ref, UG required, PG additional, total, actual pool, status, gap.
  - **Summary table**: 9 group rows (Medical Director/MS/DMS · Faculty · Residents · Nursing · Pharmacy · Therapy · Diagnostics · Admin Staff · Support & Finance) with UG req + PG additional + total + recruited + gap columns.
  - **Grand total row**: GRAND TOTAL across all NCISM-mandated positions with % compliance and gap badge.
  - **Finance & Accounts zone**: Accountant / Cashier / Billing Clerk / MR Officer / Billing Supervisor (cross-zone totals for shared designations like RMO, Staff Nurse, Ayah handled via `NCISM_SUM_GRPS` — no double-counting).
- **admin.html HR — 🏥 Dept. Staff Distribution tab** (5th HR sub-tab): dept-wise staff hierarchy cards; Dept Admin + HoD + Faculty + Sr/Jr Residents + Interns per dept; amber intern chips; red ⚠️ No Interns badge for clinical depts without interns; stat bar (Active / Dept Assigned / Faculty / Interns); intern banner if total interns < UG intake; Unassigned Staff section at bottom.
- **Bug fixes (admin.html HR):**
  - `departments` query: removed `type` column (PostgreSQL keyword → PostgREST 400) and `.order('ncism_code')` (nullable column → 400); sort done in JS instead.
  - NCISM accordion: removed `onclick="..."` inline handlers; replaced with `ncism-toggle` class + programmatic delegated `addEventListener` with `_ncismClickBound` guard — no inline-handler CSP uncertainty, no listener stacking.
  - Hierarchy View tab: `_hrSub('hierarchy')` now calls `renderHierarchy(window._staffAll)` if data loaded, else `window.loadHR('hierarchy')` to fetch+render. Previously the panel showed but stayed empty.
  - NCISM accordion CSS: moved from dynamic JS injection to static `<style>` block in `<head>` — fixes display timing issues.
- **sw.js — CSP fix (v7)**: SW-injected `Content-Security-Policy` header now includes `ws://127.0.0.1:* http://127.0.0.1:* ws://localhost:* http://localhost:*` in both `default-src` and `connect-src`. Root cause of 9 CSP violations: browsers enforce ALL active CSPs (SW HTTP header + meta tag) — adding to meta tag alone was insufficient. Cache bumped v6 → v7. **Action needed on first next load: Ctrl+Shift+R hard refresh to activate new SW.**

**Session 75 ✅ COMPLETE (1 July 2026):**
- **bed-admin.html — Bed Matrix filter bug fixed**: `renderBeds()` was module-scoped — `onchange="renderBeds()"` HTML attributes need global scope. Added `window.renderBeds = renderBeds` after function definition. All 3 filter dropdowns (Dept / Status / Type) now work correctly on both localhost and live site.
- **bed-admin.html — Vivid status colour coding**: strengthened card background+border colours (vacant green / occupied red / maintenance grey / reserved gold); added solid coloured status pill inside every card (VACANT / OCCUPIED / MAINTENANCE / RESERVED) for instant visual identification. Removed erroneous `pk_treatment` statusCls special-case (type ≠ status).
- **user-guide/bed-admin.html — NEW**: 11-section comprehensive user guide covering UI workflow + technical reference. App repo only — NOT synced to website repo. Sections: overview + role matrix, stats dashboard, departments tab, bed management, bed matrix, Quick Setup, Bed Map PDF, NCISM Table-8 reference, DB schema + RLS + constraints + localStorage + function registry, 4 end-to-end scenarios, 12-entry troubleshooting table.
- **CRITICAL BUG FIX — abdm-auth Edge Function `get_cert` 401**: ABDM sandbox `/profile/public/certificate` started returning 401 without auth. Caused ABHA enrollment to fail at RSA encryption step (500 from Edge Function). Fixed: pass `abhaHeaders(token)` to cert fetch + cache-bust retry on 401. Deployed immediately during Oxygen Consulting FT demo with Sachin (1 Jul 2026). Enrollment confirmed working after fix.
- **Oxygen Consulting FT meeting (Sachin, 1 Jul 2026)**: App demo done. ABHA enrollment demonstrated successfully after cert fix. Quote expected in 1–2 days (by 2–3 Jul 2026).
- **⚠️ M1/M2/M3 rerun checklist added** — must complete all test cases on sandbox before sending WO to FT agency.

**Session 74 ✅ COMPLETE (1 July 2026):**
- **bed-admin.html — Building & Floor Summary (page + PDF):**
  - **Building & Floor Breakdown** added below stat cards: grid of cards (same style as stat cards, responsive); each card = one building block; per-floor rows with color-coded status chips (🟢 vacant / 🔴 occupied / 🟡 maintenance / 🟠 reserved + count). Reads from `_beds` (Supabase) — updates live after bed creation.
  - **PDF cover page Building & Floor Allocation table**: building × floor breakdown with dept list; added via `pdfBldgTable` computed from `_beds` before `_x` helper. Template literal safety: uses array-join + `_x()` to avoid `</xxx>` in script source.
- **bed-admin.html — Department sort**: Departments tab cards now sorted by NCISM required beds descending (Panchakarma 15 → Kayachikitsa 12 → Shalya 12 → … → non-NCISM depts last A-Z). One-line sort using `UG_BED_RATIOS[ncism_code] × _ugIntake`.
- **bed-admin.html — Table 2 Building Sources column fixed**: was showing GF for all rows because `_qs1Sources` picked one dominant floor per block. **Rewritten** to return `floorMap` (floor → bed count) and render all floors: `Main Building F1 GF (23) · Fl.1 (7)`. Same fix applied to done-rows (reads from actual `deptBeds` ward_name + floor_number).
- **bed-admin.html — Table 1 Rooms/Wards column fixed**: was hiding per-block breakdown when only one block had beds for a type (Male General = F1 only, Female General = F2 only → both showed "1 ward" with no building name). Fixed: show breakdown whenever `_qs1Blocks.length > 1`, not just when `breakdown.length > 1`.
- **bed-admin.html — Floor inputs now live**: added `oninput="_qs1SaveValues();_qs1UpdateTotals()"` on floor inputs — changing a floor value immediately persists to localStorage AND updates the Rooms/Wards column.
- **bed-admin.html — `quickSetupCreateRow` floor fix**: was picking dominant floor per block (type with most beds). Fixed to use **per-type floor** from Table 1 — each bed is inserted with the exact floor configured for its bed type in its block.
- **bed-admin.html — `_computeBlockAllocation` rewrite (block-first)**: old type-first algorithm accumulated F1 remainder bias (38 vs 22 instead of 30 vs 30). New algorithm: (1) compute target beds per block proportional to pool size → 30:30; (2) distribute types within each block proportional to that block's type mix. Added `_blkRemOffset` rotating counter to alternate remainder direction across depts → **exact 30+30 achieved**.

**Session 73 ✅ COMPLETE (29–30 June 2026):**
- **WASA remediation — SecureNexGen re-assessment findings fixed:**
  - **TLS 1.2 minimum**: Cloudflare Minimum TLS Version set to 1.2. Eliminates TLS 1.0/1.1, BEAST, SWEET32, 3DES.
  - **CSP unsafe-inline fix (login.html)**: extracted 177-line inline `<script type="module">` → `js/pages/login.js`; import paths corrected (`./js/core/` → `../core/`); removed `'unsafe-inline'` from meta CSP `script-src`; removed redundant framebusting inline script (superseded by `frame-ancestors 'none'` + X-Frame-Options: DENY).
  - **Cloudflare Transform Rule**: Rule 1 = WASA Security Headers (all requests); Rule 2 = Login Strict (/login.html only, no unsafe-inline in script-src). Strict rule runs last → wins for login.html. Confirmed via DevTools.
  - **Evidence sent to Vamsi (SecureNexGen)** — 3 screenshots attached. Awaiting Safe-to-Host cert.
  - ⚠️ `unsafe-inline` kept in `style-src` only (required for inline `style=""` attributes — safe)
- **New files**: `js/pages/login.js` (175 lines, extracted login JS module); `user-guide/ABDM_M1M2M3_Summary.html` (print-to-PDF for FT agency meetings)
- **FT agency quotes received and compared (30 Jun):**
  - Nangia (30 Jun itemised): WASA Rs. 60,000 / FT Complete Rs. 90,000 / FT per-milestone Rs. 40,000 each (don't use — 3×Rs.40k=Rs.1,20,000). Original 25 Jun bundled WASA+FT = Rs. 1,20,000. **FT only = Rs. 1,06,200 with GST.**
  - Code Decode (30 Jun proposal): FT Rs. 1,00,000 + GST = Rs. 1,18,000; WASA Rs. 85,500 + GST = Rs. 1,00,890; 10–12 days ⚠️ (exceeds NHA 7-day limit); wrong name "AyurExpert Technologies, Pune" in proposal; requires Indemnity Bond + LoA; 10% discount only if both POs together (not applicable)
  - Avasure (updated 30 Jun): Original bundled Rs. 1,68,000. Updated itemised: Integration Consulting Rs. 90,000 (skip) + FT Rs. 1,32,000 + GST = **Rs. 1,55,760 total**; 8–9 days ⚠️; clarify calendar vs working days; 50% advance + 50% completion; quote expires ~15 Jul
  - Suma Soft: meeting rescheduled to 1 Jul 11 AM
- **ABDM_FT_Agency_MeetingKit.html updated**: Nangia full 2-quote breakdown + payment schedule; Avasure full 2-quote breakdown; Code Decode full proposal with all 3 red flags; comparison table with all 4 agencies + WASA + bundle quotes + GST columns
- **WASA re-assessment risk (decided 30 Jun):** New modules added after SecureNexGen assessment (June 2) — decision: do NOT inform Vamsi. SecureNexGen cert covers `ayurxpert.com` as a whole domain, not a page list. NHA checks cert validity and 0 Critical/High findings — not which modules existed at assessment date. New modules use same auth/RLS/HTTPS/CSP stack. Only revisit if NHA explicitly rejects with a scope objection (unlikely).

**Session 72 ✅ COMPLETE (28 June 2026):**
- bed-admin.html ⚡ Quick Setup tab — complete redesign:
  - **Two-table approach**: Table 1 (Physical Inventory) + Table 2 (NCISM Allocation)
  - **Table 1**: Admin enters existing beds by type (rows) × building block/floor (columns). Dynamic — add/remove bed types and building blocks. Saves to localStorage per tenant. Grand total validated against NCISM minimum (UG + PG beds).
  - **Table 2**: Auto-populated by clicking "↓ Auto-Distribute to Departments". Pure proportional distribution from Table 1 pool — no dept-specific overrides; every dept gets the same mix proportional to inventory. PG departments show UG + PG required separately. Editable cells with live row-total validation (green ✓ / red ⚠). Create All validates all row totals before inserting.
  - **Bed number assignment**: sequential within NCISM reserved range, grouped by type in Table 1 order.
  - **All 12 bed types** pre-loaded in Table 1: Male General, Female General, General Mixed, Twin Sharing, Shared Private, Private, Deluxe, Dormitory, ICU, Day Care, PK Treatment, Observation.
  - **Capacity tooltip** (hover ℹ badge): each bed type shows occupancy — e.g. "2 patients per room" for Twin Sharing, "1 patient per bay" for ICU, "4–8 patients per ward" for General Ward.
  - **Focus notification bar**: clicking a bed count cell → "✏ Entering: [Type] — [Block]"; clicking floor cell → "📍 Floor for [Type] — [Block] (0=Ground…)"; placeholder changes to "Count" or "Floor #".
  - **Floor sub-column per building block**: two-row header — block name spans "Beds" + "Floor" sub-columns. Floor input (gold focus, width 46px, placeholder "GF"). Saves `typeKey|blockId|fl` key to localStorage alongside bed count.
  - **Rooms / Wards column with per-block breakdown**: single block → total only; multiple blocks with beds → shows "F1: 1 room · GF / F2: 1 room · Fl.1" breakdown using last word of block label as short ID. Empty floor input defaults to GF (0). Ward/hall types = 1 per block; twin sharing ÷ 2; private/ICU/PK = 1 per bed.
  - **`QS1_TYPES_VERSION = 'v2'`** version stamp in localStorage — resets stale 6-type saved state automatically.
  - **Bug fixed**: duplicate `function renderQuickSetup()` declaration caused SyntaxError crashing entire page JS (blank "Loading departments…"). Removed stale 151-line copy.
- bed-admin.html Dept Cards — **Delete All Beds** button (`🗑 All Beds`, red outline, appears only when dept has beds): batch-deletes all non-occupied beds in one Supabase query (`.neq('status','occupied')`); occupied beds skipped with warning; department record retained. Confirm dialog explicitly states dept is kept.
- navbar.js — **sidebar content overlap fix**: `_injectAdminSidebarOverlay()` now adds `document.body.style.paddingLeft = '52px'` after injecting the rail, so content on all overlay pages (bed-admin, opd-admin, fee-admin, finance, etc.) is never hidden behind the 52px icon strip.
- bed-admin.html ⚡ Quick Setup **Table 2 (NCISM Allocation) — building + floor improvements**:
  - **Three helper functions added**: `_qs1DominantFloor(dist)` (weighted dominant floor from Table 1 pool), `_qs1Sources(dist)` (block names + floors contributing to each dept), `_qs1TypeBlockHints(activeCols,pool)` (per-block bed counts per type), `_qs1UniqueFloors()` (unique floor numbers in Table 1 where beds exist)
  - **Two-row header in Table 2**: type column names in row 1 (rowspan 2 for dept/required/total/ward/sources/floor/create); per-type sub-row shows which blocks + floors hold that type's pool — e.g. "F1(GF):10 · F2(Fl.2):5"
  - **Building Sources column**: per dept row, shows all contributing blocks and their dominant floor — e.g. "Main Building F1 · GF / Main Building F2 · Fl.2" (read-only, derived from Table 1)
  - **Floor select dropdown** (replaces number input): options built from `_qs1UniqueFloors()` — shows "GF / Floor 1 / Floor 2" labels (not raw numbers); dominant floor auto-selected based on weighted bed count from pool; user can override before Create
  - **Department column sticky**: `position:sticky;left:0` on header th (rowspan 2) and all body td variants (active/done/no-dept rows) so dept name stays visible when scrolling the wide table horizontally. Background matches row state (white / #f0faf5 for done rows).
- **Live vs localhost verification (28 June 2026)**: Compared ayurxpert.com/bed-admin.html vs localhost — no bugs. Differences are expected: (1) localStorage is domain-scoped so bed inventory saved on localhost does NOT appear on live site — each hospital admin enters their own data on the live site; (2) live site shows mobile/hamburger navbar when browser window is narrow; (3) watermark appears mid-page in full-page screenshots because it is `position:fixed` to viewport bottom-right.
- **Bed Map PDF button** (Session 73): "📄 Bed Map PDF" button in bed-admin.html header → opens printable 3-section PDF: Section 1 (dept-wise with floor→ward→type drilldown), Section 2 (floor-wise with dept breakdown), Section 3 (complete bed index). Fixed SyntaxError caused by Chrome's `<script type="module">` parser closing the element at `</style>`/`</head>`/`</body>`/`</html>` literal text inside a template literal. Fix: `const _x = (t) => '\x3C/' + t + '>'` helper + array-join instead of template literal — no `</xxx>` sequences in script source. Confirmed working (29 June 2026).

**Session 71 ✅ COMPLETE (28 June 2026):**
- bed-admin.html — major bed management UX overhaul:
  - **Bulk Add → selectable chip grid**: reserved bed numbers shown as toggleable chips; already-added beds greyed/disabled; Select All / Clear; extra beds section (beyond NCISM quota); non-NCISM depts start from globalExtra pool (totalNcism+1), not 1
  - **+Bed drawer → same chip UI**: single-select chip grid for bed number picking; dept shown first; chip click auto-fills Bed Number; typing clears chip selection
  - **Male/Female General Ward**: added `male_general` + `female_general` bed types across all 3 selects + BED_TYPE_SHORT + BED_LABELS; default changed to `male_general`; `beds_bed_type_check` DB constraint updated to include new types ✅ SQL run
  - **NCISM bed number lock**: edit drawer makes Bed Number read-only (greyed, 🔒 note) for reserved range beds; editable + ✏️ note for extra beds; payload skips `bed_number` field for reserved beds
  - **Info-panel chips clickable**: "Beds in this department (click to edit)" chips inside +Bed/+Bulk drawers now open edit drawer; auto-refresh after save/delete via `_refreshOpenDrawerDeptInfo()`
  - **Ward Name placeholder fixed**: was "e.g. Male General Ward" (caused users to type bed type here); now "e.g. Surgical Ward, ICU Block A"

**Session 70 ✅ COMPLETE (28 June 2026):**
- admin.html NCISM Setup Compliance checklist: every row is now a clickable `<a>` link to its management page. ✅ rows show "Manage →", ❌ rows show existing action label (e.g. "Add Beds →"). Hover highlights full row with green tint. Mapping: OPDs → opd-admin.html · Departments/Beds → bed-admin.html · Fee structures → fee-admin.html · Duty roster → roster.html · Staff counts → signup.html.
- Confirmed during walkthrough: clicking "✅ 10 Mandatory OPDs configured" navigates to opd-admin.html correctly.
- bed-admin.html — IPD Bed Setup overhaul:
  - **Auto-prefix**: department select auto-fills Prefix (KC/PK/SHAL/SNT/SHAK/PST/KAU/AGT/SW/SCR/AGT/RAS/MAN/RNV/DRV/RSH)
  - **Auto-count**: fills NCISM gap (beds still needed to meet quota); min 1 if already met
  - **Reserved range numbering**: depts ranked by required beds descending → PK 01–15, KC 16–27, SHAL 28–39… (scales for 60/100/150/200 intake); extra beds beyond quota start at totalNcism+1 (e.g. 61 for 60-intake) — never bleeds into another dept's range
  - **Edit/Delete**: Delete button in bed drawer (blocked for occupied beds); bed chips on dept cards clickable to open edit drawer
  - **Type + ward visible** in bed chips (was tooltip-only before)

**Session 69 ✅ COMPLETE (27 June 2026):**
- admin.html sidebar: icon-rail pattern — 52px strip always visible; hover→248px expand; mouse-leave collapses. Sidebar moved outside `admin-shell` (was inside `display:none` shell, so it was hidden). `margin-left:52px` on content; `flex:1;min-width:0` to fill full width. Hash routing: `admin.html#stats` auto-activates section.
- navbar.js: `_injectAdminSidebarOverlay()` auto-injects identical icon rail on all super_admin/dept_admin pages (bed-admin, opd-admin, fee-admin, ncism-compliance, finance, etc.) — no per-page changes needed.

**Session 68 ✅ COMPLETE (27 June 2026):**
- user-guide/finance.html: cashier + finance_manager roles added (§1.2 role matrix, §6.1 access table, §7.4 write-off note)
- TODO_LATER.md: §21w (Monthly Statistics) + §21x (NABH Accreditation) stamped COMPLETE
- login.html: autocomplete="new-password" (stops Chrome stale-autofill bug) + error message discrimination (rate-limit / network / bad credentials)
- wasa.admin password reset via Supabase Admin API (NEVER use SQL crypt() — produces $2a$ hash GoTrue rejects)
- bed-admin.html — NCISM bed compliance overhaul (Session 68):
  - UG_BED_RATIOS (Table-8) + ug_intake fetched from tenants
  - Dept cards: required beds, configured, gap (red/green), rounding footnote for 150 intake (*)
  - Bed list per dept card (bed number + floor, status-coloured)
  - Bed Matrix tab: department name on every bed card
  - New Bed + Bulk Add drawers: live NCISM compliance panel on dept select
  - Shalakya ratio corrected: 5% each (NETRA+KNM) = 10% combined per NCISM Table-8
  - seedNcismDepts alert improved to guide user toward +Bed buttons

**Session 67 ✅ COMPLETE (26–27 June 2026):**
- CLAUDE.md 67KB→33KB; ABDM_FT_Agency_MeetingKit.html; Finance roles (cashier+finance_manager); subscription RPC+columns; reception.html OPD locking

**Session 66 ✅ COMPLETE (25 June 2026)** — Insurance billing Phase 2+3. See SESSION_LOG.md.

### ✅ All SQL Run (Sessions 19–71)
- **Session 71**: `beds_bed_type_check` constraint updated — `ALTER TABLE beds DROP CONSTRAINT IF EXISTS beds_bed_type_check; ALTER TABLE beds ADD CONSTRAINT beds_bed_type_check CHECK (bed_type IN ('male_general','female_general','general','twin_sharing','semi_private','private','deluxe','dormitory','icu','day_care','pk_treatment','observation'));`
All DDL in `sql/` folder. Session 67 additions: `get_tenant_subscription_info` RPC, `profiles_role_check` constraint update, `tenants` subscription columns (plan_type, subscription_status, max_users, subscription_expiry).

### Platform Admin
- Login: admin@ayurxpert.com | code: `AYUR6270` | role: `platform_admin` → lands on subscription.html
- See memory: `platform_admin.md`

### External blockers (waiting on third parties)
- **WASA Safe-to-Host Certificate** — SecureNexGen; remediation evidence sent 30 Jun 2026 (TLS 1.2 + CSP fix). On receipt: upload 4 docs to portal → M1 production approval.
- **FT Certificate** — Nangia frontrunner (Rs. 90,000 + GST). Suma Soft quote due 1 Jul 11 AM. Select agency → WO + advance → 7 working days → NHA HTC submission.
- **SMS notifications** — wire reception.html stub when MSG91/Twilio API key arrives
- **Copyright Certificate** — filed 16 Jun 2026, Diary No SW-28425/2026-CO; 30-day examiner review
- **Deploy receipt-ocr Edge Function** — after ANTHROPIC_API_KEY purchased
- **nabl-cron deploy** — code ready; needs `supabase functions deploy nabl-cron`
- **§21a NCISM central server push** — pending NCISM API credentials
- **§21y Biometric attendance** — pending NCISM API + hardware

### Scope boundary (confirmed 4 June 2026)
- **HMS:** All hospital clinical operations, patient records, pharmacy, lab, nursing, IPD, OPD, clinical staff HR, staff accommodation (RMO/nurse/intern quarters)
- **CMS/ERP:** Academic programs, faculty service records, student records/attendance, library, student hostels, academic governance, NCISM portal uploads
- **Full CMS requirements + architecture:** See `CMS_REQUIREMENTS.md` — NCISM Handbook 2025-26 + architecture decisions
- **CMS build plan (phases + SQL):** See `TODO_LATER.md §22`

### CMS Architecture (locked 4 June 2026)
Key decisions — do not revisit without good reason:

| Decision | Choice | Reason |
|----------|--------|--------|
| Supabase project | **Same project as HMS** | Shared auth, direct FK to visits/ipd_admissions, no API layer |
| Schema | **`cms_` prefix in `public`** | Supabase only exposes `public` schema to supabase-js by default |
| College identity | **Existing `tenants` row** (type='college') | No separate college table needed |
| Student/faculty | **`profiles` rows** with new roles | Single sign-on with HMS staff |
| Faculty title | **Professor / Associate Professor / Assistant Professor** | NCISM MESAR 2024 terminology — NOT Reader/Lecturer |
| Case reference | **`visits.id` / `ipd_admissions.id`** | `hms_cases` does not exist — always use these |
| CMS folder | **`ayurxpert.com/cms/`** | HMS stays at root — do NOT move HMS to `/hms/` |
| RLS | **`profiles` table** | `user_roles` table does not exist — always use `profiles` |
| Cross-verify | **`verify-clinical-log` Edge Function** | Prevents fake logbook entries |

**Phase 0 SQL** (roles + tenants + departments columns) must run before any CMS page is built. See `TODO_LATER.md §22a`.

### NABL Lab Accreditation Plan
- NABL features fully built (`lab-nabl.html`, `printLabReport.html`). Instrument interfacing (HL7/ASTM) NOT implemented — use manual entry (standard for India).
- Full plan: `TODO_LATER.md §20`. Start when first NABL-aspiring tenant onboards.
- Tables: `lab_samples`, `lab_qc_runs`, `lab_instruments`, `reagent_batches`, `purchase_requisitions`, `nabl_audit_trail`, `lab_nc_reports`

### Planned but not started
- **College ERP / CMS** — `CMS_REQUIREMENTS.md`; `TODO_LATER.md §22`
- **§21a NCISM central server push** — blocked on NCISM API
- **§21y Biometric attendance** — blocked on NCISM API + hardware
- **§18ay digital signature** — PG Roganidana DSC (after DSC procured)
- **§19a Hostel/residence for clinical staff** — `TODO_LATER.md §19`
- **register.html activation** — `TODO_LATER.md §17b`

---

> Session history moved to `SESSION_LOG.md` to keep this file under the 40k limit.

---

## Testing Notes
- **Always test via Live Server** (VS Code extension) — use http://127.0.0.1:5500/login.html
- Opening via file:// breaks Supabase auth, service workers, and ES modules
- Hard refresh (Ctrl+Shift+R) clears service worker cache

---

## Company / Branding
- **Product**: AyurXpert (Ayur + Xpert in gold). **Legal**: AyurXpert Technologies™ (use ™, not ®)
- **Sister clinic**: Srishti Ayurveda™
- **Domain**: ayurxpert.com | **Emails**: support@, abdm@, privacy@ ayurxpert.com

### Logo Files (assets/)
| File | Use |
|------|-----|
| `AyurXpert_Navbar_Logo.png` | Navbar (dark green bg) |
| `AyurXpert_Transparent_Logo.png` | Hero card + About section |
| `AyurXpert_Logo.svg` | Full vector (large — use PNG for web) |
| `leaves.svg` | Hero botanical decoration (14% opacity) |
| `logo.jpeg` | Favicon + footer icon |

### TM Rules for home.html
- "AyurXpert Technologies&#8482;" — full company name in body text
- "Srishti Ayurveda&#8482;" — clinic name in body text
- Nav logo image already contains ™ visually — no extra ™ in `<img>` alt

---

## Deferred Work
See `TODO_LATER.md` in the project root — read and update each session.
- Check if any deferred item's trigger condition has been met (ABDM credentials received, SQL run, API key added)
- Mark completed items and add newly deferred items as work progresses

### Insurance Billing Phases (added Session 65)
| Phase | What | Status | Trigger |
|-------|------|--------|---------|
| Phase 1 | 16 insurance columns on bills + admin Accounts dashboard | ✅ Done (Session 65) | — |
| Phase 2 | reception.html 4-option payer type toggle · dispensaryPOS insurance badge + auto-Credit · ipd.html discharge insurance settlement panel (approved amt, collect due, negative-balance guard) · finance.html receptionist insurance-only access | ✅ Done (Session 66) | — |
| Phase 3 | insurance-claims.html: Active Claims · TPA Settlement · PMJAY Codes · Aging & Write-offs · Bad Debt Register + trigger | ✅ Done (Session 66) | ✅ SQL run 25 June 2026 — `insurance_write_offs` table + RLS + `trg_write_off_approval` trigger live |
