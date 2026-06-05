import { supabase } from '../../core/db/supabaseClient.js'

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
export async function createPatient(name, phone, tenantId, abhaNumber = null, demographics = {}) {
  const { data, error } = await supabase
    .from('patients')
    .insert({
      name:           name.trim(),
      phone:          phone.trim(),
      tenant_id:      tenantId,
      abha_number:    abhaNumber || null,
      age:            demographics.age            || null,
      gender:         demographics.gender         || null,
      date_of_birth:  demographics.date_of_birth  || null,
      blood_group:    demographics.blood_group    || null
    })
    .select()
    .single()

  if (error) {
    console.error("Error creating patient:", error.message, error.details, error.hint)
    throw error
  }

  return data
}