"use client";

import { useState } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { LEAVE_TYPE_AUDIENCES, type LeaveTypeAudience } from "@/lib/staff-leave";

/**
 * Who sees the leave TYPE ("Sick", "Annual leave") on the schedule —
 * schedule_settings.leave_type_visible_to (0112 — a draft, not applied yet). Everyone else sees
 * "Unavailable". The database enforces it (schedule_leave() returns the type
 * as NULL to anyone outside it); this only changes the setting. Admin only,
 * by RLS as well as here.
 */
export function LeaveVisibilitySetting({
  initial,
  available,
  canEdit,
}: {
  initial: LeaveTypeAudience;
  /** False on a database without 0112: shown, but nothing to change yet. */
  available: boolean;
  canEdit: boolean;
}) {
  const [value, setValue] = useState<LeaveTypeAudience>(initial);
  const [saving, setSaving] = useState(false);

  async function change(next: LeaveTypeAudience) {
    const before = value;
    setValue(next);
    setSaving(true);
    const supabase = createClient();
    // `count`: an update RLS filters out "succeeds" against zero rows.
    const { error, count } = await supabase
      .from("schedule_settings")
      .update({ leave_type_visible_to: next, updated_at: new Date().toISOString() }, { count: "exact" })
      .eq("id", true);
    setSaving(false);
    if (error || count === 0) {
      setValue(before);
      toast.error("Couldn't save — only an admin can change this.");
      return;
    }
    toast.success("Saved");
  }

  if (!available) {
    return <p className="text-sm text-slate-500">Leave on the schedule isn&apos;t switched on in the database yet (migration 0112).</p>;
  }

  return (
    <fieldset className="space-y-2" disabled={!canEdit || saving}>
      <legend className="text-sm font-medium text-slate-700 mb-1">Who sees the type of leave (Sick, Annual leave…)</legend>
      {LEAVE_TYPE_AUDIENCES.map((a) => (
        <label key={a.value} className="flex items-center gap-2 text-sm">
          <input type="radio" name="leave-audience" value={a.value} checked={value === a.value} onChange={() => void change(a.value)} />
          {a.label}
        </label>
      ))}
      <p className="text-xs text-slate-500">Everyone else sees &ldquo;Unavailable&rdquo; on those days. {canEdit ? "" : "Only an admin can change this."}</p>
    </fieldset>
  );
}
