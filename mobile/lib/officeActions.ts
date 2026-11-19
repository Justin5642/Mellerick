import { supabase } from "./supabase";
import { fetchWithTimeout } from "./fetchWithTimeout";

// Small office/admin website actions on the phone (19 Nov 2026), the ones that
// need the office server rather than the outbox:
//   • Delete a job (admin) — DELETE /api/jobs/[id], the route the web dialog
//     uses. Online only: a delete the database refuses (a linked quote or
//     invoice) must be answered while the admin is looking at the job, not
//     dead-letter in the queue later.
//   • Look a site's address up for its map pin — GET /api/geocode, the same
//     lookup and precision rule the hourly site geocoder uses. The pin itself
//     is then saved through the outbox (CustomersRepository.setSitePin).

async function call<T>(path: string, init: RequestInit, offline: string): Promise<T> {
  // Read per call (still a literal EXPO_PUBLIC_ reference, so it is inlined at build).
  const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;
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
    throw new Error(offline);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Server returned ${res.status}. Try again.`);
  return data as T;
}

/** The web dialog's wording (components/job/delete-job-dialog.tsx), for the confirm alert. */
export function deleteJobMessage(jobTitle: string): string {
  return (
    `This permanently deletes "${jobTitle}" along with all of its notes, photos, documents, time entries, expenses, and variations. ` +
    "This can't be undone. If the details were just wrong, consider editing the job instead."
  );
}

/** Admin only — the server checks. Throws the server's sentence (e.g. a linked quote or invoice). */
export async function deleteJob(jobId: string): Promise<void> {
  await call(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" }, "No connection. Deleting a job needs signal — try again when you have it.");
}

export interface SiteAddressParts {
  address_line1?: string | null;
  suburb?: string | null;
  state?: string | null;
  postcode?: string | null;
}

/**
 * The address sent to the geocoder — the web's siteAddress() (lib/geocode.ts):
 * a unit / lot / shop prefix is dropped (the geocoder finds the building, not
 * the unit), then suburb, state, postcode and "Australia". Null with no street.
 */
export function siteAddress(s: SiteAddressParts): string | null {
  const line1 = (s.address_line1 ?? "")
    .trim()
    .replace(/^(unit|u|shop|suite|lot)\s*\d+[a-z]?\s*[/,]?\s*/i, "")
    .replace(/^\d+[a-z]?\s*\/\s*/i, "");
  if (!line1) return null;
  const locality = [s.suburb, s.state, s.postcode].map((p) => (p ?? "").trim()).filter(Boolean).join(" ");
  return [line1, locality, "Australia"].filter(Boolean).join(", ");
}

export interface GeocodedPin {
  lat: number;
  lng: number;
  display: string | null;
}

/**
 * Look the address up. Only a house/building-level match comes back (the
 * server's rule — a street or suburb guess would put the 150 m auto clock-in
 * fence in the wrong place); anything else throws the server's sentence.
 */
export async function geocodeSiteAddress(address: string): Promise<GeocodedPin> {
  const found = await call<{ lat: number; lng: number; display?: string | null }>(
    `/api/geocode?address=${encodeURIComponent(address)}`,
    { method: "GET" },
    "No connection. Looking an address up needs signal — try again when you have it."
  );
  if (!Number.isFinite(found.lat) || !Number.isFinite(found.lng)) throw new Error("Couldn't find that exact address");
  return { lat: found.lat, lng: found.lng, display: found.display ?? null };
}

/** The crew's "Set site location here" refuses a fix worse than this; the office does the same. */
export const MAX_PIN_ACCURACY_METRES = 50;

/** Why a phone fix can't be used as a site pin, or null when it can. */
export function pinFixProblem(fix: { latitude: number; longitude: number; accuracy: number | null } | null): string | null {
  if (!fix || !Number.isFinite(fix.latitude) || !Number.isFinite(fix.longitude) || (fix.latitude === 0 && fix.longitude === 0)) {
    return "Couldn't get a fix on where you are. Step into the open and try again.";
  }
  if (fix.accuracy == null || !Number.isFinite(fix.accuracy) || fix.accuracy > MAX_PIN_ACCURACY_METRES) {
    return `Your phone's location isn't accurate enough${fix.accuracy ? ` (±${Math.round(fix.accuracy)} m)` : ""}. Step into the open and try again.`;
  }
  return null;
}

/** "-37.81360, 144.96310" — what the confirm shows, as the web dialog does. */
export function formatPin(lat: number, lng: number): string {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

/**
 * An equipment-usage entry's amounts on the job's Billing screen (0091, as the
 * web Equipment tab): hours and/or loads carted — hours may be 0 for a
 * loads-only truck run, but one of them must be more than 0. Loads are whole
 * numbers. Blank reads as 0.
 */
export function parseUsageAmounts(hoursText: string, loadsText: string): { hours: number; loads: number } | { error: string } {
  const hours = hoursText.trim() === "" ? 0 : Number(hoursText.trim());
  const loads = loadsText.trim() === "" ? 0 : Number(loadsText.trim());
  if (!Number.isFinite(hours) || hours < 0) return { error: "Hours must be a number, 0 or more." };
  if (!Number.isFinite(loads) || loads < 0 || !Number.isInteger(loads)) return { error: "Loads must be a whole number, 0 or more." };
  if (hours <= 0 && loads <= 0) return { error: "Enter the hours, the loads carted, or both." };
  return { hours, loads };
}
