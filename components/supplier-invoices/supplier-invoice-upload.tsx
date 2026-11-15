"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { FileText, Loader2, Upload, AlertTriangle, CheckCircle2, Copy } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ourPoNumbers } from "@/lib/supplier-invoice-refs";

export interface SupplierInvoiceRow {
  id: string;
  storage_path: string;
  file_name: string;
  index_in_file: number;
  created_at: string;
  status: "reading" | "read" | "failed" | "costed" | "dismissed";
  read_error: string | null;
  doc_kind: "invoice" | "credit_note" | "statement" | "other" | null;
  supplier_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  amount_ex_gst: number | null;
  total: number | null;
  po_refs: string[];
  job_refs: string[];
  site_text: string | null;
  duplicate_of: string | null;
}

interface Pending {
  key: string;
  name: string;
  state: "uploading" | "reading" | "done" | "failed";
  message?: string;
}

const KIND: Record<string, string> = { invoice: "Invoice", credit_note: "Credit note", statement: "Statement", other: "Not an invoice" };

/**
 * Drop the day's supplier PDFs. Each is uploaded to the private bucket, then
 * read on the server (/api/supplier-invoices/read). Up to three read at once.
 * Nothing is reported as read until the server says so.
 */
export function SupplierInvoiceUpload({ initial, loadFailed }: { initial: SupplierInvoiceRow[]; loadFailed: boolean }) {
  const supabase = createClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<SupplierInvoiceRow[]>(initial);
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
      const got = (data.invoices ?? []) as SupplierInvoiceRow[];
      if (got.length) setRows((r) => [...got, ...r.filter((x) => !got.some((g) => g.id === x.id))]);
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
  }

  async function openPdf(path: string) {
    const { data, error } = await supabase.storage.from("supplier-invoices").createSignedUrl(path, 60);
    if (error || !data) { toast.error("Couldn't open the PDF"); return; }
    window.open(data.signedUrl, "_blank", "noopener");
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

      {loadFailed && <p className="text-sm text-red-600">The list of invoices could not be loaded. Reload the page.</p>}

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {rows.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-8">No supplier invoices in the last 30 days.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="text-left font-medium px-4 py-2">Supplier</th>
                  <th className="text-left font-medium px-4 py-2">Invoice</th>
                  <th className="text-left font-medium px-4 py-2">Date</th>
                  <th className="text-right font-medium px-4 py-2">Ex GST</th>
                  <th className="text-left font-medium px-4 py-2">Order ref · job · site</th>
                  <th className="text-left font-medium px-4 py-2">PDF</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => {
                  const pos = ourPoNumbers(r.po_refs ?? []);
                  return (
                    <tr key={r.id} className={cn(r.status === "failed" && "bg-red-50/50", r.duplicate_of && "opacity-60")}>
                      <td className="px-4 py-2.5 text-slate-800">
                        {r.supplier_name ?? <span className="text-slate-400">—</span>}
                        {r.doc_kind && r.doc_kind !== "invoice" && (
                          <span className="ml-2 text-[11px] rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">{KIND[r.doc_kind]}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs">
                        {r.status === "failed" ? <span className="text-red-600 font-sans">{r.read_error ?? "Not read"}</span> : r.invoice_number ?? "—"}
                        {r.duplicate_of && <span className="ml-2 inline-flex items-center gap-1 font-sans text-[11px] text-amber-700"><Copy className="w-3 h-3" />Already received</span>}
                      </td>
                      <td className="px-4 py-2.5 text-slate-600 whitespace-nowrap">{r.invoice_date ? new Date(`${r.invoice_date}T00:00:00`).toLocaleDateString("en-AU") : "—"}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{r.amount_ex_gst != null ? `$${Number(r.amount_ex_gst).toFixed(2)}` : "—"}</td>
                      <td className="px-4 py-2.5 text-xs text-slate-600">
                        {pos.length > 0 && <span className="mr-2 rounded bg-green-100 px-1.5 py-0.5 font-mono text-green-800">{pos.join(", ")}</span>}
                        {[...(r.po_refs ?? []).filter((p) => !pos.length || !ourPoNumbers([p]).length), ...(r.job_refs ?? [])].join(" · ")}
                        {r.site_text && <span className="block text-slate-400 truncate max-w-xs">{r.site_text}</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        <button type="button" onClick={() => openPdf(r.storage_path)} className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline">
                          <FileText className="w-3.5 h-3.5" />{r.file_name.length > 24 ? `${r.file_name.slice(0, 22)}…` : r.file_name}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
      <p className="text-xs text-slate-500">
        Next step (coming): each invoice is matched to its job — on the PO it quotes, else by job number or site — and costed with one tap.
      </p>
    </div>
  );
}
