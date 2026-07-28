import { supabase } from "../../supabase";
import { fromLocalOr } from "./source";
import { nestOne, num, numOrNull } from "./rowMap";

// Office/admin read of a job's variations from the BASE table (carries the
// money columns rate/total_amount/admin_notes — office/admin RLS only). The
// technician side reads the rate-stripped job_variations_public view instead
// (see components/job/variations.tsx). Used by the approval/pricing controls.
export interface VariationForApproval {
  id: string;
  variation_type_id: string | null;
  custom_name: string | null;
  description: string | null;
  quantity: number;
  unit: string;
  rate: number | null;
  total_amount: number | null;
  admin_notes: string | null;
  photo_storage_path: string | null;
  status: "auto_approved" | "pending_approval" | "approved" | "rejected";
  created_at: string;
  variation_types: { name: string } | null;
}

// Local (PowerSync) equivalent of the Supabase query below. The role gate on
// this read is LOAD-BEARING: `job_variations` is streamed rate-stripped to
// technicians, so a technician served locally would see their own rows with
// rate = NULL — a silently wrong answer. Routing them to Supabase preserves
// today's loud RLS denial instead.
export const SQL_JOB_VARIATIONS_FOR_APPROVAL = `
  SELECT v.id, v.variation_type_id, v.custom_name, v.description, v.quantity, v.unit,
         v.rate, v.total_amount, v.admin_notes, v.photo_storage_path, v.status, v.created_at,
         t.name AS variation_type_name
  FROM job_variations v LEFT JOIN variation_types t ON t.id = v.variation_type_id
  WHERE v.job_id = ? ORDER BY v.created_at DESC`;

/** Row shape as the device SQLite returns it (numerics may arrive as strings). */
interface RawVariationRow {
  id: string;
  variation_type_id: string | null;
  custom_name: string | null;
  description: string | null;
  quantity: number | string | null;
  unit: string;
  rate: number | string | null;
  total_amount: number | string | null;
  admin_notes: string | null;
  photo_storage_path: string | null;
  status: string;
  created_at: string;
  variation_type_name: string | null;
}

// A null variation_type_id is exactly when PostgREST returns a null embed
// (not `{ name: null }`) — nestOne keys on the FK, matching that shape.
function mapVariationRow(r: RawVariationRow): VariationForApproval {
  return {
    id: r.id,
    variation_type_id: r.variation_type_id,
    custom_name: r.custom_name,
    description: r.description,
    quantity: num(r.quantity),
    unit: r.unit,
    rate: numOrNull(r.rate),
    total_amount: numOrNull(r.total_amount),
    admin_notes: r.admin_notes,
    photo_storage_path: r.photo_storage_path,
    status: r.status as VariationForApproval["status"],
    created_at: r.created_at,
    variation_types: nestOne(r.variation_type_id, { name: r.variation_type_name as string }),
  };
}

export async function getJobVariationsForApproval(jobId: string): Promise<VariationForApproval[]> {
  return fromLocalOr(
    async (db) =>
      (await db.getAll<RawVariationRow>(SQL_JOB_VARIATIONS_FOR_APPROVAL, [jobId])).map(
        mapVariationRow
      ),
    async () => {
      // ← unchanged pre-PowerSync Supabase body (byte-identical fallback).
      const { data } = await supabase
        .from("job_variations")
        .select("id, variation_type_id, custom_name, description, quantity, unit, rate, total_amount, admin_notes, photo_storage_path, status, created_at, variation_types(name)")
        .eq("job_id", jobId)
        .order("created_at", { ascending: false });
      return (data as unknown as VariationForApproval[]) ?? [];
    },
    { roles: ["office", "admin"] }
  );
}
