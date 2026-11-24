"use client";

import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FileText, Upload, Trash2, Download, File, Lock, LockOpen, ChevronDown, ChevronRight, Folder } from "lucide-react";
import { formatDate } from "@/lib/date";
import {
  DEFAULT_DOCUMENT_FOLDER,
  DOCUMENT_FOLDER_GROUPS,
  documentFolderGroup,
  documentFolderLabel,
  groupDocumentsByFolder,
  isMissingFolderColumn,
  type DocumentFolder,
  type DocumentFolderGroup,
} from "@/lib/document-folders";
import { FileDropZone } from "@/components/ui/file-drop-zone";

// The Upload button's accept list — also checked for drops and pastes, which
// the browser doesn't filter.
const DOCUMENT_ACCEPT = ".pdf,.doc,.docx,.dwg,.dxf,.png,.jpg,.jpeg,.xlsx,.xls";
const DOCUMENT_HINT = "PDF, Word, Excel, DWG/DXF, PNG or JPG";

const fileIcons: Record<string, string> = {
  "application/pdf": "PDF",
  "image/jpeg": "IMG",
  "image/png": "IMG",
  "application/dwg": "DWG",
  "application/dxf": "DXF",
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface Props {
  jobId: string;
  documents: any[];
  onUpdate: (docs: any[]) => void;
  currentUserId: string;
  isOffice: boolean;
  /** A technician viewing a job they are not assigned to: download only. */
  readOnly?: boolean;
}

export function JobDocuments({ jobId, documents, onUpdate, currentUserId, isOffice, readOnly = false }: Props) {
  const supabase = createClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  // Folders (job_documents.folder, 0114; on a database without it every
  // document is under "Other" and uploads/moves leave the column out).
  const [uploadFolder, setUploadFolder] = useState<DocumentFolder>(DEFAULT_DOCUMENT_FOLDER);
  const [collapsed, setCollapsed] = useState<Set<DocumentFolderGroup>>(new Set());
  const [moving, setMoving] = useState<string | null>(null);
  const foldersReady = documents.length === 0 || documents.some((d) => d && "folder" in d);
  const sections = groupDocumentsByFolder(documents);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    await uploadFiles(Array.from(files));
    if (inputRef.current) inputRef.current.value = "";
  }

  // The Upload button, a drop anywhere on the tab and a paste all come here
  // (components/ui/file-drop-zone.tsx). Dropped/pasted files go to the folder
  // chosen beside the button (default Site Documents) and can be moved after.
  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;
    setUploading(true);
    let saved = 0;

    for (const file of files) {
      const path = `${jobId}/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const { error: uploadError } = await supabase.storage.from("job-documents").upload(path, file);
      if (uploadError) { toast.error(`Failed to upload ${file.name}`); continue; }

      const row = {
        job_id: jobId,
        uploaded_by: currentUserId,
        storage_path: path,
        file_name: file.name,
        file_size: file.size,
        file_type: file.type,
      };
      let { error: dbError } = await supabase.from("job_documents").insert({ ...row, folder: uploadFolder });
      if (isMissingFolderColumn(dbError)) ({ error: dbError } = await supabase.from("job_documents").insert(row));
      if (dbError) toast.error(`Failed to save ${file.name}`);
      else saved += 1;
    }

    const { data } = await supabase.from("job_documents").select("*, profiles(full_name)").eq("job_id", jobId).order("created_at", { ascending: false });
    onUpdate(data ?? []);
    if (saved > 0) {
      const where = foldersReady ? ` to ${documentFolderLabel(uploadFolder)}` : "";
      toast.success(`${saved === 1 ? "Document" : `${saved} documents`} uploaded${where}`);
    }
    setUploading(false);
  }

  async function handleDelete(doc: any) {
    setDeleting(doc.id);

    // ROW FIRST — see components/job/job-photos.tsx for the full reasoning. The
    // old order removed the file before the row, so a refused row delete left a
    // document the app still listed but could no longer open, and neither result
    // was checked. 0047 scopes money documents in this bucket to office/admin,
    // so a refusal is reachable.
    const { error: rowError } = await supabase.from("job_documents").delete().eq("id", doc.id);
    if (rowError) {
      toast.error(`Could not delete the document: ${rowError.message}`);
      setDeleting(null);
      return;
    }

    const { data: removed, error: fileError } = await supabase.storage
      .from("job-documents")
      .remove([doc.storage_path]);

    onUpdate(documents.filter((d) => d.id !== doc.id));
    // An RLS-filtered bulk remove returns 200 with an empty array, so `data` is
    // the signal, not `error`.
    if (fileError || !removed?.length) {
      console.error("job-documents: row deleted but file remains", doc.storage_path, fileError);
      toast.warning("Document removed, but the file could not be cleaned up.");
    } else {
      toast.success("Document deleted");
    }
    setDeleting(null);
  }

  // Office only = hidden from technicians (row and file) — migration 0065.
  // Purchase orders, invoices, quotes and anything else with prices.
  async function handleToggleOfficeOnly(doc: any) {
    const next = !doc.office_only;
    const { error, count } = await supabase.from("job_documents").update({ office_only: next }, { count: "exact" }).eq("id", doc.id);
    if (error || count === 0) {
      toast.error(error?.message ?? "Couldn't update the document");
      return;
    }
    onUpdate(documents.map((d) => (d.id === doc.id ? { ...d, office_only: next } : d)));
    toast.success(next ? "Hidden from technicians" : "Visible to technicians");
  }

  // Move a document to another folder. Who may is the existing job_documents
  // RLS (0065/0074): office/admin any; the job's crew the ones not office-only.
  async function handleMove(doc: any, group: DocumentFolderGroup) {
    if (documentFolderGroup(doc) === group) return;
    const folder = group === "other" ? null : group;
    setMoving(doc.id);
    const { error, count } = await supabase.from("job_documents").update({ folder }, { count: "exact" }).eq("id", doc.id);
    setMoving(null);
    if (isMissingFolderColumn(error)) {
      toast.error("Folders aren't switched on yet.");
      return;
    }
    if (error || count === 0) {
      if (error) console.error("job-documents: move failed", error);
      toast.error("Couldn't move the document");
      return;
    }
    onUpdate(documents.map((d) => (d.id === doc.id ? { ...d, folder } : d)));
    toast.success(`Moved to ${documentFolderLabel(group)}`);
  }

  function toggleSection(group: DocumentFolderGroup) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }

  async function handleDownload(doc: any) {
    const { data } = await supabase.storage.from("job-documents").createSignedUrl(doc.storage_path, 60);
    if (data?.signedUrl) window.open(data.signedUrl, "_blank");
  }

  return (
    <FileDropZone
      onFiles={uploadFiles}
      accept={DOCUMENT_ACCEPT}
      hint={DOCUMENT_HINT}
      label={foldersReady ? `Drop files to upload to ${documentFolderLabel(uploadFolder)}` : "Drop files to upload"}
      disabled={readOnly}
      busy={uploading}
      className="min-h-full"
    >
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Documents</h2>
          <p className="text-sm text-slate-500">Plans, specs, permits, compliance certificates</p>
        </div>
        <div>
          <input ref={inputRef} type="file" multiple className="hidden" onChange={handleUpload}
            accept={DOCUMENT_ACCEPT} />
          {!readOnly && (
            <div className="flex items-center gap-2">
              {foldersReady && (
                <select
                  aria-label="Upload to folder"
                  value={uploadFolder}
                  onChange={(e) => setUploadFolder(e.target.value as DocumentFolder)}
                  className="h-9 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700"
                >
                  {DOCUMENT_FOLDER_GROUPS.filter((g): g is DocumentFolder => g !== "other").map((g) => (
                    <option key={g} value={g}>{documentFolderLabel(g)}</option>
                  ))}
                </select>
              )}
              <Button onClick={() => inputRef.current?.click()} disabled={uploading} className="gap-2">
                <Upload className="w-4 h-4" />
                {uploading ? "Uploading..." : "Upload Files"}
              </Button>
            </div>
          )}
        </div>
      </div>

      {documents.length === 0 ? (
        <Card>
          <CardContent
            className={`flex flex-col items-center justify-center py-16 transition-colors text-slate-400 ${readOnly ? "" : "cursor-pointer hover:bg-slate-50"}`}
            onClick={readOnly ? undefined : () => inputRef.current?.click()}
          >
            <FileText className="w-12 h-12 mb-3 opacity-40" />
            <p className="text-sm font-medium">No documents yet</p>
            {!readOnly && <p className="text-xs mt-1">Click, drag files here, or paste (Ctrl+V) to upload plans, specs, permits and more</p>}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {sections.map((section) => {
            const open = !collapsed.has(section.folder);
            return (
              <div key={section.folder} className="space-y-2">
                <button
                  type="button"
                  onClick={() => toggleSection(section.folder)}
                  className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-sm font-semibold text-slate-700 hover:bg-slate-50"
                  aria-expanded={open}
                >
                  {open ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
                  <Folder className="w-4 h-4 text-slate-400" />
                  {section.label}
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">{section.documents.length}</span>
                </button>
                {open && section.documents.map((doc) => (
                <Card key={doc.id} className="group">
                  <CardContent className="flex items-center gap-4 p-4">
                    <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-blue-100 text-blue-700 text-xs font-bold flex-shrink-0">
                      {fileIcons[doc.file_type] ?? <File className="w-4 h-4" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-900 truncate">
                        {doc.file_name}
                        {doc.office_only && (
                          <span className="ml-2 inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 align-middle">
                            <Lock className="w-3 h-3" /> Office only
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-slate-500">
                        {doc.file_size ? formatBytes(doc.file_size) : ""} · {doc.profiles?.full_name ?? "Unknown"} · {formatDate(doc.created_at)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                      {isOffice && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleToggleOfficeOnly(doc)}
                          className="h-8 w-8 p-0 text-slate-500 hover:text-amber-600"
                          title={doc.office_only ? "Show to technicians" : "Hide from technicians (office only)"}
                        >
                          {doc.office_only ? <LockOpen className="w-4 h-4" /> : <Lock className="w-4 h-4" />}
                        </Button>
                      )}
                      {foldersReady && !readOnly && (isOffice || !doc.office_only) && (
                        <select
                          aria-label={`Move ${doc.file_name} to folder`}
                          title="Move to folder"
                          value={documentFolderGroup(doc)}
                          disabled={moving === doc.id}
                          onChange={(e) => handleMove(doc, e.target.value as DocumentFolderGroup)}
                          className="h-8 rounded-md border border-slate-200 bg-white px-1 text-xs text-slate-600"
                        >
                          {DOCUMENT_FOLDER_GROUPS.map((g) => (
                            <option key={g} value={g}>{documentFolderLabel(g)}</option>
                          ))}
                        </select>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => handleDownload(doc)} className="h-8 w-8 p-0 text-slate-500 hover:text-blue-600">
                        <Download className="w-4 h-4" />
                      </Button>
                      {!readOnly && (
                      <Button variant="ghost" size="sm" onClick={() => handleDelete(doc)} disabled={deleting === doc.id} className="h-8 w-8 p-0 text-slate-500 hover:text-red-600">
                        <Trash2 className="w-4 h-4" />
                      </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
    </FileDropZone>
  );
}
