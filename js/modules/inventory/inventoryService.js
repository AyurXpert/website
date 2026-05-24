import { supabase } from '../../core/db/supabaseClient.js'

export async function getInventory(tenantId) {

  // 1. Get inventory
  const { data: inventory, error: invError } = await supabase
    .from('inventory')
    .select('*')
    .eq('tenant_id', tenantId)

  console.log("Inventory raw:", inventory, "Error:", invError)

  // 2. Get medicines
  const { data: medicines, error: medError } = await supabase
    .from('medicines')
    .select('id, name')

  // ✅ Debug BEFORE return
  console.log("Medicines fetched:", medicines, "Error:", medError)

  // ✅ Guard: if medicines is null/empty, return inventory as-is
  if (!medicines || medicines.length === 0) {
    console.warn("No medicines returned — check RLS policies on medicines table")
    return (inventory || []).map(item => ({ ...item, medicine_name: "Unknown" }))
  }

  // 3. Create lookup map
  const medMap = {}
  medicines.forEach(m => {
    medMap[m.id] = m.name
  })

  console.log("MedMap:", medMap)
  console.log("Sample inventory medicine_id:", inventory[0]?.medicine_id)
  console.log("Lookup test:", medMap[inventory[0]?.medicine_id])

  // 4. Map inventory
  const mapped = inventory.map(item => ({
    ...item,
    medicine_name: medMap[item.medicine_id] || "Unknown"
  }))

  console.log("FINAL INVENTORY:", JSON.stringify(mapped, null, 2)) // ✅ JSON.stringify forces full expand

  return mapped
}