import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { reportError } from "@/lib/monitoring";
import { isUuidLike } from "@/lib/job-purchase-orders";
import { isFolderNotSwitchedOn, parseDocumentFolder } from "@/lib/document-folders";

// One job document, from the phone (office/admin). PATCH sets "Office only"
// (0065: hidden from technicians, row and file — anything with prices)
// and/or its folder (`folder`: one of lib/document-folders.ts's keys, or
// "other"/null — job_documents.folder, keys from migration 0116 (drafted); on a database
// without the column, or before 0116 replaces 0114's check, a folder change
// answers FOLDERS_OFF);
// DELETE removes it, ROW FIRST then the file, the web's order (a refused row
// delete must not leave a listed document whose file is gone). As the caller.

type Ctx = { params: Promise<{ id: string; docId: string }> };

const NOT_FOUND = "That document isn't on this job any more. Refresh to see it.";
const FOLDERS_OFF = "Document folders aren't switched on yet.";

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  const { id: jobId, docId } = await params;
  if (!isUuidLike(jobId) || !isUuidLike(docId)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { officeOnly?: unknown; folder?: unknown } | null;
  const patch: { office_only?: boolean; folder?: string | null } = {};
  if (body && "officeOnly" in body) {
    if (typeof body.officeOnly !== "boolean") return NextResponse.json({ error: "Say whether it's office only." }, { status: 400 });
    patch.office_only = body.officeOnly;
  }
  if (body && "folder" in body) {
    const folder = parseDocumentFolder(body.folder);
    if (folder === undefined) return NextResponse.json({ error: "Pick one of the folders." }, { status: 400 });
    patch.folder = folder;
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: "Say whether it's office only." }, { status: 400 });
  try {
    const supabase = await callerClient(request);
    const { error, count } = await supabase
      .from("job_documents")
      .update(patch, { count: "exact" })
      .eq("id", docId)
      .eq("job_id", jobId);
    if (patch.folder !== undefined && isFolderNotSwitchedOn(error)) return NextResponse.json({ error: FOLDERS_OFF }, { status: 409 });
    if (error) throw error;
    if (count === 0) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
    return NextResponse.json({
      ...(patch.office_only !== undefined ? { officeOnly: patch.office_only } : {}),
      ...(patch.folder !== undefined ? { folder: patch.folder } : {}),
    });
  } catch (err) {
    console.error("job document PATCH error:", err);
    reportError(err, { route: "api/jobs/documents/[docId]" });
    return NextResponse.json({ error: "Couldn't update the document. Try again." }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  const { id: jobId, docId } = await params;
  if (!isUuidLike(jobId) || !isUuidLike(docId)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  try {
    const supabase = await callerClient(request);
    const { data: doc, error: readError } = await supabase
      .from("job_documents")
      .select("id, storage_path")
      .eq("id", docId)
      .eq("job_id", jobId)
      .maybeSingle();
    if (readError) throw readError;
    // Already gone (a retry after a dropped answer): nothing left to do.
    if (!doc) return NextResponse.json({ deleted: true });
    const { error, count } = await supabase.from("job_documents").delete({ count: "exact" }).eq("id", docId);
    if (error) throw error;
    if (count === 0) return NextResponse.json({ error: "Couldn't delete the document." }, { status: 409 });
    const { data: removed, error: fileError } = await supabase.storage.from("job-documents").remove([doc.storage_path]);
    // An RLS-filtered remove answers 200 with an empty list, so `removed` is the signal.
    if (fileError || !removed?.length) {
      console.error("job-documents: row deleted but file remains", doc.storage_path, fileError);
      return NextResponse.json({ deleted: true, warning: "Document removed, but the file could not be cleaned up." });
    }
    return NextResponse.json({ deleted: true });
  } catch (err) {
    console.error("job document DELETE error:", err);
    reportError(err, { route: "api/jobs/documents/[docId]" });
    return NextResponse.json({ error: "Couldn't delete the document. Try again." }, { status: 500 });
  }
}
