"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { computeHoursScoreboard, type ScoreboardTimeEntry, type ScoreboardTone } from "@/lib/hours-scoreboard";

// Technician-facing Hours Scoreboard for the web job page (Overview tab).
//
// MONEY BOUNDARY (HANDOVER.md §2): HOURS ONLY. `allocatedHours` comes from the
// money-free `purchase_orders_public` view (migration 0038) — the base
// `purchase_orders` table is office/admin-only and returns 0 rows to a tech.
// Nothing in this component may render a value, amount or PO list. Office and
// admin keep the full scoreboard (with PO value) on the Purchase Orders tab.
//
// Mirrors mobile/components/job/hours-scoreboard.tsx: live tick while clocked
// in, and a prompt to log a reason once the allocation is used up.

const CATEGORIES: { key: string; label: string }[] = [
  { key: "unexpected_issue", label: "Unexpected issue" },
  { key: "difficult_site", label: "Difficult site" },
  { key: "training_needed", label: "Training needed" },
  { key: "other", label: "Other" },
];

const TONE_TEXT: Record<ScoreboardTone, string> = {
  red: "text-red-600",
  orange: "text-orange-500",
  green: "text-green-600",
};
const TONE_BAR: Record<ScoreboardTone, string> = {
  red: "bg-red-500",
  orange: "bg-orange-400",
  green: "bg-green-500",
};

interface Props {
  jobId: string;
  currentUserId: string;
  allocatedHours: number;
  /** Error from the purchase_orders_public read, if it failed. */
  loadError: string | null;
  timeEntries: ScoreboardTimeEntry[];
  overtimeReason: string | null;
  overtimeCategory: string | null;
}

export function JobHoursScoreboard({ jobId, currentUserId, allocatedHours, loadError, timeEntries, overtimeReason: initialReason, overtimeCategory: initialCategory }: Props) {
  const [now, setNow] = useState(() => Date.now());
  const [overtimeReason, setOvertimeReason] = useState(initialReason);
  const [overtimeCategory, setOvertimeCategory] = useState(initialCategory);
  const [showForm, setShowForm] = useState(false);
  const [category, setCategory] = useState<string | null>(null);
  const [reasonText, setReasonText] = useState("");
  const [saving, setSaving] = useState(false);

  const s = computeHoursScoreboard(allocatedHours, timeEntries, now);

  // Tick every second while clocked in so the countdown is genuinely live.
  useEffect(() => {
    if (!s.openClockIn) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [s.openClockIn]);

  // A failed read must not look like "no hours allocated" (which renders
  // nothing) — that would hide a job running over budget.
  if (loadError) {
    return (
      <Card className="border-orange-200 bg-orange-50/60">
        <CardContent className="pt-4 pb-4 space-y-1">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Hours Scoreboard</p>
          <p className="text-sm font-medium text-orange-700">
            The allocated hours for this job couldn&apos;t be loaded — this is not the same as no hours being allocated.
          </p>
          <p className="text-xs font-mono text-slate-500">{loadError}</p>
        </CardContent>
      </Card>
    );
  }
  if (allocatedHours <= 0) return null;

  async function submitReason() {
    if (!category) {
      toast.error("Choose the category that best fits why the job ran over.");
      return;
    }
    setSaving(true);
    const supabase = createClient();
    const reason = reasonText.trim() || null;
    const { data, error } = await supabase
      .from("jobs")
      .update({
        overtime_category: category,
        overtime_reason: reason,
        overtime_logged_by: currentUserId,
        overtime_logged_at: new Date().toISOString(),
      })
      .eq("id", jobId)
      .select("id");
    setSaving(false);
    if (error || !data || data.length === 0) {
      toast.error(error?.message ?? "Could not save the reason for this job.");
      return;
    }
    setOvertimeCategory(category);
    setOvertimeReason(reason);
    setShowForm(false);
    toast.success("Overtime reason logged");
  }

  return (
    <Card className="border-blue-100 bg-blue-50/40">
      <CardContent className="pt-4 pb-4 space-y-3">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Hours Scoreboard</p>
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-sm text-slate-600">{s.openClockIn ? "Time used (live)" : "Time used"}</span>
            <span className={`text-sm font-bold ${TONE_TEXT[s.tone]}`}>
              {s.loggedHours.toFixed(1)}h / {s.allocatedHours.toFixed(1)}h
            </span>
          </div>
          <div className="w-full bg-slate-200 rounded-full h-3">
            <div className={`h-3 rounded-full transition-all ${TONE_BAR[s.tone]}`} style={{ width: `${s.pct}%` }} />
          </div>
          <div className="flex justify-between text-xs text-slate-400 mt-1">
            <span>{s.pct.toFixed(0)}% of budget used</span>
            <span>{s.remainingHours.toFixed(1)}h remaining</span>
          </div>
        </div>

        {(s.exceeded || overtimeCategory) && (
          <div className="pt-2 border-t space-y-2">
            {overtimeCategory ? (
              <>
                <p className="text-xs font-semibold text-red-600 uppercase tracking-wide">Overtime reason logged</p>
                <p className="text-sm text-slate-700">
                  {CATEGORIES.find((c) => c.key === overtimeCategory)?.label ?? overtimeCategory}
                  {overtimeReason ? ` — ${overtimeReason}` : ""}
                </p>
              </>
            ) : showForm ? (
              <>
                <p className="text-sm font-semibold text-red-600">Why did this job go over?</p>
                <div className="flex flex-wrap gap-1.5">
                  {CATEGORIES.map((c) => (
                    <Button
                      key={c.key}
                      type="button"
                      size="sm"
                      variant={category === c.key ? "default" : "outline"}
                      onClick={() => setCategory(c.key)}
                    >
                      {c.label}
                    </Button>
                  ))}
                </div>
                <Textarea
                  value={reasonText}
                  onChange={(e) => setReasonText(e.target.value)}
                  placeholder="Add a bit more detail (optional)..."
                  rows={2}
                />
                <Button size="sm" onClick={submitReason} disabled={saving}>
                  {saving ? "Saving..." : "Log Reason"}
                </Button>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold text-red-600">You&apos;ve used all the allocated hours for this job.</p>
                <Button size="sm" onClick={() => setShowForm(true)}>Log a reason</Button>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
