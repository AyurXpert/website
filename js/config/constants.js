// js/config/constants.js
// Replace SUPABASE_URL and SUPABASE_ANON_KEY with your actual values from:
// Supabase Dashboard > Project Settings > API

export const SUPABASE_URL      = 'https://xvlvifiebafvgzlixdee.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh2bHZpZmllYmFmdmd6bGl4ZGVlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1ODI5MDIsImV4cCI6MjA5MjE1ODkwMn0.JHcQCLaBgtk8o1mXFhT4NMyZFLogeDMnxlyybg32LPE';

export const APP_NAME    = 'AyurXpert';
export const APP_VERSION = '1.0.0';

// ── Roles (must match CHECK constraint in profiles table) ──
export const ROLES = {
  SUPER_ADMIN:   'super_admin',
  DEPT_ADMIN:    'dept_admin',
  DOCTOR:        'doctor',
  RECEPTIONIST:  'receptionist',
  PHARMACIST:    'pharmacist',
  NURSE:         'nurse',
  LAB_TECH:      'lab_tech',
  ACCOUNTANT:    'accountant',
  STUDENT:       'student',
  PUBLIC:        'public',
};

// ── Where each role lands after login ──
export const ROLE_HOME = {
  super_admin:  'index.html',
  dept_admin:   'index.html',
  doctor:       'doctor.html',
  receptionist: 'reception.html',
  pharmacist:   'dispensaryPOS.html',
  nurse:        'reception.html',
  lab_tech:     'reports.html',
  accountant:   'fee-admin.html',
  student:      'index.html',
  public:       'index.html',
};

// ── Pages that do NOT need login ──
export const PUBLIC_PAGES = [
  'login.html',
  'register.html',
  'signup.html',
  'home.html',
  'privacy.html',
  'terms.html',
];

// ── Tenant types (must match CHECK in tenants table) ──
export const TENANT_TYPES = {
  CLINIC:      'clinic',
  HOSPITAL:    'hospital',
  PK_CENTER:   'pk_center',
  DISPENSARY:  'dispensary',
  COLLEGE:     'college',
  PHARMA:      'pharma',
  SUPPLIER:    'supplier',
  DEALER:      'dealer',
  JOURNAL:     'journal',
};

// ── Staff approval statuses ──
export const STAFF_STATUS = {
  PENDING:   'pending_approval',
  APPROVED:  'approved',
  ACTIVE:    'active',
  REJECTED:  'rejected',
  SUSPENDED: 'suspended',
};

// ── Visit types ──
export const VISIT_TYPES = {
  OPD:         'opd',
  IPD:         'ipd',
  TELECONSULT: 'teleconsult',
};

// ── Bill / payment ──
export const BILL_STATUS = {
  PENDING:   'pending',
  PAID:      'paid',
  PARTIAL:   'partial',
  CANCELLED: 'cancelled',
};

export const PAYMENT_METHODS = {
  CASH:   'cash',
  UPI:    'upi',
  CARD:   'card',
  CREDIT: 'credit',
};

// ── sessionStorage keys ──
export const SESSION_KEYS = {
  USER:      'ayurxpert_user',
  PROFILE:   'ayurxpert_profile',
  TENANT:    'ayurxpert_tenant',
  TENANT_ID: 'ayurxpert_tenant_id',
  ROLE:      'ayurxpert_role',
};

// ── Misc ──
export const PAGE_SIZE   = 25;
export const DATE_FORMAT = 'DD/MM/YYYY';