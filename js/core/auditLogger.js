import { supabase } from './db/supabaseClient.js';

/**
 * Log a user action to audit_logs.
 * Never throws — a failed audit log must never break the main flow.
 *
 * @param {string} action       - e.g. 'login', 'create_visit', 'cancel_bill'
 * @param {string} tableName    - primary table affected
 * @param {string|null} recordId - uuid of the affected record
 * @param {object} newData      - key facts to store (patient name, amount, etc.)
 * @param {object} ctx          - { tenantId, userId, userName }
 */
export async function logAudit(action, tableName, recordId, newData = {}, ctx = {}) {
  try {
    await supabase.from('audit_logs').insert({
      tenant_id:  ctx.tenantId || null,
      user_id:    ctx.userId   || null,
      action,
      table_name: tableName,
      record_id:  recordId     || null,
      new_data:   { ...newData, _by: ctx.userName || undefined }
    });
  } catch (err) {
    console.warn('[audit] log failed:', err?.message);
  }
}
