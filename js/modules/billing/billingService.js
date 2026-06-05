import { supabase } from '../../core/db/supabaseClient.js'

// ➕ Create Bill
export async function createBill(tenantId, patientId, amount) {
  const { data, error } = await supabase
    .from('bills')
    .insert({
      tenant_id: tenantId,
      patient_id: patientId,
      total_amount: amount,
      status: 'pending'
    })
    .select()
    .single()

  if (error) {
    console.error("Error creating bill:", error)
    throw error
  }

  return data
}


// 📋 Get bills of a patient (useful later)
export async function getBillsByPatient(patientId) {
  const { data, error } = await supabase
    .from('bills')
    .select('*')
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false })

  if (error) {
    console.error("Error fetching bills:", error)
    return []
  }

  return data
}
//-----------------------------------------------------------------------------------------------------------//
// foe ✔ Medicine-wise billing, ✔ Cost calculation,✔ Inventory integration ready, ✔ Real clinic workflow//

export async function createBillFromPrescription(visitId) {

  const { data: userData } = await supabase.auth.getUser()
  const userId = userData.user.id

  const { data: userRow } = await supabase
    .from('profiles')
    .select('tenant_id')
    .eq('id', userId)
    .single()

  const tenantId = userRow.tenant_id

  // Get prescription
  const { data: prescription } = await supabase
    .from('prescriptions')
    .select('id, patient_id')
    .eq('visit_id', visitId)
    .maybeSingle()

  if (!prescription) throw new Error("No prescription found")

  // Get medicines
  const { data: items } = await supabase
    .from('prescription_items')
    .select('medicine_id')
    .eq('prescription_id', prescription.id)

  if (!items || items.length === 0)
    throw new Error("No medicines found")

  const medicineIds = items.map(i => i.medicine_id)

  // Get prices
  const { data: inventory } = await supabase
    .from('inventory')
    .select('medicine_id, mrp')
    .in('medicine_id', medicineIds)
    .eq('tenant_id', tenantId)

  const billItems = items.map(i => {
    const inv = inventory.find(m => m.medicine_id === i.medicine_id)

    const price = inv?.mrp || 0

    return {
      tenant_id: tenantId,
      medicine_id: i.medicine_id,
      quantity: 1,
      price: price,
      total: price
    }
  })

  const totalAmount = billItems.reduce((sum, i) => sum + i.total, 0)

  // Create bill
  const { data: bill } = await supabase
    .from('bills')
    .insert({
      tenant_id: tenantId,
      patient_id: prescription.patient_id,
      visit_id: visitId,
      total_amount: totalAmount,
      final_amount: totalAmount,
      status: 'pending'
    })
    .select()
    .single()

  // Insert bill items
  const itemsToInsert = billItems.map(i => ({
    ...i,
    bill_id: bill.id
  }))

  await supabase.from('bill_items').insert(itemsToInsert)

  return bill
}
export async function deductInventory(prescriptionId, tenantId) {
  try {

    // 1. Get prescription items with quantity
    const { data: items, error: itemsError } = await supabase
      .from('prescription_items')
      .select('medicine_id, quantity')
      .eq('prescription_id', prescriptionId)

    if (itemsError) {
      console.error("Error fetching prescription items:", itemsError)
      return
    }

    console.log("Deducting items:", items)

    for (const item of items) {

      const qty = Number(item.quantity || 1)

      if (!qty || qty <= 0) {
        console.warn("Invalid quantity, skipping:", item)
        continue
      }

      // 2. Get ALL inventory rows (important - no .single())
      const { data: invData, error: invError } = await supabase
        .from('inventory')
        .select('id, stock_quantity')
        .eq('medicine_id', item.medicine_id)
        .eq('tenant_id', tenantId)

      if (invError) {
        console.error("Inventory fetch error:", invError)
        continue
      }

      if (!invData || invData.length === 0) {
        console.warn("No inventory found for medicine:", item.medicine_id)
        continue
      }

      // 3. Calculate TOTAL stock (production-safe)
      const currentStock = invData.reduce(
        (sum, i) => sum + Number(i.stock_quantity || 0),
        0
      )

      const newStock = currentStock - qty

      console.log("Stock calculation:", {
        medicine: item.medicine_id,
        currentStock,
        qty,
        newStock
      })

      // 4. Validation
      if (newStock < 0) {
        alert(`⚠️ Not enough stock! Available: ${currentStock}`)
        continue
      }

      // 5. TEMP SAFE UPDATE (single row update)
      // 👉 We update ONLY first row for now (phase 1)
      const firstRow = invData[0]

      const updatedStock = Number(firstRow.stock_quantity || 0) - qty

      const { error: updateError } = await supabase
        .from('inventory')
        .update({
          stock_quantity: updatedStock
        })
        .eq('id', firstRow.id)

      if (updateError) {
        console.error("Stock update error:", updateError)
      } else {
        console.log("Stock updated successfully for:", item.medicine_id)
      }
    }

  } catch (err) {
    console.error("Deduction function error:", err)
  }
}