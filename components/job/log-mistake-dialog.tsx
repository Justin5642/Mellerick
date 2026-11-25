"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { KeyboardSafeDialogContent } from "@/components/ui/keyboard-safe-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Camera, Loader2, X } from "lucide-react";
import { dateKeyInBusinessTZ, formatDate, formatTime } from "@/lib/date";
import { resizeImageForUpload } from "@/lib/image-resize";
import { fileToBase64 } from "@/components/invoice/invoice-attachments-field";
import {
  buildRaiseBody,
  emptyRaiseForm,
  MAX_MISTAKE_PHOTOS,
  MISTAKE_CAUSES,
  MISTAKE_DESCRIPTION_MAX,
  type RaiseMistakeForm,
} from "@/lib/mistake-raise";
import type { CrewMistakeState } from "@/lib/mistakes-crew";

// "Log mistake" on a job — every role, web (Justin, 25 Nov 2026: crew raise,
// office costs). Category, stage, cause, what went wrong, photos, and the
// person's own time on the job to mark as rework. NO MONEY: the crew never
// enter or see a dollar figure; the office costs it afterwards on the job's
// Purchase Orders tab. Goes through POST /api/jobs/[id]/mistakes (the
// database function raise_job_mistake(), 0119 (a draft, not applied yet)), then each photo through
// …/mistakes/[id]/photos.

interface Props {
  jobId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the fresh state after a save. */
  onSaved?: (state: CrewMistakeState) => void;
}

const selectClass = "h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700";

