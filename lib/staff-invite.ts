// Shared rules for the /api/staff routes (web Staff page and the phone's Staff
// screen both call them).

export const STAFF_ROLES: readonly string[] = ["technician", "office", "admin"];

/** GoTrue's "this email already has an account" refusal, whatever its exact wording. */
export function alreadyRegistered(message: string | null | undefined): boolean {
  return /already.*registered|already.*exists|already been registered/i.test(message ?? "");
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trimmed, lowercased — profiles.email must match what Supabase Auth keeps. Null when not an email. */
export function normaliseStaffEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return EMAIL.test(email) ? email : null;
}
