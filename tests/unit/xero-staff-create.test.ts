import { describe, expect, it, vi } from "vitest";
import { cannotAddReason, createStaffAccounts, planStaffCreates } from "@/lib/xero-staff-create";
import { xeroErrorInfo } from "@/lib/xero-payroll-import";

const emp = (id: string, first: string, email?: string, extra: Record<string, unknown> = {}) =>
  ({ employeeID: id, firstName: first, lastName: "Smith", email, ...extra }) as any;
const existing = new Map([
  ["sam@x.com", { name: "Sam Smith", active: true }],
  ["old@x.com", { name: "Old Hand", active: false }],
]);

describe("who can be added from Xero", () => {
  it("needs a valid email that nobody in the app has", () => {
    expect(cannotAddReason({ email: "new@x.com" }, existing)).toBeNull();
    expect(cannotAddReason({ email: undefined }, existing)).toMatch(/No email/);
    expect(cannotAddReason({ email: "not-an-email" }, existing)).toMatch(/isn't a valid/);
    expect(cannotAddReason({ email: " SAM@x.com " }, existing)).toMatch(/Already in the app as Sam Smith/);
    expect(cannotAddReason({ email: "old@x.com" }, existing)).toMatch(/deactivated/);
  });

  it("plans only addable, current, distinct people", () => {
    const employees = [emp("a", "Ann", "Ann@X.com", { mobile: "0400 000 000" }), emp("b", "Bob"), emp("c", "Cat", "ann@x.com")];
    const { planned, failures } = planStaffCreates(employees, existing, [
      { xeroEmployeeId: "a", role: "office" },
      { xeroEmployeeId: "a", role: "office" },
      { xeroEmployeeId: "b", role: "technician" },
      { xeroEmployeeId: "c", role: "technician" },
      { xeroEmployeeId: "gone", role: "technician" },
    ]);
    expect(planned).toEqual([{ xeroEmployeeId: "a", role: "office", fullName: "Ann Smith", email: "ann@x.com", phone: "0400 000 000" }]);
    expect(failures.map((f) => f.staffName)).toEqual(["Bob Smith", "Cat Smith", "Unknown person"]);
  });
});

describe("creating the accounts", () => {
  const fakeAdmin = (opts: { createError?: string; profileError?: string }) => {
    const deleteUser = vi.fn(async () => ({ error: null }));
    const createUser = vi.fn(async () =>
      opts.createError ? { data: { user: null }, error: { message: opts.createError } } : { data: { user: { id: "u1" } }, error: null }
    );
    const upsert = vi.fn(async () => ({ error: opts.profileError ? { message: opts.profileError } : null }));
    const admin = { auth: { admin: { createUser, deleteUser } }, from: () => ({ upsert }) } as any;
    return { admin, createUser, deleteUser, upsert };
  };
  const plan = [{ xeroEmployeeId: "a", role: "office" as const, fullName: "Ann Smith", email: "ann@x.com", phone: null }];

  it("creates a login without sending an invite, then sets the chosen role", async () => {
    const f = fakeAdmin({});
    const r = await createStaffAccounts(f.admin, plan);
    expect(r.created).toEqual([{ staffId: "u1", xeroEmployeeId: "a", name: "Ann Smith" }]);
    expect(f.createUser).toHaveBeenCalledWith(expect.objectContaining({ email: "ann@x.com", email_confirm: false }));
    expect(f.upsert).toHaveBeenCalledWith(expect.objectContaining({ id: "u1", role: "office", is_active: true }), { onConflict: "id" });
  });

  it("removes the login again if the staff record can't be saved", async () => {
    const f = fakeAdmin({ profileError: "boom" });
    const r = await createStaffAccounts(f.admin, plan);
    expect(r.created).toEqual([]);
    expect(f.deleteUser).toHaveBeenCalledWith("u1");
    expect(r.failures[0].error).toMatch(/Nothing was kept/);
  });

  it("explains an email that already has a login", async () => {
    const f = fakeAdmin({ createError: "A user with this email address has already been registered" });
    const r = await createStaffAccounts(f.admin, plan);
    expect(r.failures[0].error).toMatch(/already exists/);
  });
});

describe("xeroErrorInfo", () => {
  it("reads status and Retry-After from objects and JSON strings", () => {
    expect(xeroErrorInfo({ response: { statusCode: 429, headers: { "retry-after": "7" } } })).toEqual({ status: 429, retryAfter: 7 });
    expect(xeroErrorInfo(JSON.stringify({ response: { statusCode: 503, headers: {} } }))).toEqual({ status: 503, retryAfter: undefined });
    expect(xeroErrorInfo(new Error("socket hang up"))).toEqual({ status: undefined, retryAfter: undefined });
    expect(xeroErrorInfo("not json")).toEqual({ status: undefined, retryAfter: undefined });
  });
});

import { enteredByHand } from "@/lib/xero-payroll-import";

describe("Xero leave already typed into the app", () => {
  const hand = [{ staffId: "s1", leaveType: "sick", start: "2026-10-06", end: "2026-10-07" }];
  it("skips the same person, type and overlapping days", () => {
    expect(enteredByHand({ leaveType: "sick", start: "2026-10-07", end: "2026-10-07" }, "s1", hand)).toBe(true);
  });
  it("keeps different people, types or days", () => {
    expect(enteredByHand({ leaveType: "sick", start: "2026-10-07", end: "2026-10-07" }, "s2", hand)).toBe(false);
    expect(enteredByHand({ leaveType: "annual", start: "2026-10-07", end: "2026-10-07" }, "s1", hand)).toBe(false);
    expect(enteredByHand({ leaveType: "sick", start: "2026-10-08", end: "2026-10-09" }, "s1", hand)).toBe(false);
  });
});
