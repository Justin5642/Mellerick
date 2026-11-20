import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { reportError } from "@/lib/monitoring";
import { decodeUploadedFile, isUuidLike, safeFileName } from "@/lib/job-purchase-orders";
import { DEFAULT_DOCUMENT_FOLDER, isMissingFolderColumn, parseDocumentFolder } from "@/lib/document-folders";

// Upload a document to a job from the phone (office/admin, Nov 2026) — the
// web Documents tab's upload (components/job/job-documents.tsx), which writes
// from the browser's own session. The phone sends the file as base64 (≤ 3 MB,
// sniffed: JPEG/PNG/WebP/PDF); it is stored at the web's path,
// `{job}/{ts}_{name}`, and a job_documents row is added — both as the CALLER,
// so storage and table RLS decide exactly as on the web. `officeOnly` marks it
// hidden from technicians from the start (0065). `folder` files it (0114 —
// drafted: site_documents by default, "other"/null for none; a database
// without the column saves it unfiled). A failed row insert removes the file
// again, so no orphan is left.

type Ctx = { params: Promise<{ id: string }> };

export const maxDuration = 30;

export async function POST(request: NextRequest, { params }: Ctx) {
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  const { id: jobId } = await params;
  if (!isUuidLike(jobId)) return NextResponse.json({ error: "That job isn't there any more." }, { status: 404 });

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const file = decodeUploadedFile(body?.file);
  if (!file.ok) return NextResponse.json({ error: file.error }, { status: 400 });
  const fileName = safeFileName(body?.fileName, file.ext);
  const officeOnly = body?.officeOnly === true;
  const folder = body && "folder" in body ? parseDocumentFolder(body.folder) : DEFAULT_DOCUMENT_FOLDER;
  if (folder === undefined) return NextResponse.json({ error: "Pick one of the folders." }, { status: 400 });

  try {
    const supabase = await callerClient(request);
    const { data: job, error: jobError } = await supabase.from("jobs").select("id").eq("id", jobId).maybeSingle();
    if (jobError) throw jobError;
    if (!job) return NextResponse.json({ error: "That job isn't there any more." }, { status: 404 });

    const path = `${jobId}/${Date.now()}_${fileName}`;
    const { error: upError } = await supabase.storage.from("job-documents").upload(path, file.bytes, { contentType: file.contentType });
    if (upError) {
      console.error("job document upload failed:", upError);
      return NextResponse.json({ error: "Couldn't upload the document. Try again." }, { status: 502 });
    }
    const docRow = {
      job_id: jobId,
      uploaded_by: guard.userId,
      storage_path: path,
      file_name: fileName,
      file_size: file.bytes.length,
      file_type: file.contentType,
      office_only: officeOnly,
    };
    let { data: row, error: rowError } = await supabase
      .from("job_documents")
      .insert({ ...docRow, folder })
      .select("id")
      .single();
    if (isMissingFolderColumn(rowError)) {
      ({ data: row, error: rowError } = await supabase.from("job_documents").insert(docRow).select("id").single());
    }
    if (rowError || !row) {
      console.error("job document row insert failed:", rowError);
      await supabase.storage.from("job-documents").remove([path]).catch(() => {});
      return NextResponse.json({ error: "Couldn't save the document. Try again." }, { status: 500 });
    }
    return NextResponse.json({ id: row.id, fileName });
  } catch (err) {
    console.error("job documents POST error:", err);
    reportError(err, { route: "api/jobs/documents" });
    return NextResponse.json({ error: "Couldn't upload the document. Try again." }, { status: 500 });
  }
}
