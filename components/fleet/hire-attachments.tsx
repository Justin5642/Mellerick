"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Plus } from "lucide-react";

// Fleet → Attachments (Day Works / Hire, Stage 1): trencher and the like,
// charged a full day at their day rate (ex GST) whenever they are on a machine.
// hire_attachments is office/admin only by RLS (it carries rates).

export interface HireAttachmentRow {
  id: string;
  name: string;
  day_rate: number;
  is_active: boolean;
  notes: string | null;
}

export function HireAttachments({ initial }: { initial: HireAttachmentRow[] }) {
  const supabase = createClient();
  const [rows, setRows] = useState(initial);
  const [name, setName] = useState("");
  const [rate, setRate] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!name.trim()) return toast.error("Name the attachment.");
    const dayRate = Number(rate || 0);
    if (!Number.isFinite(dayRate) || dayRate < 0) return toast.error("Check the day rate.");
    setBusy(true);
    const { data, error } = await supabase.from("hire_attachments").insert({ name: name.trim(), day_rate: dayRate }).select("*").single();
    setBusy(false);
    if (error || !data) {
      return toast.error(error?.code === "23505" ? "There's already an attachment with that name." : "Couldn't add the attachment.");
    }
    setRows((r) => [...r, data as HireAttachmentRow].sort((a, b) => a.name.localeCompare(b.name)));
    setName("");
    setRate("");
    toast.success("Attachment added");
  }

  async function update(id: string, patch: Partial<Pick<HireAttachmentRow, "day_rate" | "is_active">>) {
    const previous = rows;
    setRows((r) => r.map((a) => (a.id === id ? { ...a, ...patch } : a)));
    const { error, count } = await supabase.from("hire_attachments").update(patch, { count: "exact" }).eq("id", id);
    if (error || count === 0) {
      setRows(previous);
      toast.error("Couldn't save the attachment.");
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Attachments</CardTitle>
        <p className="text-xs text-slate-500">Charged a full day (ex GST) on Day Works whenever they are on a machine.</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.length === 0 && <p className="text-sm text-slate-400">No attachments yet.</p>}
        <div className="divide-y">
          {rows.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center gap-3 py-2">
              <span className={`flex-1 min-w-[10rem] text-sm ${a.is_active ? "text-slate-900" : "text-slate-400 line-through"}`}>{a.name}</span>
              <label className="flex items-center gap-1 text-sm text-slate-600">
                $
                <Input
                  type="number" min={0} step={1} className="h-8 w-24"
                  defaultValue={a.day_rate}
                  onBlur={(e) => {
                    const v = Number(e.target.value || 0);
                    if (Number.isFinite(v) && v >= 0 && v !== Number(a.day_rate)) void update(a.id, { day_rate: v });
                  }}
                  aria-label={`${a.name} day rate`}
                />
                / day
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={a.is_active} onChange={(e) => void update(a.id, { is_active: e.target.checked })} />
                Offered
              </label>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Input className="flex-1 min-w-[10rem]" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rock breaker" />
          <Input className="w-28" type="number" min={0} step={1} value={rate} onChange={(e) => setRate(e.target.value)} placeholder="$ / day" />
          <Button size="sm" className="gap-1.5" onClick={() => void add()} disabled={busy}>
            <Plus className="w-4 h-4" />Add
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
