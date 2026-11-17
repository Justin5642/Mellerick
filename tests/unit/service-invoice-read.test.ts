import { describe, it, expect } from "vitest";
import { cleanServiceInvoice, sniffServiceInvoiceMime, type ServiceInvoiceRead } from "@/lib/service-invoice-read";
import { applyServiceInvoiceRead } from "@/lib/service-invoice-form";

// Fleet service invoices: what the reader returns is tidied, and it only fills
// what the office hasn't already typed.

const read = (over: Partial<ServiceInvoiceRead> = {}): ServiceInvoiceRead => ({
  is_service_invoice: true,
  provider: "  Hume Hwy Toyota ",
  invoice_number: "INV-4471",
  service_date: "2026-11-12",
  amount_ex_gst: 412.734,
  gst_amount: 41.27,
  odometer_km: 84210.4,
  engine_hours: null,
  service_type: "scheduled",
  work_done: "Oil and filter\nFront pads",
  next_due_date: "2027-05-12",
  next_due_km: 94210,
  next_due_hours: null,
  vehicle_text: "1AB 2CD HiLux",
  ...over,
});

describe("cleanServiceInvoice", () => {
  it("trims text, rounds money and readings", () => {
    const c = cleanServiceInvoice(read());
    expect(c.provider).toBe("Hume Hwy Toyota");
    expect(c.amount_ex_gst).toBe(412.73);
    expect(c.odometer_km).toBe(84210);
    expect(c.next_due_km).toBe(94210);
  });

  it("drops impossible dates, negatives and a next-due that isn't ahead", () => {
    const c = cleanServiceInvoice(read({
      service_date: "2026-02-31", amount_ex_gst: -5, next_due_km: 80000, next_due_date: "2026-01-01",
      service_type: "bogus" as never,
    }));
    expect(c.service_date).toBeNull();
    expect(c.amount_ex_gst).toBeNull();
    expect(c.next_due_km).toBeNull();
    expect(c.service_type).toBe("other");
  });

  it("drops a next-due date before the service date", () => {
    expect(cleanServiceInvoice(read({ next_due_date: "2026-11-01" })).next_due_date).toBeNull();
  });
});

describe("sniffServiceInvoiceMime", () => {
  it("knows PDF, JPEG, PNG and WebP by their bytes", () => {
    expect(sniffServiceInvoiceMime(Buffer.from("%PDF-1.7 rest"))).toBe("application/pdf");
    expect(sniffServiceInvoiceMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffServiceInvoiceMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(sniffServiceInvoiceMime(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]))).toBe("image/webp");
  });
  it("refuses anything else", () => {
    expect(sniffServiceInvoiceMime(Buffer.from("<html>"))).toBeNull();
  });
});

const TODAY = "2026-11-17";
const NEW = "__new__";
const blank = () => ({
  service_date: TODAY, service_type: "scheduled", odometer_km: "", engine_hours: "", provider: "",
  work_done: "", next_due_date: "", next_due_km: "", next_due_hours: "", expense: "",
  amount: "", gst_amount: "", invoice_number: "",
});

describe("applyServiceInvoiceRead", () => {
  it("fills an untouched form and switches the cost to 'log it now'", () => {
    const { form } = applyServiceInvoiceRead(blank(), cleanServiceInvoice(read()), TODAY, NEW);
    expect(form).toMatchObject({
      service_date: "2026-11-12", provider: "Hume Hwy Toyota", odometer_km: "84210",
      amount: "412.73", gst_amount: "41.27", invoice_number: "INV-4471",
      next_due_date: "2027-05-12", next_due_km: "94210", expense: NEW,
    });
  });

  it("never overwrites what the office typed", () => {
    const typed = { ...blank(), service_date: "2026-11-10", provider: "Our mechanic", odometer_km: "84000" };
    const { form, filled } = applyServiceInvoiceRead(typed, cleanServiceInvoice(read()), TODAY, NEW);
    expect(form.service_date).toBe("2026-11-10");
    expect(form.provider).toBe("Our mechanic");
    expect(form.odometer_km).toBe("84000");
    expect(filled).not.toContain("provider");
  });

  it("keeps an existing expense the office linked", () => {
    const linked = { ...blank(), expense: "exp-1" };
    expect(applyServiceInvoiceRead(linked, cleanServiceInvoice(read()), TODAY, NEW).form.expense).toBe("exp-1");
  });
});

describe("readerFailureSentence", () => {
  it("names status and error type, never the API's message", async () => {
    const { readerFailureSentence } = await import("@/lib/service-invoice-read");
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const e404 = Anthropic.APIError.generate(404, { type: "error", error: { type: "not_found_error", message: "secret detail" } }, "secret detail", new Headers());
    const s = readerFailureSentence(e404);
    expect(s).toContain("404 not_found_error");
    expect(s).not.toContain("secret");
    const e400 = Anthropic.APIError.generate(400, { type: "error", error: { type: "invalid_request_error", message: "x" } }, "x", new Headers());
    expect(readerFailureSentence(e400)).toContain("400 invalid_request_error");
    expect(readerFailureSentence(new Error("boom"))).toMatch(/could not be read/);
  });
});
