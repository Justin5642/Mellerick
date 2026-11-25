"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2 } from "lucide-react";
import { formatDate } from "@/lib/date";
import { DEFAULT_KIND, SOURCE_LABELS, type LinkedSource } from "@/lib/mistake-costs";

// "Link existing cost" on a mistake (office/admin): every cost record already
// on the job — time, expenses, supplier POs, equipment usage, Day Works lines —
// not yet part of any mistake. Linking adds NO cost: the record is already in
// the job's cost; the link only says it went on this mistake (0119, a draft not applied yet).

interface Candidate {
  source: LinkedSource;
  id: string;
  date: string | null;
  title: string;
  amount: number | null;
  hours: number | null;
}

const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function loadLinkCandidates(jobId: string): Promise<Candidate[]> {
  const supabase = createClient();
  const [times, expenses, orders, usage, hire, linked] = await Promise.all([
    supabase.from("time_entries").select("id, clock_in, hours, entry_type, profiles!time_entries_staff_id_fkey(full_name)").eq("job_id", jobId).order("clock_in", { ascending: false }),
    supabase.from("job_expenses").select("id, supplier_name, description, amount, invoice_date, created_at").eq("job_id", jobId),
    supabase.from("vendor_orders").select("id, po_number, vendor_name, amount, status, order_date").eq("job_id", jobId).neq("status", "cancelled"),
    supabase.from("equipment_usage_log").select("id, usage_date, hours, loads, days, equipment(name)").eq("job_id", jobId),
    supabase.from("hire_entries").select("id, work_date, status, equipment(name)").eq("job_id", jobId).neq("status", "void"),
    supabase.from("mistake_cost_lines").select("source, source_id, job_mistakes!inner(job_id)").eq("job_mistakes.job_id", jobId).neq("source", "manual"),
  ]);
  const taken = new Set(((linked.data ?? []) as { source: string; source_id: string | null }[]).map((l) => `${l.source}:${l.source_id}`));
  const out: Candidate[] = [];
  for (const t of (times.data ?? []) as unknown as { id: string; clock_in: string; hours: number | null; entry_type: string; profiles: { full_name: string | null } | null }[]) {
    out.push({ source: "time_entry", id: t.id, date: t.clock_in, title: `${t.profiles?.full_name ?? "Staff member"}${t.entry_type === "travel" ? " (travel)" : ""}`, amount: null, hours: t.hours == null ? null : Number(t.hours) });
  }
  for (const e of (expenses.data ?? []) as { id: string; supplier_name: string | null; description: string | null; amount: number | null; invoice_date: string | null; created_at: string | null }[]) {
    out.push({ source: "job_expense", id: e.id, date: e.invoice_date ?? e.created_at, title: [e.supplier_name, e.description].filter(Boolean).join(" — ") || "Expense", amount: e.amount == null ? null : Number(e.amount), hours: null });
  }
  for (const o of (orders.data ?? []) as { id: string; po_number: string | null; vendor_name: string | null; amount: number | null; order_date: string | null }[]) {
    out.push({ source: "vendor_order", id: o.id, date: o.order_date, title: [o.po_number, o.vendor_name].filter(Boolean).join(" · ") || "Supplier PO", amount: o.amount == null ? null : Number(o.amount), hours: null });
  }
  for (const u of (usage.data ?? []) as unknown as { id: string; usage_date: string; hours: number; loads: number | null; days: number | null; equipment: { name: string } | null }[]) {
    const parts = [Number(u.hours) ? `${Number(u.hours)} h` : null, Number(u.loads) ? `${u.loads} loads` : null, Number(u.days) ? `${u.days} days` : null].filter(Boolean);
    out.push({ source: "equipment_usage", id: u.id, date: u.usage_date, title: `${u.equipment?.name ?? "Equipment"}${parts.length ? ` · ${parts.join(", ")}` : ""}`, amount: null, hours: null });
  }
  if (!hire.error) {
    for (const h of (hire.data ?? []) as unknown as { id: string; work_date: string; status: string; equipment: { name: string } | null }[]) {
      out.push({ source: "hire_entry", id: h.id, date: h.work_date, title: `${h.equipment?.name ?? "Machine"} · Day Works (${h.status})`, amount: null, hours: null });
    }
  }
  return out.filter((c) => !taken.has(`${c.source}:${c.id}`));
}

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  jobId: string;
  mistakeId: string;
  onLinked: () => void;
}

export function LinkCostDialog({ open, onOpenChange, jobId, mistakeId, onLinked }: Props) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [picked, setPicked] = useState<string>("");
  const [hours, setHours] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCandidates(null);
    setPicked("");
    setHours("");
    void loadLinkCandidates(jobId).then(setCandidates, () => setCandidates([]));
  }, [open, jobId]);

  const choice = candidates?.find((c) => `${c.source}:${c.id}` === picked) ?? null;

  async function link() {
    if (!choice) return;
    let h: number | null = null;
    if (choice.source === "time_entry" && hours.trim()) {
      h = Number(hours);
      if (!Number.isFinite(h) || h <= 0) return toast.error("Rework hours must be more than 0.");
      if (choice.hours != null && h > choice.hours) return toast.error(`That entry is only ${choice.hours} h.`);
    }
    setSaving(true);
    const { error } = await createClient()
      .from("mistake_cost_lines")
      .insert({ mistake_id: mistakeId, kind: DEFAULT_KIND[choice.source], source: choice.source, source_id: choice.id, hours: h });
    setSaving(false);
    if (error) {
      console.error("mistake link failed:", error.message);
      return toast.error(error.code === "23505" ? "That cost is already part of another mistake." : "Couldn't link that cost.");
    }
    toast.success("Cost linked");
    onOpenChange(false);
    onLinked();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Link a cost already on the job</DialogTitle>
          <DialogDescription>It&apos;s already in the job&apos;s cost — linking says it went on this mistake, without counting it twice.</DialogDescription>
        </DialogHeader>
        {!candidates ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : candidates.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing on this job left to link. Add a manual cost for anything with no record.</p>
        ) : (
          <div className="max-h-72 overflow-y-auto divide-y divide-slate-100 rounded border border-slate-200">
            {candidates.map((c) => {
              const key = `${c.source}:${c.id}`;
              return (
                <label key={key} className="flex items-start gap-2 px-2 py-1.5 text-sm cursor-pointer hover:bg-slate-50">
                  <input type="radio" name="link-cost" className="mt-1" checked={picked === key} onChange={() => setPicked(key)} />
                  <span className="flex-1">
                    <span className="text-xs text-slate-400">{SOURCE_LABELS[c.source]}</span> {c.title}
                    <span className="block text-xs text-slate-500">
                      {c.date ? formatDate(c.date, { day: "numeric", month: "short", year: "numeric" }) : ""}
                      {c.hours != null ? ` · ${c.hours} h` : ""}
                      {c.amount != null ? ` · ${money(c.amount)}` : ""}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        )}
        {choice?.source === "time_entry" && (
          <div className="space-y-1">
            <label className="text-xs text-slate-600" htmlFor="link-hours">
              Rework hours (blank = the whole entry)
            </label>
            <Input id="link-hours" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void link()} disabled={!choice || saving} className="gap-1.5">
            {saving && <Loader2 className="w-4 h-4 animate-spin" />} Link
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
