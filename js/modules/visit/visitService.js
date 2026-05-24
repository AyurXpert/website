import { supabase } from '../../core/db/supabaseClient.js'

export async function createVisit(patientId, tenantId, doctorId, complaint) {

  // 🚫 CHECK existing active visit
  const { data: existingVisit } = await supabase
    .from('visits')
    .select('*')
    .eq('patient_id', patientId)
    .eq('status', 'waiting')
    .limit(1)

  if (existingVisit && existingVisit.length > 0) {
    return {
      ...existingVisit[0],
      alreadyExists: true
    }
  }

  // 🔢 TOKEN
  const { data } = await supabase
    .from('visits')
    .select('token_number')
    .eq('tenant_id', tenantId)
    .not('token_number', 'is', null)
    .order('token_number', { ascending: false })
    .limit(1)

  let nextToken = 1
  if (data.length > 0) {
    nextToken = data[0].token_number + 1
  }

  // ➕ CREATE VISIT
  const { data: visit, error } = await supabase
    .from('visits')
    .insert({
      patient_id: patientId,
      tenant_id: tenantId,
      doctor_id: doctorId,
      status: 'waiting',
      chief_complaint: complaint,
      token_number: nextToken
    })
    .select()
    .single()

  if (error) throw error

  return {
    ...visit,
    alreadyExists: false
  }
}

export async function getWaitingQueue(doctorId) {
  const { data, error } = await supabase
    .from('visits')
    .select(`
      id,
      token_number,
      created_at,
      status,
      chief_complaint,
      patients ( name, phone )
    `)
    .eq('status', 'waiting')
    .eq('doctor_id', doctorId)   // ✅ NEW
    .order('token_number', { ascending: true })

  if (error) {
    console.error("Error fetching queue:", error)
    return []
  }

  return data
}