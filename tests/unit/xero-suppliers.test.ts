import { describe, it, expect, vi } from "vitest";

// The supplier list is copied from Xero (migration 0087). Xero owns the name,
// account number, phone and active flag; the ordering email is the office's
// once they have set one, so the nightly copy must not overwrite it.

const getContacts = vi.fn();
vi.mock("@/lib/xero", () => ({
  getRefreshedXero: vi.fn(async () => ({ xero: { accountingApi: { getContacts } }, tenantId: "tenant-1" })),
}));

import { supplierFromXeroContact, syncXeroSuppliers } from "@/lib/xero-suppliers";

const contact = (over: Record<string, unknown> = {}) => ({
  contactID: "c-1",
  name: " Reece Epping ",
  isSupplier: true,
  accountNumber: "MELL01",
  emailAddress: "accounts@reece.example",
  contactStatus: "ACTIVE",
  phones: [
    { phoneType: "MOBILE", phoneNumber: "" },
    { phoneType: "DEFAULT", phoneAreaCode: "03", phoneNumber: "9400 0000" },
  ],
  ...over,
});

describe("supplierFromXeroContact", () => {
  it("maps a Xero supplier", () => {
    expect(supplierFromXeroContact(contact() as never)).toEqual({
      xero_contact_id: "c-1",
      name: "Reece Epping",
      account_number: "MELL01",
      email: "accounts@reece.example",
      phone: "03 9400 0000",
      is_active: true,
    });
  });

  it("marks archived suppliers inactive", () => {
    expect(supplierFromXeroContact(contact({ contactStatus: "ARCHIVED" }) as never)?.is_active).toBe(false);
  });

  it("skips customers and nameless contacts", () => {
    expect(supplierFromXeroContact(contact({ isSupplier: false }) as never)).toBeNull();
    expect(supplierFromXeroContact(contact({ name: "  " }) as never)).toBeNull();
  });
});

function fakeAdmin(existing: { xero_contact_id: string; email: string | null }[]) {
  const upserts: unknown[] = [];
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.not = () => Promise.resolve({ data: existing, error: null });
  chain.upsert = (rows: unknown, opts: unknown) => {
    upserts.push({ rows, opts });
    return Promise.resolve({ error: null });
  };
  return { admin: { from: () => chain }, upserts };
}

describe("syncXeroSuppliers", () => {
  it("keeps an ordering email the office set, fills one that is empty, and counts new ones", async () => {
    getContacts.mockResolvedValueOnce({
      body: {
        contacts: [
          contact({ contactID: "c-1" }),
          contact({ contactID: "c-2", name: "Boral Quarries", emailAddress: "ap@boral.example" }),
          contact({ contactID: "c-3", name: "New Supplier" }),
        ],
      },
    });
    const { admin, upserts } = fakeAdmin([
      { xero_contact_id: "c-1", email: "orders@reece.example" },
      { xero_contact_id: "c-2", email: null },
    ]);
    const result = await syncXeroSuppliers(admin as never);
    expect(result).toEqual({ added: 1, updated: 2, total: 3 });
    const { rows, opts } = upserts[0] as { rows: { xero_contact_id: string; email: string | null }[]; opts: unknown };
    expect(opts).toEqual({ onConflict: "xero_contact_id" });
    expect(rows.find((r) => r.xero_contact_id === "c-1")?.email).toBe("orders@reece.example");
    expect(rows.find((r) => r.xero_contact_id === "c-2")?.email).toBe("ap@boral.example");
  });

  it("pages until Xero returns a short page", async () => {
    getContacts.mockReset();
    const full = Array.from({ length: 100 }, (_, i) => contact({ contactID: `p1-${i}` }));
    getContacts.mockResolvedValueOnce({ body: { contacts: full } }).mockResolvedValueOnce({ body: { contacts: [contact({ contactID: "p2-0" })] } });
    const { admin } = fakeAdmin([]);
    const result = await syncXeroSuppliers(admin as never);
    expect(getContacts).toHaveBeenCalledTimes(2);
    expect(result.total).toBe(101);
  });
});