export function LogMistakeDialog({ jobId, open, onOpenChange, onSaved }: Props) {
  const [state, setState] = useState<CrewMistakeState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<RaiseMistakeForm>(emptyRaiseForm);
  const [photos, setPhotos] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [mistakeId, setMistakeId] = useState<string>("");

  useEffect(() => {
    if (!open) return;
    let live = true;
    setForm(emptyRaiseForm());
    setPhotos([]);
    setError(null);
    setLoadError(null);
    setMistakeId(crypto.randomUUID());
    void fetch(`/api/jobs/${jobId}/mistakes`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!live) return;
        if (!res.ok) {
          setLoadError(typeof data.error === "string" ? data.error : "Couldn't load the form. Try again.");
          return;
        }
        const s = data as CrewMistakeState;
        setState(s);
        const open = s.stages.filter((x) => !x.completed);
        if (open.length === 1) setForm((f) => ({ ...f, costCenterId: open[0].id }));
      })
      .catch(() => live && setLoadError("No connection. Try again."));
    return () => {
      live = false;
    };
  }, [open, jobId]);

  async function save() {
    const built = buildRaiseBody(mistakeId, form, dateKeyInBusinessTZ(new Date()));
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/mistakes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(built.body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Couldn't log the mistake. Try again.");
        return;
      }
      let failed = 0;
      for (const file of photos) {
        try {
          const small = await resizeImageForUpload(file);
          const up = await fetch(`/api/jobs/${jobId}/mistakes/${mistakeId}/photos`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image: await fileToBase64(small) }),
          });
          if (!up.ok) failed += 1;
        } catch {
          failed += 1;
        }
      }
      toast.success(failed ? `Mistake logged — ${failed} photo${failed === 1 ? "" : "s"} didn't upload.` : "Mistake logged — the office will cost it.");
      onSaved?.(data as CrewMistakeState);
      onOpenChange(false);
    } catch {
      setError("No connection. Try again.");
    } finally {
      setSaving(false);
    }
  }

  const toggleEntry = (id: string) =>
    setForm((f) => ({ ...f, timeEntryIds: f.timeEntryIds.includes(id) ? f.timeEntryIds.filter((x) => x !== id) : [...f.timeEntryIds, id] }));
  const takenEntries = new Set((state?.mistakes ?? []).flatMap((m) => m.reworkEntryIds));

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <KeyboardSafeDialogContent
        className="sm:max-w-lg"
        header={
          <DialogHeader className="p-4 pb-2">
            <DialogTitle>Log a mistake</DialogTitle>
            <DialogDescription>Say what happened. The office works out what it cost — you don&apos;t need to.</DialogDescription>
          </DialogHeader>
        }
        footer={
          <div className="flex justify-end gap-2 p-4 pt-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void save()} disabled={saving || !state?.ready} className="gap-1.5">
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              Log mistake
            </Button>
          </div>
        }
        bodyClassName="px-4 space-y-3"
      >
        {loadError ? (
          <p className="text-sm text-red-600">{loadError}</p>
        ) : !state ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : !state.ready ? (
          <p className="text-sm text-slate-600">Logging mistakes isn&apos;t switched on yet — the database update still has to be applied.</p>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="lm-category">What kind of mistake</Label>
              <select id="lm-category" className={selectClass} value={form.categoryId} onChange={(e) => setForm((f) => ({ ...f, categoryId: e.target.value }))}>
                <option value="">Pick one…</option>
                {state.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="lm-stage">Stage / cost centre</Label>
                <select id="lm-stage" className={selectClass} value={form.costCenterId} onChange={(e) => setForm((f) => ({ ...f, costCenterId: e.target.value }))}>
                  <option value="">Not sure</option>
                  {state.stages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.completed ? " (complete)" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lm-cause">Cause (if you know)</Label>
                <select id="lm-cause" className={selectClass} value={form.causeCode} onChange={(e) => setForm((f) => ({ ...f, causeCode: e.target.value }))}>
                  <option value="">Not sure</option>
                  {MISTAKE_CAUSES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lm-date">When</Label>
              <Input id="lm-date" type="date" value={form.occurredOn || dateKeyInBusinessTZ(new Date())} onChange={(e) => setForm((f) => ({ ...f, occurredOn: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lm-description">What went wrong</Label>
              <Textarea
                id="lm-description"
                rows={3}
                maxLength={MISTAKE_DESCRIPTION_MAX}
                placeholder="e.g. Pit set 50 mm too high — dug out and reset"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Photos</Label>
              <div className="flex flex-wrap gap-2">
                {photos.map((p, i) => (
                  <span key={`${p.name}-${i}`} className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-1 text-xs text-slate-700">
                    {p.name}
                    <button type="button" aria-label="Remove photo" onClick={() => setPhotos((list) => list.filter((_, j) => j !== i))}>
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
                {photos.length < MAX_MISTAKE_PHOTOS && (
                  <label className="inline-flex cursor-pointer items-center gap-1 rounded border border-dashed border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50">
                    <Camera className="w-3.5 h-3.5" /> Add photos
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/heic,image/*"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        const files = Array.from(e.target.files ?? []);
                        setPhotos((list) => [...list, ...files].slice(0, MAX_MISTAKE_PHOTOS));
                        e.target.value = "";
                      }}
                    />
                  </label>
                )}
              </div>
            </div>
            {state.timeEntries.length > 0 && (
              <div className="space-y-1.5">
                <Label>Time spent fixing it (your time on this job)</Label>
                <div className="max-h-40 overflow-y-auto rounded border border-slate-200 divide-y divide-slate-100">
                  {state.timeEntries.map((t) => {
                    const taken = takenEntries.has(t.id);
                    return (
                      <label key={t.id} className={`flex items-center gap-2 px-2 py-1.5 text-sm ${taken ? "text-slate-400" : "text-slate-700"}`}>
                        <input type="checkbox" disabled={taken} checked={form.timeEntryIds.includes(t.id)} onChange={() => toggleEntry(t.id)} />
                        {formatDate(t.clockIn, { weekday: "short", day: "numeric", month: "short" })} · {formatTime(t.clockIn)}
                        {t.clockOut ? `–${formatTime(t.clockOut)}` : " (on now)"}
                        {t.hours != null ? ` · ${t.hours} h` : ""}
                        {taken ? " · already marked" : ""}
                      </label>
                    );
                  })}
                </div>
                <p className="text-xs text-slate-500">Tick only the time that went on rework.</p>
              </div>
            )}
            {error && <p className="text-sm text-red-600">{error}</p>}
          </>
        )}
      </KeyboardSafeDialogContent>
    </Dialog>
  );
}
