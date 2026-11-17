import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { consumeRateLimit, rateLimitedResponse, SERVICE_INVOICE_READ_LIMIT } from "@/lib/api/rate-limit";
import { reportError, reportFailure } from "@/lib/monitoring";
import {
  MAX_SERVICE_INVOICE_BYTES,
  readServiceInvoice,
  ServiceInvoiceReadError,
  sniffServiceInvoiceMime,
} from "@/lib/service-invoice-read";

// Read a dropped fleet service invoice (PDF or photo) and return the fields
// for the "Log a service" form. Office/admin only — the same people who may
// log a service (0099 RLS). Nothing is stored here; the browser fills its
// form and the office checks it and presses Save as before.

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;

  const body = await request.json().catch(() => null);
  const b64 = typeof body?.fileBase64 === "string" ? body.fileBase64 : "";
  if (!b64) return NextResponse.json({ error: "Drop the invoice first." }, { status: 400 });

  const file = Buffer.from(b64, "base64");
  if (file.length === 0) return NextResponse.json({ error: "The file was empty." }, { status: 400 });
  if (file.length > MAX_SERVICE_INVOICE_BYTES) {
    return NextResponse.json(
      { error: "This file is too large to read (over 3 MB). Fill the details in by hand — it is still saved with the service." },
      { status: 413 },
    );
  }
  // Trust the bytes, not the claimed type.
  const mime = sniffServiceInvoiceMime(file);
  if (!mime) {
    return NextResponse.json({ error: "Only PDF, JPEG, PNG or WebP invoices can be read." }, { status: 415 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    reportFailure("ANTHROPIC_API_KEY is not configured", { route: "api/fleet/service-invoice/read", integration: "anthropic" });
    return NextResponse.json({ error: "The invoice reader is not set up on the server." }, { status: 500 });
  }
  if (!(await consumeRateLimit(guard.userId, SERVICE_INVOICE_READ_LIMIT))) return rateLimitedResponse();

  try {
    const read = await readServiceInvoice(file, mime);
    return NextResponse.json({ read });
  } catch (err) {
    // Only ServiceInvoiceReadError carries a sentence written for the office.
    const known = err instanceof ServiceInvoiceReadError;
    const message = known ? err.message : "The invoice could not be read just now. Fill the details in by hand.";
    if (known) return NextResponse.json({ error: message }, { status: 422 });
    console.error("service invoice read failed:", (err as { message?: string })?.message ?? err);
    reportError(err, { route: "api/fleet/service-invoice/read", integration: "anthropic" });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
