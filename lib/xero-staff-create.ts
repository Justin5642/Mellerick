// Adding Xero employees who aren't in the app yet (Staff → Import from Xero).
//
// Every staff member is a login (profiles.id = auth.users.id). These are made
// QUIETLY — no invite email (Justin, 15 Nov 2026: "create the accounts quietly,
// I'll send invites later"). The person can't sign in until an admin presses
// "Resend Invite" on the Staff page, which sends the normal invite email.
//
// handle_new_user() (0044) inserts the profile when the login is created and,
// because this isn't an invite, sets the role to technician. The profile is
// then upserted with the chosen role as the service role, which 0044's
// role-change trigger allows. If that fails the login is deleted again, so a
// half-made person is never left behind.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { XeroEmployee } from "@/lib/xero-payroll";

export const NEW_STAFF_ROLES = ["technician", "office", "admin"] as const;
export type NewStaffRole = (typeof NEW_STAFF_ROLES)[number];

export interface StaffCreate {
  xeroEmployeeId: string;
  role: NewStaffRole;
}

export interface PlannedCreate extends StaffCreate {
  fullName: string;
  email: string;
  phone: string | null;
}

export interface CreateFailure {
  staffName: string;
  error: string;
}

/** Everyone already in the app, by lower-cased email — active or not. */
export type ExistingByEmail = ReadonlyMap<string, { name: string; active: boolean }>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const xeroName = (e: Pick<XeroEmployee, "firstName" | "lastName">) => `${e.firstName ?? ""} ${e.lastName ?? ""}`.trim() || "Unnamed";

/** Why this Xero employee can't be added, or null when they can. */
export function cannotAddReason(e: Pick<XeroEmployee, "email">, existing: ExistingByEmail): string | null {
  const email = (e.email ?? "").trim().toLowerCase();
  if (!email) return "No email address in Xero. Add one there, then reload.";
  if (!EMAIL_RE.test(email)) return `"${e.email}" in Xero isn't a valid email address.`;
  const found = existing.get(email);
  if (found?.active) return `Already in the app as ${found.name} — pair them instead.`;
  if (found) return `${found.name} has this email but is deactivated. Reactivate them on the Staff page, then pair.`;
  return null;
}

/** Checks the request against the current Xero snapshot and the app's people. Pure. */
export function planStaffCreates(
  employees: readonly XeroEmployee[],
  existing: ExistingByEmail,
  creates: readonly StaffCreate[]
): { planned: PlannedCreate[]; failures: CreateFailure[] } {
  const planned: PlannedCreate[] = [];
  const failures: CreateFailure[] = [];
  const seenE = new Set<string>();
  const seenEmail = new Set<string>();
  for (const c of creates) {
    const e = employees.find((x) => x.employeeID === c.xeroEmployeeId);
    if (!e) {
      failures.push({ staffName: "Unknown person", error: "No longer a current employee in Xero — reload the preview." });
      continue;
    }
    const name = xeroName(e);
    if (seenE.has(c.xeroEmployeeId)) continue;
    seenE.add(c.xeroEmployeeId);
    const why = cannotAddReason(e, existing);
    if (why) {
      failures.push({ staffName: name, error: why });
      continue;
    }
    const email = e.email!.trim().toLowerCase();
    if (seenEmail.has(email)) {
      failures.push({ staffName: name, error: "Shares an email with another person being added. Each person needs their own." });
      continue;
    }
    seenEmail.add(email);
    planned.push({ ...c, fullName: name, email, phone: (e.mobile || e.phone || "").trim() || null });
  }
  return { planned, failures };
}

/** Makes the logins and profiles. `admin` must be the service-role client. */
export async function createStaffAccounts(
  admin: SupabaseClient,
  planned: readonly PlannedCreate[]
): Promise<{ created: { staffId: string; xeroEmployeeId: string; name: string }[]; failures: CreateFailure[] }> {
  const created: { staffId: string; xeroEmployeeId: string; name: string }[] = [];
  const failures: CreateFailure[] = [];
  for (const p of planned) {
    const made = await admin.auth.admin.createUser({
      email: p.email,
      email_confirm: false,
      user_metadata: { full_name: p.fullName, role: p.role },
    });
    if (made.error || !made.data?.user) {
      const taken = /already|exists|registered/i.test(made.error?.message ?? "");
      if (!taken) console.error("xero staff create: createUser failed:", made.error?.message);
      failures.push({
        staffName: p.fullName,
        error: taken ? "A login with this email already exists. Check the Staff page (it may be deactivated)." : "Couldn't create their login. Try again.",
      });
      continue;
    }
    const id = made.data.user.id;
    const prof = await admin
      .from("profiles")
      .upsert({ id, full_name: p.fullName, email: p.email, phone: p.phone, role: p.role, is_active: true }, { onConflict: "id" });
    if (prof.error) {
      console.error("xero staff create: profile failed:", prof.error.message);
      const undo = await admin.auth.admin.deleteUser(id);
      if (undo.error) console.error("xero staff create: couldn't remove the half-made login", id, undo.error.message);
      failures.push({ staffName: p.fullName, error: "Couldn't save them as staff. Nothing was kept — try again." });
      continue;
    }
    created.push({ staffId: id, xeroEmployeeId: p.xeroEmployeeId, name: p.fullName });
  }
  return { created, failures };
}

/** The app's people by email, for cannotAddReason. */
export async function loadExistingByEmail(db: Pick<SupabaseClient, "from">): Promise<Map<string, { name: string; active: boolean }>> {
  const res = await db.from("profiles").select("full_name, email, is_active");
  if (res.error) throw new Error(`Couldn't read staff (${res.error.message}).`);
  const out = new Map<string, { name: string; active: boolean }>();
  for (const p of (res.data ?? []) as { full_name: string | null; email: string | null; is_active: boolean | null }[]) {
    if (p.email) out.set(p.email.trim().toLowerCase(), { name: p.full_name ?? "Unnamed", active: p.is_active !== false });
  }
  return out;
}
