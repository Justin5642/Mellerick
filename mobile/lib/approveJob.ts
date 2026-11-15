import { supabase } from "./supabase";
import { fetchWithTimeout } from "./fetchWithTimeout";

// Approving a completed job from the phone (audit, 15 Nov 2026).
//
// The phone used to approve on its own: it copied the job's line items into a
// new draft invoice through the outbox and marked the job approved. It never
// looked at clocked hours, so a job with hours and no line items was approved
// with NO invoice — the Garden World / #2542 bug, fixed on the web in #133 and
// still live here. It also skipped approved variations.
//
// Now the phone asks the server to do it (POST /api/jobs/[id]/approve,
// lib/approve-job.ts) — the same single path the web uses, so the two can't
// drift again. Online only: approving builds an invoice, and the duplicate-
// invoice guard has to read the live database anyway.

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

export interface ApproveResult {
  invoiceId: string | null;
  invoiceCreated: boolean;
  alreadyPushed: boolean;
  progressClaim?: boolean;
  unbilledVariations?: number;
  unpricedHours: number;
  warnings: string[];
}

export async function approveJobOnServer(jobId: string, notes: string | null): Promise<ApproveResult> {
  if (!API_BASE_URL) throw new Error("App isn't configured to reach the office server.");
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("Your session has expired. Sign out and back in, then try again.");
  let res: Response;
  try {
    res = await fetchWithTimeout(`${API_BASE_URL}/api/jobs/${jobId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ notes }),
    });
  } catch {
    throw new Error("No connection. Approving a job needs signal — try again when you have it.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Server returned ${res.status}. Try again.`);
  return { warnings: [], ...data } as ApproveResult;
}

/** The message shown once the server has confirmed the approval. */
export function approvalMessage(r: ApproveResult): string {
  const hours = r.unpricedHours > 0 ? `${r.unpricedHours.toFixed(2)}h` : null;
  const where = r.progressClaim ? "progress claim" : "invoice";
  let msg: string;
  if (r.invoiceCreated) {
    msg = hours
      ? `A draft invoice was created with ${hours} of hours to price. Apply an hourly rate on the invoice from the web, then push it to Xero.`
      : "A draft invoice was created. Send it or push it to Xero from the web.";
  } else if (r.invoiceId) {
    msg = hours
      ? `${hours} of hours are NOT on the existing ${where} yet. Apply an hourly rate on it from the web` +
        (r.alreadyPushed ? ", then push it to Xero again." : ", then push it to Xero.")
      : `An ${where} already existed for this job — marked approved.`;
  } else {
    msg = "Moved to the Ready-to-Invoice queue (no line items or hours yet — build the invoice from the job).";
  }
  return [msg, ...r.warnings].join("\n\n");
}
