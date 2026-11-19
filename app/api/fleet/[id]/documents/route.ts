import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { decodeFleetUpload, equipmentDocumentPath, isUuid, safeFileName } from "@/lib/fleet-office";

// Upload one document to a machine from the phone (office/admin; the web's
// components/fleet/equipment-documents.tsx): registration papers, insurance,
// compliance certs. File first, then its equipment_documents row, both as the
// CALLER — equipment-documents is office/admin only for every command (0047).
// A failed row removes the file again, so nothing is left half-saved.
//
// Body: { fileBase64, fileName } — ≤ 3 MB (it travels inside the request),
// PDF / JPEG / PNG / WebP by the bytes.

type Ctx = { params: Promise<{ id: string }> };

const NOT_FOUND = "That machine isn't in the fleet register.";

export async function POST(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  if (!isUuid(id)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

  const body = (await request.json().catch(() => null)) as { fileBase64?: unknown; fileName?: unknown } | null;
  if (typeof body?.fileBase64 !== "string" || body.fileBase64 === "") {
    return NextResponse.json({ error: "Pick a file first." }, { status: 400 });
  }
  const decoded = decodeFleetUpload(body.fileBase64);
  if (!decoded.ok) return NextResponse.json({ error: decoded.error }, { status: 400 });
  const { bytes, mime } = decoded.value;
  const fileName = safeFileName(body.fileName, mime === "application/pdf" ? "document.pdf" : "photo.jpg");

  const db = await callerClient(request);
  const { data: machine, error: machineError } = await db.from("equipment").select("id").eq("id", id).maybeSingle();
  if (machineError) {
    console.error("equipment document: machine read failed", machineError);
    return NextResponse.json({ error: "Couldn't upload the document. Try again." }, { status: 500 });
  }
  if (!machine) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

  const path = equipmentDocumentPath(id, fileName, Date.now());
  const { error: upError } = await db.storage.from("equipment-documents").upload(path, bytes, { contentType: mime });
  if (upError) {
    console.error("equipment document: upload failed", upError);
    return NextResponse.json({ error: "The file could not be uploaded. Nothing was saved." }, { status: 502 });
  }

  const { data: doc, error: rowError } = await db
    .from("equipment_documents")
    .insert({ equipment_id: id, uploaded_by: guard.userId, storage_path: path, file_name: fileName, file_size: bytes.length, file_type: mime })
    .select("id, storage_path, file_name, file_size, file_type, created_at")
    .single();
  if (rowError || !doc) {
    console.error("equipment document: row insert failed", rowError);
    const { error: cleanError } = await db.storage.from("equipment-documents").remove([path]);
    if (cleanError) console.error("equipment document: file clean-up failed", path, cleanError);
    return NextResponse.json({ error: "The document could not be saved. Try again." }, { status: 500 });
  }
  return NextResponse.json({ document: doc });
}
