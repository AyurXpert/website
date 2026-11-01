import { supabase } from '../../core/db/supabaseClient.js'
import { genderCode } from '../../utils/gender.js'

// 🔍 Find patient by phone (IMPORTANT to avoid duplicates)
export async function findPatient(phone, name, tenantId) {
  const { data, error } = await supabase
    .from('patients')
    .select('*')
    .eq('phone', phone)
    .eq('name', name)         // ✅ ADD THIS
    .eq('tenant_id', tenantId)
    .limit(1)

  if (error) {
    console.error("Error finding patient:", error)
    return null
  }

  return data.length > 0 ? data[0] : null
}

// ➕ Create new patient
// Session 371B (plan session 370 B3-B6): gender is sent as M / F / O; `extra` carries the address parts (address_line, address_town,
// address_district, address_state, address_pin -- the server joins them into patients.address) and no_mobile / no_mobile_reason.
// The server refuses a browser-created patient without name, age or date of birth, gender, and a mobile or "no mobile" (Build A).
export async function createPatient(name, phone, tenantId, abhaNumber = null, demographics = {}, abhaAddress = null, extra = {}) {
  const { data, error } = await supabase
    .from('patients')
    .insert({
      name:           name.trim(),
      phone:          String(phone ?? '').trim() || null,
      tenant_id:      tenantId,
      abha_number:    abhaNumber || null,
      abha_address:   abhaAddress || null,
      age:            demographics.age ?? null,
      gender:         genderCode(demographics.gender),
      date_of_birth:  demographics.date_of_birth  || null,
      blood_group:    demographics.blood_group    || null,
      ...extra,
    })
    .select()
    .single()

  if (error) {
    console.error("Error creating patient:", error.message, error.details, error.hint)
    throw error
  }

  return data
}