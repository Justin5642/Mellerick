import { supabase } from "../../supabase";
import { fromLocalOr } from "./source";
import { requireJobOnDevice } from "./horizon";
import { bool, nestOne, num, numOrNull } from "./rowMap";
import { unwrapRows } from "./unwrap";

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
    async (db) => {
      // A job's variations travel with it through the sync window; a job not
      // on the device may have variations only the server holds.
      await requireJobOnDevice(db, "office", jobId);
      return (await db.getAll<RawVariationRow>(SQL_JOB_VARIATIONS_FOR_APPROVAL, [jobId])).map(mapVariationRow);
    },
    async () => {
      // ← unchanged pre-PowerSync Supabase body (byte-identical fallback).
      const res = await supabase
        .from("job_variations")
        .select("id, variation_type_id, custom_name, description, quantity, unit, rate, total_amount, admin_notes, photo_storage_path, status, created_at, variation_types(name)")
        .eq("job_id", jobId)
        .order("created_at", { ascending: false });
      return unwrapRows(res as never, "getJobVariationsForApproval") as unknown as VariationForApproval[];
    },
    { roles: ["office", "admin"] }
  );
}

// ---------------------------------------------------------------------------
// Technician side — MONEY-FREE BY CONSTRUCTION.
//
// Technicians read the rate-stripped projection: remotely the
// job_variations_public view (migration 0028), locally the tech_job_variations
// stream, which omits rate / total_amount / admin_notes. Neither the SQL nor
// the PostgREST select below names a money column, and the shape has no field
// to carry one (variations.local.test.ts asserts both).
//
// Columns are exactly the tech stream's set. `created_at` is NOT in that
// stream, so ordering is by `logged_at` on BOTH paths (it is stamped when the
// variation is logged — repositories/variations.ts) rather than serving a
// locally-null created_at.
//
// A job absent from the mirror (not assigned to this technician) answers from
// Supabase: locally-absent is not proof of absence.
// ---------------------------------------------------------------------------

export interface TechnicianVariation {
  id: string;
  job_id: string;
  variation_type_id: string | null;
  custom_name: string | null;
  description: string | null;
  quantity: number;
  unit: string;
  photo_storage_path: string | null;
  status: "auto_approved" | "pending_approval" | "approved" | "rejected";
  logged_by: string | null;
  logged_at: string | null;
}

const TECH_VARIATION_COLUMNS =
  "id, job_id, variation_type_id, custom_name, description, quantity, unit, photo_storage_path, status, logged_by, logged_at";

export const SQL_JOB_IN_MIRROR_FOR_VARIATIONS = `
  SELECT id FROM jobs WHERE id = ?`;

export const SQL_TECH_JOB_VARIATIONS = `
  SELECT id, job_id, variation_type_id, custom_name, description, quantity, unit,
         photo_storage_path, status, logged_by, logged_at
  FROM job_variations
  WHERE job_id = ? ORDER BY logged_at DESC`;

interface RawTechVariationRow {
  id: string;
  job_id: string;
  variation_type_id: string | null;
  custom_name: string | null;
  description: string | null;
  quantity: number | string | null;
  unit: string;
  photo_storage_path: string | null;
  status: string;
  logged_by: string | null;
  logged_at: string | null;
}

function mapTechVariation(r: RawTechVariationRow): TechnicianVariation {
  return {
    id: r.id,
    job_id: r.job_id,
    variation_type_id: r.variation_type_id ?? null,
    custom_name: r.custom_name ?? null,
    description: r.description ?? null,
    quantity: num(r.quantity),
    unit: r.unit,
    photo_storage_path: r.photo_storage_path ?? null,
    status: r.status as TechnicianVariation["status"],
    logged_by: r.logged_by ?? null,
    logged_at: r.logged_at ?? null,
  };
}

export async function listJobVariationsForTechnician(jobId: string): Promise<TechnicianVariation[]> {
  const remote = async (): Promise<TechnicianVariation[]> => {
    const res = await supabase
      .from("job_variations_public")
      .select(TECH_VARIATION_COLUMNS)
      .eq("job_id", jobId)
      .order("logged_at", { ascending: false });
    return (unwrapRows(res as never, "listJobVariationsForTechnician") as RawTechVariationRow[]).map(mapTechVariation);
  };
  return fromLocalOr(async (db) => {
    if (!(await db.getOptional<{ id: string }>(SQL_JOB_IN_MIRROR_FOR_VARIATIONS, [jobId]))) return remote();
    return (await db.getAll<RawTechVariationRow>(SQL_TECH_JOB_VARIATIONS, [jobId])).map(mapTechVariation);
  }, remote);
}

/** Active variation types for the "log a variation" picker. Rate-free for every role. */
export interface VariationTypeOption {
  id: string;
  name: string;
  unit: string;
  auto_approve: boolean;
}

// variation_types is streamed rate-stripped to EVERY role (sync-streams.yaml),
// which is exactly why settings.ts (which needs the rate) stays remote — and
// exactly why this picker, which must never show one, can read it locally.
export const SQL_ACTIVE_VARIATION_TYPES = `
  SELECT id, name, unit, auto_approve FROM variation_types
  WHERE is_active = 1 ORDER BY name`;

interface RawVariationTypeRow {
  id: string;
  name: string;
  unit: string;
  auto_approve: number | boolean | null;
}

const mapVariationType = (r: RawVariationTypeRow): VariationTypeOption => ({
  id: r.id,
  name: r.name,
  unit: r.unit,
  auto_approve: bool(r.auto_approve) === true,
});

export async function listActiveVariationTypes(): Promise<VariationTypeOption[]> {
  return fromLocalOr(
    async (db) => (await db.getAll<RawVariationTypeRow>(SQL_ACTIVE_VARIATION_TYPES)).map(mapVariationType),
    async () => {
      const res = await supabase
        .from("variation_types_public")
        .select("id, name, unit, auto_approve")
        .eq("is_active", true)
        .order("name");
      return (unwrapRows(res as never, "listActiveVariationTypes") as RawVariationTypeRow[]).map(mapVariationType);
    }
  );
}
