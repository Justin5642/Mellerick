import { listActiveVariationTypes, listJobVariationsForTechnician } from "./variations";
import { openVariations, variationName } from "../../variationTime";

// The variations time can go against on one job (0120, draft): the clock-on
// picker, "Switch to a variation" and the Time tab's per-entry picker.
//
// MONEY-FREE BY CONSTRUCTION, for every role: it reads the rate-stripped
// technician projection (locally the tech_job_variations stream's columns,
// remotely the job_variations_public view) and the rate-free type names, and
// hands back ids, names and statuses only. Local-first, so it works offline.

export interface ClockVariation {
  id: string;
  name: string;
  status: string;
}

/** Every variation on the job (rejected included, for naming an entry's), newest first. Null when it couldn't be read. */
export async function listJobClockVariations(jobId: string): Promise<ClockVariation[] | null> {
  try {
    const [rows, types] = await Promise.all([listJobVariationsForTechnician(jobId), listActiveVariationTypes().catch(() => [])]);
    const typeName = new Map(types.map((t) => [t.id, t.name]));
    return rows.map((v) => ({
      id: v.id,
      status: v.status,
      name: variationName({ custom_name: v.custom_name, type_name: v.variation_type_id ? typeName.get(v.variation_type_id) ?? null : null }),
    }));
  } catch {
    return null;
  }
}

/** The ones time can go against: not rejected. */
export function openClockVariations(list: ClockVariation[] | null | undefined): ClockVariation[] {
  return openVariations(list ?? []);
}
