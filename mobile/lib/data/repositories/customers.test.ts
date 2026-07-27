import { CustomersRepository } from "./customers";
import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { Operation, WriteOperation } from "../outbox/types";
import type { TimeSource } from "../time";

function seqIds(): IdGen {
  let n = 0;
  return { newId: () => `id-${++n}` };
}
const fixedTime = (ms = 1_000): TimeSource => ({ nowMs: () => ms, nowIso: () => "2026-07-26T00:00:00.000Z" });

function captureOutbox(): { outbox: Outbox; ops: WriteOperation[] } {
  const ops: WriteOperation[] = [];
  const outbox = { enqueue: jest.fn(async (op: Operation) => void ops.push(op as WriteOperation)) } as unknown as Outbox;
  return { outbox, ops };
}

describe("CustomersRepository", () => {
  it("createCustomer inserts an active customer with the mapped columns and returns its id", async () => {
    const { outbox, ops } = captureOutbox();
    const id = await new CustomersRepository(outbox, seqIds(), fixedTime()).createCustomer({ name: "Acme", company: "Acme Pty", email: "a@b.com" });
    expect(id).toBe("id-1");
    expect(ops[0]).toMatchObject({ table: "customers", op: "insert", rowId: "id-1" });
    expect(ops[0].payload).toEqual({ name: "Acme", company: "Acme Pty", email: "a@b.com", phone: null, mobile: null, abn: null, notes: null, is_active: true });
  });

  it("updateCustomer updates the fields WITHOUT resetting is_active", async () => {
    const { outbox, ops } = captureOutbox();
    await new CustomersRepository(outbox, seqIds(), fixedTime()).updateCustomer("c1", { name: "Renamed" });
    expect(ops[0]).toMatchObject({ table: "customers", op: "update", rowId: "c1" });
    expect(ops[0].payload).not.toHaveProperty("is_active");
    expect(ops[0].payload.name).toBe("Renamed");
  });

  it("deactivateCustomer soft-deletes", async () => {
    const { outbox, ops } = captureOutbox();
    await new CustomersRepository(outbox, seqIds(), fixedTime()).deactivateCustomer("c1");
    expect(ops[0]).toMatchObject({ table: "customers", op: "update", rowId: "c1", payload: { is_active: false } });
  });

  it("setFavorite marks a customer as favourite without touching other columns", async () => {
    const { outbox, ops } = captureOutbox();
    await new CustomersRepository(outbox, seqIds(), fixedTime()).setFavorite("c1", true);
    expect(ops[0]).toMatchObject({ table: "customers", op: "update", rowId: "c1", payload: { is_favorite: true } });
    expect(Object.keys(ops[0].payload)).toEqual(["is_favorite"]);
  });

  it("setFavorite can clear the favourite flag", async () => {
    const { outbox, ops } = captureOutbox();
    await new CustomersRepository(outbox, seqIds(), fixedTime()).setFavorite("c1", false);
    expect(ops[0].payload).toEqual({ is_favorite: false });
  });

  it("createSite maps the address columns and links the customer", async () => {
    const { outbox, ops } = captureOutbox();
    const id = await new CustomersRepository(outbox, seqIds(), fixedTime()).createSite({
      customerId: "c1",
      name: "HQ",
      addressLine1: "1 Main St",
      suburb: "Richmond",
      state: "VIC",
      postcode: "3121",
    });
    expect(id).toBe("id-1");
    expect(ops[0]).toMatchObject({ table: "sites", op: "insert", rowId: "id-1" });
    expect(ops[0].payload).toEqual({ customer_id: "c1", name: "HQ", address_line1: "1 Main St", address_line2: null, suburb: "Richmond", state: "VIC", postcode: "3121", notes: null });
  });

  it("removeSite enqueues a delete", async () => {
    const { outbox, ops } = captureOutbox();
    await new CustomersRepository(outbox, seqIds(), fixedTime()).removeSite("s1");
    expect(ops[0]).toMatchObject({ table: "sites", op: "delete", rowId: "s1" });
  });
});
