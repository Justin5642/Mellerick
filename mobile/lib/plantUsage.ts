import { supabase } from "./supabase";
import { fetchWithTimeout } from "./fetchWithTimeout";

// Truck and plant usage on a job (Stage 7, 31 Oct 2026; web route
// /api/jobs/[id]/plant-usage). The driver logs a cartage run — hours, loads or
// both — against the job's Transport line. Online only, like supplier POs.
// Equipment names only: the phone never sees what plant costs.

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

export interface PlantState {
  equipment: { id: string; name: string; category: string }[];
  /** The job's PO lines, with the company cost centre each belongs to. */
  lines: { id: string; name: string; costCentre: string | null }[];
  usage: { id: string; date: string; hours: number; loads: number; costCenterId: string | null; equipment: string; loggedBy: string | null }[];
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!API_BASE_URL) throw new Error("App isn't configured to reach the office server.");
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("Your session has expired. Sign out and back in, then try again.");
  let res: Response;
  try {
    res = await fetchWithTimeout(`${API_BASE_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new Error("No connection. Logging truck and plant needs signal — try again when you have it.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Server returned ${res.status}. Try again.`);
  return data as T;
}

export function loadPlant(jobId: string): Promise<PlantState> {
  return call(`/api/jobs/${jobId}/plant-usage`);
}

export function logPlant(jobId: string, entry: { equipmentId: string; hours: number; loads: number; costCenterId: string | null }): Promise<{ ok: true }> {
  return call(`/api/jobs/${jobId}/plant-usage`, { method: "POST", body: JSON.stringify(entry) });
}

/**
 * The line a new entry starts on: the job's Transport line for a vehicle (the
 * truck's cartage, Justin 31 Oct 2026), when there is exactly one.
 */
export function defaultPlantLine(category: string | undefined, lines: PlantState["lines"]): string | null {
  if (category !== "vehicle") return null;
  const transport = lines.filter((l) => (l.costCentre ?? "").toLowerCase() === "transport");
  return transport.length === 1 ? transport[0].id : null;
}
