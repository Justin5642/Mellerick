import { supabase } from "./supabase";
import { fetchWithTimeout } from "./fetchWithTimeout";
import type { MyMistake, RaiseMistakeBody } from "./mistakeRaise";

// "Log mistake" on the phone (Justin, 25 Nov 2026: crew raise, office costs;
// migration 0119 (a draft, not applied yet)). Online only, like supplier orders: the web route runs
// raise_job_mistake() as the caller, and photos go up after the mistake is
// saved. Not the outbox — job_mistakes is in no PowerSync stream (it is
// office-only: the office's costs live there), and the crew want to see it
// logged on the spot. No money anywhere in these answers.

export const MISTAKES_OFFLINE = "Logging a mistake needs signal. Try again when you have it.";

export interface CrewMistakeState {
  ready: boolean;
  categories: { id: string; name: string }[];
  stages: { id: string; name: string; completed: boolean }[];
  timeEntries: { id: string; clockIn: string; clockOut: string | null; hours: number | null }[];
  mistakes: MyMistake[];
}

async function call<T>(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<T> {
  const base = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (!base) throw new Error("App isn't configured to reach the office server.");
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("Your session has expired. Sign out and back in, then try again.");
  let res: Response;
  try {
    res = await fetchWithTimeout(`${base}${path}`, { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` } }, timeoutMs);
  } catch {
    throw new Error(`No connection. ${MISTAKES_OFFLINE}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Server returned ${res.status}. Try again.`);
  return data as T;
}

const base = (jobId: string) => `/api/jobs/${encodeURIComponent(jobId)}/mistakes`;

export function loadMistakes(jobId: string): Promise<CrewMistakeState> {
  return call(base(jobId));
}

/** Safe to retry with the same `body.id`: the server answers a second raise as saved. */
export function raiseMistake(jobId: string, body: RaiseMistakeBody): Promise<CrewMistakeState & { saved: { id: string } }> {
  return call(base(jobId), { method: "POST", body: JSON.stringify(body) });
}

/** One photo as base64 JPEG (lib/imageUpload.ts prepareImage). 60 s: it carries the photo up. */
export function addMistakePhoto(jobId: string, mistakeId: string, imageBase64: string): Promise<{ saved: true }> {
  return call(`${base(jobId)}/${encodeURIComponent(mistakeId)}/photos`, { method: "POST", body: JSON.stringify({ image: imageBase64 }) }, 60_000);
}

export function isMistakesOffline(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith("No connection.");
}
