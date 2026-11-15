"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, Upload, AlertTriangle, CheckCircle2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface Pending {
  key: string;
  name: string;
  state: "uploading" | "reading" | "done" | "failed";
  message?: string;
}

/**
 * Drop the day's supplier PDFs. Each is uploaded to the private bucket, then
 * read on the server (/api/supplier-invoices/read). Up to three read at once.
 * Nothing is reported as read until the server says so. When a batch
 * finishes, the page reloads its lists so the new invoices show up matched.
 */
export function SupplierInvoiceUpload() {
  const supabase = createClient();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [dragDepth, setDragDepth] = useState(0);

  const setState = (key: string, patch: Partial<Pending>) =>
    setPending((p) => p.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  async function readOne(file: File, key: string) {
    const day = new Date().toISOString().slice(0, 10);
    const path = `${day}/${crypto.randomUUID()}.pdf`;
    const up = await supabase.storage.from("supplier-invoices").upload(path, file, { contentType: "application/pdf" });
    if (up.error) {
      setState(key, { state: "failed", message: "Upload failed — check your connection and drop it again." });
      return;
    }
    setState(key, { state: "reading" });
    try {
      const res = await fetch("/api/supplier-invoices/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storagePath: path, fileName: file.name }),
      });
      const data = await res.json().catch(() => ({}));
      const got = (data.invoices ?? []) as { doc_kind: string | null }[];
      if (!res.ok) {
        setState(key, { state: "failed", message: data.error ?? `Server returned ${res.status}` });
        return;
      }
      const n = got.filter((g) => g.doc_kind === "invoice" || g.doc_kind === "credit_note").length;
      setState(key, { state: "done", message: data.alreadyRead ? "Already read earlier" : `${n} invoice${n === 1 ? "" : "s"} found` });
    } catch {
      setState(key, { state: "failed", message: "Couldn't reach the server. Drop it again." });
    }
  }

  async function addFiles(list: FileList | File[]) {
    const files = [...list];
    const pdfs = files.filter((f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"));
    if (pdfs.length < files.length) toast.error(`${files.length - pdfs.length} file(s) skipped — only PDFs can be read`);
    if (!pdfs.length) return;
    const items = pdfs.map((f) => ({ file: f, key: `${f.name}-${f.size}-${Math.random()}` }));
    setPending((p) => [...items.map(({ file, key }) => ({ key, name: file.name, state: "uploading" as const })), ...p]);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const { file, key } = items[next++];
        await readOne(file, key);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    router.refresh();
  }

  const busy = pending.some((p) => p.state === "uploading" || p.state === "reading");

  return (
    <div className="space-y-4">
      <div
        role="button"
        tabIndex={0}
        aria-label="Add supplier invoice PDFs: click to browse or drag and drop"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); inputRef.current?.click(); } }}
        onDragEnter={(e) => { e.preventDefault(); setDragDepth((d) => d + 1); }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
        onDragLeave={(e) => { e.preventDefault(); setDragDepth((d) => Math.max(0, d - 1)); }}
        onDrop={(e) => { e.preventDefault(); setDragDepth(0); void addFiles(e.dataTransfer.files); }}
        className={cn(
          "rounded-lg border-2 border-dashed px-6 py-10 text-center cursor-pointer transition-colors",
          dragDepth > 0 ? "border-blue-500 bg-blue-50" : "border-slate-300 hover:border-slate-400 bg-white"
        )}
      >
        <Upload className="w-8 h-8 mx-auto text-slate-400" />
        <p className="mt-2 text-sm font-medium text-slate-700">Drop today&apos;s supplier invoice PDFs here</p>
        <p className="text-xs text-slate-500">Several at once is fine. Each PDF is read once — dropping it again does nothing.</p>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="hidden"
          onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ""; }}
        />
      </div>

      {pending.length > 0 && (
        <Card>
          <CardContent className="py-3 space-y-1.5">
            {pending.map((p) => (
              <div key={p.key} className="flex items-center gap-2 text-sm">
                {p.state === "failed" ? <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
                  : p.state === "done" ? <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" />
                  : <Loader2 className="w-4 h-4 animate-spin text-slate-400 shrink-0" />}
                <span className="truncate text-slate-700">{p.name}</span>
                <span className={cn("text-xs ml-auto shrink-0", p.state === "failed" ? "text-red-600" : "text-slate-500")}>
                  {p.state === "uploading" ? "Uploading…" : p.state === "reading" ? "Reading…" : p.message}
                </span>
              </div>
            ))}
            {!busy && (
              <button type="button" className="text-xs text-slate-500 hover:underline" onClick={() => setPending([])}>Clear</button>
            )}
          </CardContent>
        </Card>
      )}

    </div>
  );
}
