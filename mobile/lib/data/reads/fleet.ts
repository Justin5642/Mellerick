import { supabase } from "../../supabase";

export interface Equipment {
  id: string;
  name: string;
  category: string;
  registration: string | null;
  purchase_cost: number;
  purchase_date: string | null;
  estimated_life_years: number;
  insurance_annual: number;
  maintenance_annual: number;
  registration_annual: number;
  other_annual_costs: number;
  fuel_cost_per_hour: number;
  target_hours_per_year: number;
  notes: string | null;
}

const SELECT =
  "id, name, category, registration, purchase_cost, purchase_date, estimated_life_years, insurance_annual, maintenance_annual, registration_annual, other_annual_costs, fuel_cost_per_hour, target_hours_per_year, notes";

export async function listEquipment(): Promise<Equipment[]> {
  const { data } = await supabase.from("equipment").select(SELECT).eq("is_active", true).order("category").order("name");
  return (data as unknown as Equipment[]) ?? [];
}

// The web's equipment cost model: total annual cost / target hours + fuel/hr.
// Depreciation = purchase_cost / estimated_life_years.
export function hourlyRate(e: Equipment): number {
  const depreciation = e.estimated_life_years > 0 ? Number(e.purchase_cost) / Number(e.estimated_life_years) : 0;
  const annual = depreciation + Number(e.insurance_annual) + Number(e.maintenance_annual) + Number(e.registration_annual) + Number(e.other_annual_costs);
  const perHour = e.target_hours_per_year > 0 ? annual / Number(e.target_hours_per_year) : 0;
  return perHour + Number(e.fuel_cost_per_hour);
}
