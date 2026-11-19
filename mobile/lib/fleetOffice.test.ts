jest.mock("./supabase", () => ({ supabase: { auth: { getSession: jest.fn() } } }));

import {
  NEW_EXPENSE,
  base64Bytes,
  blankHireRow,
  blankServiceForm,
  hireRowPayload,
  hireSetupProblem,
  readNoteFor,
  serviceFormProblem,
  servicePayload,
  withHireType,
} from "./fleetOffice";
import { applyServiceInvoiceRead, type ServiceInvoiceReadResult } from "./serviceInvoiceForm";
import { serviceDue } from "./serviceDue";

// The phone's Fleet office forms refuse what the server would refuse
// (lib/fleet-office.ts), so the office hears before tapping Save.

const TODAY = "2026-11-19";

describe("Log a service form", () => {
  it("accepts a blank service (no cost)", () => {
    expect(serviceFormProblem(blankServiceForm(TODAY))).toBeNull();
  });

  it("checks the date, readings, next-due and the cost", () => {
    const f = blankServiceForm(TODAY);
    expect(serviceFormProblem({ ...f, service_date: "19/11/2026" })).toMatch(/service date/);
    expect(serviceFormProblem({ ...f, odometer_km: "-4" })).toMatch(/numbers/);
    expect(serviceFormProblem({ ...f, next_due_date: "2026-11-01" })).toMatch(/after the service date/);
    expect(serviceFormProblem({ ...f, odometer_km: "1000", next_due_km: "900" })).toMatch(/odometer/);
    expect(serviceFormProblem({ ...f, expense: NEW_EXPENSE, amount: "" })).toMatch(/amount/);
    expect(serviceFormProblem({ ...f, expense: NEW_EXPENSE, amount: "300" })).toBeNull();
  });

  it("sends the invoice only with a new cost", () => {
    const f = { ...blankServiceForm(TODAY), expense: NEW_EXPENSE, amount: "300", gst_amount: "30" };
    const inv = { fileBase64: "abc", fileName: "i.jpg" };
    expect(servicePayload(f, "id-1", inv)).toMatchObject({ id: "id-1", expense: "new", amount: "300", invoice: inv });
    const linked = servicePayload({ ...f, expense: "exp-1" }, "id-1", inv);
    expect(linked).toMatchObject({ expense: "exp-1" });
    expect(linked).not.toHaveProperty("invoice");
    expect(linked).not.toHaveProperty("amount");
    expect(servicePayload(blankServiceForm(TODAY), "id-1", null)).toMatchObject({ expense: "none", next_due_date: null });
  });

  it("an invoice read fills only what's still empty and switches to logging the cost", () => {
    const read: ServiceInvoiceReadResult = {
      is_service_invoice: true, provider: "Truck Centre", invoice_number: "INV-9", service_date: "2026-11-10",
      amount_ex_gst: 300, gst_amount: 30, odometer_km: 84000, engine_hours: null, service_type: "repair",
      work_done: "Brakes", next_due_date: null, next_due_km: null, next_due_hours: null, vehicle_text: "Isuzu NPR",
    };
    const typed = { ...blankServiceForm(TODAY), provider: "Typed by office" };
    const { form } = applyServiceInvoiceRead(typed, read, TODAY, NEW_EXPENSE);
    expect(form).toMatchObject({ provider: "Typed by office", service_date: "2026-11-10", service_type: "repair", amount: "300", expense: NEW_EXPENSE });
    expect(readNoteFor(read)).toEqual({ tone: "ok", text: "Invoice is for: Isuzu NPR — check it's this machine. Details read from the invoice — check them, then save." });
    expect(readNoteFor({ ...read, is_service_invoice: false, vehicle_text: null }).tone).toBe("warn");
  });

  it("works out the next service due from the latest planner", () => {
    const d = serviceDue([{ id: "a", equipment_id: "e", service_date: "2026-10-01", service_type: "scheduled", odometer_km: null, engine_hours: null, next_due_date: "2026-12-01", next_due_km: null, next_due_hours: null }], TODAY);
    expect(d.state).toBe("due_soon");
    expect(d.daysUntil).toBe(12);
  });

  it("measures a base64 payload in bytes", () => {
    expect(base64Bytes("AAAA")).toBe(3);
    expect(base64Bytes("AAA=")).toBe(2);
    expect(base64Bytes("AA==")).toBe(1);
  });
});

describe("Hire setup form", () => {
  it("resets the unit when the hire type changes", () => {
    expect(withHireType(blankHireRow("k"), "cartage")).toMatchObject({ hire_type: "cartage", hire_unit: "hour" });
    expect(withHireType(blankHireRow("k"), "float")).toMatchObject({ hire_unit: "move" });
  });

  it("refuses duplicates, wrong units and negative rates", () => {
    const wet = blankHireRow("a");
    expect(hireSetupProblem([wet, { ...wet, key: "b" }])).toMatch(/once per machine/);
    expect(hireSetupProblem([{ ...wet, hire_unit: "tonne" }])).toMatch(/hired and charged/);
    expect(hireSetupProblem([{ ...wet, rate: "-5" }])).toMatch(/negative/);
    expect(hireSetupProblem([{ ...withHireType(wet, "cartage"), hire_unit: "tonne", rate: "12.5" }])).toBeNull();
  });

  it("never sends the local key", () => {
    expect(hireRowPayload(blankHireRow("local-key"))).not.toHaveProperty("key");
  });
});
