"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Eye, Loader2 } from "lucide-react";
import { formatDate } from "@/lib/date";
import { MAX_REPORT_NOTES_CHARS, MAX_REPORT_PHOTOS, type JobReportRequest } from "@/lib/job-report";
import type { JobReportDraft } from "@/lib/job-report-data";

// The "Include job report and photos" panel of the Send Invoice dialog.
// Loads the draft (GET /api/invoices/[id]/job-report), lets the office edit
// the work-done notes, untick photos and the sign-off, and preview the PDF.
// Reports the current selection to the dialog through onChange — null while
// the draft is loading or failed, so the dialog cannot send a half-built one.

interface Props {
  invoiceId: string;
  onChange: (selection: JobReportRequest | null) => void;
}

export function JobReportOptions({ invoiceId, onChange }: Props) {
  const [draft, setDraft] = useState<JobReportDraft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [notes, setNotes] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [includeSignature, setIncludeSignature] = useState(true);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/invoices/${invoiceId}/job-report`, { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? "Could not load the job report.");
        if (cancelled) return;
        const d = data as JobReportDraft;
        setDraft(d);
        setNotes(d.defaultNotes);
        setSelected(new Set(d.photos.map((p) => p.id)));
        setIncludeSignature(!!d.signature);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Could not load the job report.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [invoiceId, attempt]);

  useEffect(() => {
    if (!draft) {
      onChange(null);
      return;
    }
    onChange({
      notes,
      // In the draft's (report) order, not the order they were ticked.
      photoIds: draft.photos.filter((p) => selected.has(p.id)).map((p) => p.id),
      includeSignature: includeSignature && !!draft.signature,
    });
  }, [draft, notes, selected, includeSignature, onChange]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function preview() {
    if (!draft) return;
    // Opened before the await, so the popup blocker treats it as the click's.
    const win = window.open("", "_blank");
    setPreviewing(true);
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/job-report/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notes,
          photoIds: draft.photos.filter((p) => selected.has(p.id)).map((p) => p.id),
          includeSignature: includeSignature && !!draft.signature,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "The job report could not be made.");
      }
      const notice = res.headers.get("X-Report-Notice");
      if (notice) toast.warning(decodeURIComponent(notice));
      const url = URL.createObjectURL(await res.blob());
      if (win) win.location.href = url;
      else window.open(url, "_blank");
      // Long enough for the new tab to load it.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      win?.close();
      toast.error(err instanceof Error ? err.message : "The job report could not be made.");
    }
    setPreviewing(false);
  }

  if (loadError) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 space-y-2">
        <p>{loadError}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => { setDraft(null); setAttempt((n) => n + 1); }}>
          Try again
        </Button>
      </div>
    );
  }

  if (!draft) {
    return (
      <p className="flex items-center gap-2 text-sm text-slate-500">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading the job report…
      </p>
    );
  }

  const selectedCount = draft.photos.filter((p) => selected.has(p.id)).length;

  return (
    <div className="space-y-4 rounded-lg border bg-slate-50/60 p-3">
      <div className="space-y-1">
        <p className="text-xs font-medium uppercase text-slate-500">Dates attended</p>
        {draft.visits.length === 0 ? (
          <p className="text-sm text-slate-500">No site visits recorded on this job.</p>
        ) : (
          <ul className="text-sm space-y-0.5">
            {draft.visits.map((v) => (
              <li key={v.date}>
                <span className="font-medium">{v.label}</span>
                {v.names.length > 0 && <span className="text-slate-600"> — {v.names.join(", ")}</span>}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-slate-400">Days and names only — the report never shows hours or prices.</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="job-report-notes">Work carried out</Label>
        <Textarea
          id="job-report-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={MAX_REPORT_NOTES_CHARS}
          rows={6}
          className="max-h-72 overflow-y-auto"
          placeholder="What was done on the job. Sent exactly as written here."
        />
        <p className="text-xs text-slate-400">
          Filled in from the stage notes, voice report and completion notes. Edit before sending — the customer sees exactly this.
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-sm font-medium">
            Photos <span className="text-slate-500 font-normal">({selectedCount} of {draft.photos.length} ticked)</span>
          </p>
          {draft.photos.length > 0 && (
            <div className="flex gap-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(new Set(draft.photos.map((p) => p.id)))}>
                Select all
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                None
              </Button>
            </div>
          )}
        </div>
        {draft.photos.length === 0 ? (
          <p className="text-sm text-slate-500">No photos on this job.</p>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
            {draft.photos.map((p) => {
              const on = selected.has(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => toggle(p.id)}
                  aria-pressed={on}
                  aria-label={`${on ? "Remove" : "Include"} photo${p.caption ? `: ${p.caption}` : ""}`}
                  className={`relative aspect-square overflow-hidden rounded-md border-2 bg-slate-100 text-left ${on ? "border-blue-600" : "border-transparent opacity-50"}`}
                >
                  {p.thumbUrl && <img src={p.thumbUrl} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />}
                  <input
                    type="checkbox"
                    checked={on}
                    readOnly
                    tabIndex={-1}
                    className="pointer-events-none absolute top-1 left-1 h-4 w-4"
                  />
                  <span className="absolute bottom-0 inset-x-0 bg-black/50 px-1 py-0.5 text-[10px] leading-tight text-white truncate">
                    {p.caption?.trim() || formatDate(p.createdAt, { day: "numeric", month: "short" })}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {selectedCount > MAX_REPORT_PHOTOS && (
          <p className="text-xs text-amber-700">Only the first {MAX_REPORT_PHOTOS} ticked photos fit in one report.</p>
        )}
        {draft.unsupportedPhotos > 0 && (
          <p className="text-xs text-slate-500">
            {draft.unsupportedPhotos} photo{draft.unsupportedPhotos === 1 ? " is" : "s are"} in a format the report can&apos;t show (e.g. HEIC) and{" "}
            {draft.unsupportedPhotos === 1 ? "is" : "are"} left out.
          </p>
        )}
      </div>

      {draft.signature ? (
        <label className="flex items-center gap-3 text-sm">
          <input type="checkbox" className="h-4 w-4" checked={includeSignature} onChange={(e) => setIncludeSignature(e.target.checked)} />
          {draft.signature.url && <img src={draft.signature.url} alt="" className="h-10 w-24 object-contain rounded border bg-white" />}
          <span>
            Include customer sign-off
            <span className="block text-xs text-slate-500">
              {draft.signature.signerName?.trim() || "Customer"} · {formatDate(draft.signature.createdAt, { day: "numeric", month: "short", year: "numeric" })}
            </span>
          </span>
        </label>
      ) : (
        <p className="text-xs text-slate-500">No customer sign-off on this job.</p>
      )}

      <Button type="button" variant="outline" size="sm" className="gap-2" onClick={preview} disabled={previewing}>
        {previewing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
        {previewing ? "Making preview…" : "Preview report"}
      </Button>
    </div>
  );
}
