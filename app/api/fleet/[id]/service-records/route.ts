import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { reportError } from "@/lib/monitoring";
import { isServiceTableMissing, serviceInvoicePath } from "@/lib/service-due";
import { decodeFleetUpload, isUuid, parseServiceRecordBody, serviceExpenseRow } from "@/lib/fleet-office";

// Fleet → Service history for one machine, for the phone (office/admin; the
// web's "Log a service" in components/fleet/equipment-service-records.tsx).
//
// GET   the machine's service records and its expenses (to link one, or open
//       a service's invoice).
// POST  log a service: [invoice copy uploaded] → [new cost] → the service, in
//       that order, exactly as the web does. A failed upload saves nothing; a
//       failed cost or service removes what was saved before it. Everything
//       runs as the CALLER (RLS: 0099 / equipment_expenses / 0047 storage).
//
// The invoice copy is stored at serviceInvoicePath() — the `expense-receipt-`
// shape 0047 keeps from technicians.

type Ctx = { params: Promise<{ id: string }> };

const NOT_FOUND = "That machine isn't in the fleet register.";
const LOAD_FAILED = "Couldn't load the service history. Try again.";
const SAVE_FAILED = "Couldn't save the service. Nothing was saved — try again.";
const EXPENSE_COLUMNS = "id, category, supplier_name, invoice_number, expense_date, amount, gst_amount, receipt_storage_path";

export async function GET(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  if (!isUuid(id)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

  const db = await callerClient(request);
  const [records, expenses] = await Promise.all([
    db.from("equipment_service_records").select("*").eq("equipment_id", id).order("service_date", { ascending: false }),
    db.from("equipment_expenses").select(EXPENSE_COLUMNS).eq("equipment_id", id).order("expense_date", { ascending: false }),
  ]);
  if (expenses.error) {
    console.error("fleet service records: expenses read failed", expenses.error);
    return NextResponse.json({ error: LOAD_FAILED }, { status: 500 });
  }
  if (records.error) {
    if (isServiceTableMissing(records.error)) return NextResponse.json({ ready: false, records: [], expenses: expenses.data ?? [] });
    console.error("fleet service records: read failed", records.error);
    return NextResponse.json({ error: LOAD_FAILED }, { status: 500 });
  }
  return NextResponse.json({ ready: true, records: records.data ?? [], expenses: expenses.data ?? [] });
}

export async function POST(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  if (!isUuid(id)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

  const parsed = parseServiceRecordBody(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const w = parsed.value;

  let file: { bytes: Buffer; mime: string } | null = null;
  if (w.invoice) {
    const decoded = decodeFleetUpload(w.invoice.base64);
    if (!decoded.ok) return NextResponse.json({ error: decoded.error }, { status: 400 });
    file = decoded.value;
  }

  const db = await callerClient(request);
  try {
    const { data: machine, error: machineError } = await db.from("equipment").select("id").eq("id", id).maybeSingle();
    if (machineError) throw machineError;
    if (!machine) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

    // A retry of a service that already saved (the answer was lost) is
    // answered as saved, and nothing is logged twice.
    if (w.id) {
      const { data: existing, error: existingError } = await db
        .from("equipment_service_records").select("*").eq("id", w.id).eq("equipment_id", id).maybeSingle();
      if (existingError) {
        if (isServiceTableMissing(existingError)) return NextResponse.json({ error: "Service records aren't switched on in this database yet." }, { status: 409 });
        throw existingError;
      }
      if (existing) return NextResponse.json({ record: existing, expense: null, replay: true });
    }

    if (w.expense.kind === "existing") {
      const { data: exp, error: expError } = await db
        .from("equipment_expenses").select("id").eq("id", w.expense.id).eq("equipment_id", id).maybeSingle();
      if (expError) throw expError;
      if (!exp) return NextResponse.json({ error: "That cost isn't logged against this machine." }, { status: 400 });
    }

    // 0. The invoice copy first, so a failed upload saves nothing.
    let invoicePath: string | null = null;
    if (file && w.invoice) {
      invoicePath = serviceInvoicePath(id, w.invoice.fileName, Date.now());
      const { error: upError } = await db.storage.from("equipment-documents").upload(invoicePath, file.bytes, { contentType: file.mime });
      if (upError) {
        console.error("fleet service records: invoice upload failed", upError);
        return NextResponse.json({ error: "The invoice file could not be uploaded. Nothing was saved." }, { status: 502 });
      }
    }
    const dropInvoice = async () => {
      if (!invoicePath) return;
      const { error } = await db.storage.from("equipment-documents").remove([invoicePath]);
      if (error) console.error("fleet service records: invoice clean-up failed", invoicePath, error);
    };

    // 1. The new cost, so the service can point at it.
    let expenseId: string | null = w.expense.kind === "existing" ? w.expense.id : null;
    let createdExpense: Record<string, unknown> | null = null;
    const expenseRow = serviceExpenseRow(id, w, guard.userId, invoicePath);
    if (expenseRow) {
      const { data, error } = await db.from("equipment_expenses").insert(expenseRow).select(EXPENSE_COLUMNS).single();
      if (error || !data) {
        console.error("fleet service records: cost insert failed", error);
        await dropInvoice();
        return NextResponse.json({ error: "The cost could not be saved. Nothing was saved." }, { status: 500 });
      }
      createdExpense = data as Record<string, unknown>;
      expenseId = createdExpense.id as string;
    }

    // 2. The service.
    const { data: record, error: recError } = await db
      .from("equipment_service_records")
      .insert({ ...(w.id ? { id: w.id } : {}), equipment_id: id, ...w.record, expense_id: expenseId })
      .select("*")
      .single();
    if (recError || !record) {
      console.error("fleet service records: insert failed", recError);
      if (createdExpense) {
        const { error: undoError, count } = await db.from("equipment_expenses").delete({ count: "exact" }).eq("id", expenseId!);
        if (undoError || count === 0) {
          console.error("fleet service records: cost undo failed", expenseId, undoError);
          return NextResponse.json(
            { error: "The service could not be saved. Its cost was saved but could not be removed again — delete it from the Expenses list." },
            { status: 500 },
          );
        }
        await dropInvoice();
      }
      if (isServiceTableMissing(recError)) return NextResponse.json({ error: "Service records aren't switched on in this database yet." }, { status: 409 });
      return NextResponse.json({ error: SAVE_FAILED }, { status: 500 });
    }
    return NextResponse.json({ record, expense: createdExpense });
  } catch (err) {
    console.error("fleet service records: save failed", err);
    reportError(err, { route: "api/fleet/[id]/service-records" });
    return NextResponse.json({ error: SAVE_FAILED }, { status: 500 });
  }
}
