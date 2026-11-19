import { supabase } from "./supabase";
import { fetchWithTimeout } from "./fetchWithTimeout";

// Online calls to the web's office/admin API routes, with the signed-in user's
// Bearer token (lib/api/caller-client.ts on the web turns it back into an
// RLS-scoped client; the route's own guard checks the role). Used by the
// phone's Approvals (hours, Apply hourly rate) and Staff (invite, login email,
// auto clock) screens. Not the outbox: each of these needs the server's answer
// on the spot (an invoice total, an email sent), and none is a row the phone
// owns.

/** A refusal from the server, carrying its status and machine code (e.g. "confirm_outside"). */
export class OfficeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
    this.name = "OfficeApiError";
  }
}

export async function officeApi<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
  const base = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (!base) throw new OfficeApiError("App isn't configured to reach the office server.", 0);
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new OfficeApiError("Your session has expired. Sign out and back in, then try again.", 401);
  let res: Response;
  try {
    res = await fetchWithTimeout(`${base}${path}`, {
      method: init.method ?? "GET",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    throw new OfficeApiError("No connection. This needs signal — try again when you have it.", 0);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) {
    throw new OfficeApiError(typeof data.error === "string" ? data.error : `Server returned ${res.status}. Try again.`, res.status, data.code);
  }
  return data as T;
}
