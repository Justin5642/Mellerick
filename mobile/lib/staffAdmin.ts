import { officeApi } from "./officeApi";

// Admin staff actions on the phone, through the same web routes the Staff page
// uses (all requireAdmin on the server; they need the service role for Supabase
// Auth, which never leaves the server):
//   POST /api/staff/invite          — new staff member, emailed an invite
//   POST /api/staff/resend-invite   — a fresh invite link
//   POST /api/staff/update          — name, login email, phone, role
//   POST /api/staff/set-auto-clock  — profiles.auto_clock (0082)
// Online only — each needs the server's answer (an email sent, a login changed).

export type StaffRole = "technician" | "office" | "admin";

export interface InviteInput {
  full_name: string;
  email: string;
  phone: string;
  role: StaffRole;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Why an invite/edit can't be sent yet, or null. The server checks again. */
export function staffFormProblem(input: { full_name: string; email: string }): string | null {
  if (!input.full_name.trim()) return "Enter their name.";
  if (!EMAIL.test(input.email.trim())) return "Enter a valid email address — it's their login.";
  return null;
}

export function inviteStaff(input: InviteInput): Promise<{ success: true }> {
  return officeApi("/api/staff/invite", {
    method: "POST",
    body: { full_name: input.full_name.trim(), email: input.email.trim().toLowerCase(), phone: input.phone.trim(), role: input.role },
  });
}

export function resendInvite(member: { email: string; full_name: string; role: string }): Promise<{ success: true }> {
  return officeApi("/api/staff/resend-invite", { method: "POST", body: { email: member.email, full_name: member.full_name, role: member.role } });
}

/** Name, login email, phone and role in one call — the route also moves the Supabase Auth login when the email changes. */
export function updateStaffLogin(input: { id: string; full_name: string; email: string; phone: string; role: string }): Promise<{ success: true }> {
  return officeApi("/api/staff/update", {
    method: "POST",
    body: { id: input.id, full_name: input.full_name.trim(), email: input.email.trim().toLowerCase(), phone: input.phone.trim(), role: input.role },
  });
}

export function setAutoClock(id: string, enabled: boolean): Promise<{ success: true }> {
  return officeApi("/api/staff/set-auto-clock", { method: "POST", body: { id, enabled } });
}

/**
 * Whether someone is auto clocked on/off at sites — the effective value the
 * switch shows. profiles.auto_clock NULL = by role (technicians on, office and
 * admin off); true/false is an admin's choice. Same rule as the web's
 * lib/auto-clock.ts and the phone's trackingGate.
 */
export function autoClockEnabled(p: { role: string | null; auto_clock?: boolean | null }): boolean {
  return p.auto_clock ?? p.role === "technician";
}

/** Did the name or login email change? Only then is the update route (and its Auth write) needed. */
export function loginDetailsChanged(before: { full_name: string; email: string }, after: { full_name: string; email: string }): boolean {
  return before.full_name.trim() !== after.full_name.trim() || before.email.trim().toLowerCase() !== after.email.trim().toLowerCase();
}
