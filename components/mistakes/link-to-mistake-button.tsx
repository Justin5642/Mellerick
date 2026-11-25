"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertTriangle, Loader2 } from "lucide-react";
import { formatDate } from "@/lib/date";
import { DEFAULT_KIND, SOURCE_LABELS, type LinkedSource } from "@/lib/mistake-costs";
import { MISTAKE_DESCRIPTION_MAX } from "@/lib/mistake-raise";

// The "Mistake" tick beside a time entry, an expense or a supplier PO (office/
// admin, web — Justin, 25 Nov 2026). Opens a small dialog: this record is (or
// isn't yet) part of a mistake on the job; link it to one, or to a new one, or
// unlink it. A link adds no cost — the record is already in the job's cost
// (0119 (a draft, not applied yet), lib/mistake-costs.ts). Rework time can be marked in part (hours).

interface Props {
  jobId: string;
  source: LinkedSource;
  sourceId: string;
  /** The record's hours (time entries), to cap a partial rework. */
  entryHours?: number | null;
  className?: string;
}

interface JobMistakeOption {
  id: string;
  description: string;
  occurred_on: string;
  status: string;
}

const selectClass = "h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700";

export function LinkToMistakeButton({ jobId, source, sourceId, entryHours, className }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notReady, setNotReady] = useState(false);
  const [linked, setLinked] = useState<{ lineId: string; mistake: JobMistakeOption | null } | null>(null);
  const [options, setOptions] = useState<JobMistakeOption[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [pick, setPick] = useState<string>("");
  const [newCategory, setNewCategory] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [hours, setHours] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    const supabase = createClient();
    void (async () => {
      const [line, list, cats] = await Promise.all([
        supabase.from("mistake_cost_lines").select("id, mistake_id").eq("source", source).eq("source_id", sourceId).maybeSingle(),
        supabase.from("job_mistakes").select("id, description, occurred_on, status").eq("job_id", jobId).order("occurred_on", { ascending: false }),
        supabase.from("mistake_categories").select("id, name").eq("is_active", true).order("sort_order"),
      ]);
      if (!live) return;
      if (line.error && ["42P01", "PGRST205"].includes(line.error.code ?? "")) {
        setNotReady(true);
        setLoading(false);
        return;
      }
      const opts = (list.data ?? []) as JobMistakeOption[];
      setOptions(opts);
      setCategories((cats.data ?? []) as { id: string; name: string }[]);
      const l = line.data as { id: string; mistake_id: string } | null;
      setLinked(l ? { lineId: l.id, mistake: opts.find((o) => o.id === l.mistake_id) ?? null } : null);
      setPick(opts.find((o) => o.status !== "closed")?.id ?? "new");
      setLoading(false);
    })();
    return () => {
      live = false;
    };
  }, [open, jobId, source, sourceId]);

  async function link() {
    const supabase = createClient();
    let h: number | null = null;
    if (source === "time_entry" && hours.trim()) {
      h = Number(hours);
      if (!Number.isFinite(h) || h <= 0) return toast.error("Rework hours must be more than 0.");
      if (entryHours != null && h > entryHours) return toast.error(`That entry is only ${entryHours} h.`);
    }
    setSaving(true);
    let mistakeId = pick;
    if (pick === "new") {
      const description = newDescription.trim();
      if (!newCategory || !description) {
        setSaving(false);
        return toast.error("Pick a category and say what went wrong.");
      }
      mistakeId = crypto.randomUUID();
      const { error } = await supabase.from("job_mistakes").insert({ id: mistakeId, job_id: jobId, category_id: newCategory, description });
      if (error) {
        setSaving(false);
        console.error("mistake insert failed:", error.message);
        return toast.error("Couldn't log the mistake.");
      }
    }
    const { error } = await supabase.from("mistake_cost_lines").insert({ mistake_id: mistakeId, kind: DEFAULT_KIND[source], source, source_id: sourceId, hours: h });
    setSaving(false);
    if (error) {
      console.error("mistake link failed:", error.message);
      return toast.error(error.code === "23505" ? "That's already part of a mistake." : "Couldn't link it to the mistake.");
    }
    toast.success("Marked as part of the mistake");
    setOpen(false);
  }

  async function unlink() {
    if (!linked) return;
    setSaving(true);
    const { error } = await createClient().from("mistake_cost_lines").delete().eq("id", linked.lineId);
    setSaving(false);
    if (error) {
      console.error("mistake unlink failed:", error.message);
      return toast.error("Couldn't unlink it.");
    }
    toast.success("No longer part of the mistake");
    setOpen(false);
  }

  return (
    <>
      <button
        type="button"
        title="Part of a mistake?"
        aria-label="Mark as part of a mistake"
        className={className ?? "p-1 text-slate-300 hover:text-amber-600"}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <AlertTriangle className="w-3.5 h-3.5" />
      </button>
      <Dialog open={open} onOpenChange={(o) => !saving && setOpen(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Mistake?</DialogTitle>
            <DialogDescription>
              Mark this {SOURCE_LABELS[source].toLowerCase()} as part of a mistake. It stays counted once in the job&apos;s cost.
            </DialogDescription>
          </DialogHeader>
          {loading ? (
            <p className="text-sm text-slate-400">Loading…</p>
          ) : notReady ? (
            <p className="text-sm text-slate-500">Mistake tracking isn&apos;t switched on yet — the 0119 database update still has to be applied.</p>
          ) : linked ? (
            <div className="space-y-3">
              <p className="text-sm text-slate-700">
                Part of:{" "}
                <span className="font-medium">
                  {linked.mistake ? `${formatDate(linked.mistake.occurred_on, { day: "numeric", month: "short" })} — ${linked.mistake.description}` : "a mistake"}
                </span>
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setOpen(false)}>
                  Close
                </Button>
                <Button variant="outline" onClick={() => void unlink()} disabled={saving}>
                  Unlink
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <select className={selectClass} value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Which mistake">
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {formatDate(o.occurred_on, { day: "numeric", month: "short" })} — {o.description.slice(0, 60)}
                    {o.status === "closed" ? " (closed)" : ""}
                  </option>
                ))}
                <option value="new">+ A new mistake…</option>
              </select>
              {pick === "new" && (
                <div className="space-y-2">
                  <select className={selectClass} value={newCategory} onChange={(e) => setNewCategory(e.target.value)} aria-label="Category">
                    <option value="">Category…</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <Input maxLength={MISTAKE_DESCRIPTION_MAX} placeholder="What went wrong" value={newDescription} onChange={(e) => setNewDescription(e.target.value)} />
                </div>
              )}
              {source === "time_entry" && (
                <Input inputMode="decimal" placeholder={`Rework hours (blank = all${entryHours != null ? ` ${entryHours} h` : ""})`} value={hours} onChange={(e) => setHours(e.target.value)} />
              )}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
                  Cancel
                </Button>
                <Button onClick={() => void link()} disabled={saving} className="gap-1.5">
                  {saving && <Loader2 className="w-4 h-4 animate-spin" />} Mark as mistake
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
