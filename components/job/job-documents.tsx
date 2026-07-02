"use client";

import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FileText, Upload, Trash2, Download, File } from "lucide-react";

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
}

export function JobDocuments({ jobId, documents, onUpdate, currentUserId }: Props) {
  const supabase = createClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);

    for (const file of Array.from(files)) {
      const path = `${jobId}/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const { error: uploadError } = await supabase.storage.from("job-documents").upload(path, file);
      if (uploadError) { toast.error(`Failed to upload ${file.name}`); continue; }

      const { error: dbError } = await supabase.from("job_documents").insert({
        job_id: jobId,
        uploaded_by: currentUserId,
        storage_path: path,
        file_name: file.name,
        file_size: file.size,
        file_type: file.type,
      });
      if (dbError) toast.error(`Failed to save ${file.name}`);
    }

    const { data } = await supabase.from("job_documents").select("*, profiles(full_name)").eq("job_id", jobId).order("created_at", { ascending: false });
    onUpdate(data ?? []);
    toast.success("Documents uploaded");
    setUploading(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function handleDelete(doc: any) {
    setDeleting(doc.id);
    await supabase.storage.from("job-documents").remove([doc.storage_path]);
    await supabase.from("job_documents").delete().eq("id", doc.id);
    onUpdate(documents.filter((d) => d.id !== doc.id));
    toast.success("Document deleted");
    setDeleting(null);
  }

  async function handleDownload(doc: any) {
    const { data } = await supabase.storage.from("job-documents").createSignedUrl(doc.storage_path, 60);
    if (data?.signedUrl) window.open(data.signedUrl, "_blank");
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Documents</h2>
          <p className="text-sm text-slate-500">Plans, specs, permits, compliance certificates</p>
        </div>
        <div>
          <input ref={inputRef} type="file" multiple className="hidden" onChange={handleUpload}
            accept=".pdf,.doc,.docx,.dwg,.dxf,.png,.jpg,.jpeg,.xlsx,.xls" />
          <Button onClick={() => inputRef.current?.click()} disabled={uploading} className="gap-2">
            <Upload className="w-4 h-4" />
            {uploading ? "Uploading..." : "Upload Files"}
          </Button>
        </div>
      </div>

      {documents.length === 0 ? (
        <Card>
          <CardContent
            className="flex flex-col items-center justify-center py-16 text-slate-400 cursor-pointer hover:bg-slate-50 transition-colors"
            onClick={() => inputRef.current?.click()}
          >
            <FileText className="w-12 h-12 mb-3 opacity-40" />
            <p className="text-sm font-medium">No documents yet</p>
            <p className="text-xs mt-1">Click to upload plans, specs, permits and more</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {documents.map((doc) => (
            <Card key={doc.id} className="group">
              <CardContent className="flex items-center gap-4 p-4">
                <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-blue-100 text-blue-700 text-xs font-bold flex-shrink-0">
                  {fileIcons[doc.file_type] ?? <File className="w-4 h-4" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-900 truncate">{doc.file_name}</p>
                  <p className="text-xs text-slate-500">
                    {doc.file_size ? formatBytes(doc.file_size) : ""} · {doc.profiles?.full_name ?? "Unknown"} · {new Date(doc.created_at).toLocaleDateString("en-AU")}
                  </p>
                </div>
                <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button variant="ghost" size="sm" onClick={() => handleDownload(doc)} className="h-8 w-8 p-0 text-slate-500 hover:text-blue-600">
                    <Download className="w-4 h-4" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => handleDelete(doc)} disabled={deleting === doc.id} className="h-8 w-8 p-0 text-slate-500 hover:text-red-600">
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
