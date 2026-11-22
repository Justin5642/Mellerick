"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SignaturePad, type SignaturePadHandle } from "./signature-pad";
import { createClient } from "@/lib/supabase/client";
import { pushJobToCalendar } from "@/lib/schedule-dispatch";
import { toast } from "sonner";
import { plausibleClockedHours } from "@/lib/time-entry-hours";
import { dateKeyInBusinessTZ } from "@/lib/date";
import {
  completionMode,
  defaultStageTicks,
  openStages,
  planStageCompletion,
  stageCompletionConfirm,
  stageSignOffNote,
  stagesStillOpenMessage,
  STAGE_SIGNOFF_SOURCE,
  STAGES_UNCHECKED_WARNING,
  type CompletionPlan,
  type StageBooking,
} from "@/lib/stage-completion";
import type { JobStage } from "@/lib/builder-po-stages";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle2, RotateCcw, Save, Mic, AlertTriangle, Loader2 } from "lucide-react";

interface Props {
  jobId: string;
  currentUserId: string;
  existingSignature?: string | null;
  voiceReportTranscript?: string | null;
  /** The signer's own bookings on this job, to pre-tick today's stage. */
  myBookings?: StageBooking[];
}

type OkPlan = Extract<CompletionPlan, { ok: true }>;

// A job with two or more open stages (its builder PO's lines) completes per
// stage (Justin, 22 Nov 2026): the ticked stages close and the job stays open
// for the rest, unless every open stage is ticked. Rule in
// lib/stage-completion.ts (mirrored on the phone). If the stage list can't be
// read, the sign-off closes the whole job, as before, and says so.
export function JobSignature({ jobId, currentUserId, existingSignature, voiceReportTranscript, myBookings }: Props) {
  const padRef = useRef<SignaturePadHandle>(null);
  const [signerName, setSignerName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);
  const [stages, setStages] = useState<JobStage[] | null>(null);
  const [stagesError, setStagesError] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [stagesOnly, setStagesOnly] = useState<OkPlan | null>(null);

  const supabase = createClient();

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}/stages`);
        if (!res.ok) throw new Error(`stages ${res.status}`);
        const body = (await res.json()) as { stages: JobStage[] };
        const { data: open } = await createClient()
          .from("time_entries")
          .select("cost_center_id")
          .eq("job_id", jobId)
          .eq("staff_id", currentUserId)
          .eq("entry_type", "work")
          .is("clock_out", null)
          .order("clock_in", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!live) return;
        setStages(body.stages);
        setPicked(new Set(defaultStageTicks(body.stages, myBookings, dateKeyInBusinessTZ(new Date()), open?.cost_center_id ?? null)));
      } catch {
        if (live) setStagesError(true);
      }
    })();
    return () => {
      live = false;
    };
    // The defaults are set once, when the list arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, currentUserId]);

  const perStage = stages !== null && completionMode(stages) === "per-stage";
  const stagesLoading = stages === null && !stagesError;
  const plan = useMemo(() => planStageCompletion(stages, picked), [stages, picked]);

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearCanvas() {
    padRef.current?.clear();
    setSaved(false);
  }

  /** The plan to save once confirmed, or null. */
  function confirmedPlan(technician: boolean): OkPlan | null {
    if (stagesLoading) { toast.error("Still checking the job's stages — try again in a moment."); return null; }
    if (!plan.ok) { toast.error(plan.problem); return null; }
    if (perStage) {
      const c = stageCompletionConfirm(plan);
      const who = technician ? "\n\nSigned off in your name, without the customer." : "";
      return window.confirm(`${c.title}\n\n${c.message}${who}`) ? plan : null;
    }
    if (technician) {
      const warn = stagesError ? `\n\n${STAGES_UNCHECKED_WARNING}` : "";
      return window.confirm(`Complete this job in your name, without the customer's signature?${warn}`) ? plan : null;
    }
    if (stagesError && !window.confirm(STAGES_UNCHECKED_WARNING)) return null;
    return plan;
  }

  // null when there was nothing to close or it closed; otherwise the error.
  async function clockOutOfJob(): Promise<unknown> {
    const { data: open, error } = await supabase
      .from("time_entries")
      .select("id, clock_in")
      .eq("job_id", jobId)
      .eq("staff_id", currentUserId)
      .eq("entry_type", "work")
      .is("clock_out", null)
      .order("clock_in", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return error;
    if (!open) return null;
    const clockOut = new Date().toISOString();
    const { error: updateError } = await supabase
      .from("time_entries")
      .update({ clock_out: clockOut, hours: plausibleClockedHours(open.clock_in, clockOut) })
      .eq("id", open.id);
    return updateError ?? null;
  }

  /** Mark the plan's stages complete; the names that failed. */
  async function completeStages(p: OkPlan): Promise<string[]> {
    const failed: string[] = [];
    const completedAt = new Date().toISOString();
    for (let i = 0; i < p.stageIds.length; i++) {
      const res = await fetch(`/api/jobs/${jobId}/stages/${p.stageIds[i]}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completedAt }),
      }).catch(() => null);
      if (!res?.ok) failed.push(p.stageNames[i]);
    }
    return failed;
  }

  /**
   * After the signature (or the technician's sign-off): close the job, or
   * only the ticked stages.
   */
  async function finish(p: OkPlan, completionNote: string, signedOffBy: string): Promise<void> {
    const date = new Date().toLocaleDateString("en-AU");
    if (p.closesJob) {
      const { error: jobError } = await supabase.from("jobs").update({
        completion_notes: completionNote,
        status: "completed",
        actual_end: new Date().toISOString(),
        ready_to_invoice: true,
      }).eq("id", jobId);
      if (jobError) {
        // Any signature IS saved against the job, so do not ask for it again —
        // that would stack duplicate signature rows. Only the completion flags
        // failed, and the office needs to know they are missing.
        toast.error(
          `Signed off, but this job was not marked complete: ${jobError.message}. ` +
            `Tell the office — it will not appear in Ready to Invoice.`
        );
        setSaving(false);
        return;
      }
    } else {
      const { error: noteError } = await supabase.from("job_notes").insert({
        job_id: jobId,
        author_id: currentUserId,
        content: stageSignOffNote({ stageNames: p.stageNames, signedOffBy, date, remainingNames: p.remainingNames }),
        source: STAGE_SIGNOFF_SOURCE,
      });
      if (noteError) toast.error("The stage sign-off note wasn't saved — add a note on the Notes tab.");
    }

    const failedStages = await completeStages(p);
    if (failedStages.length) toast.error(`Not marked complete: ${failedStages.join(", ")}. Try again from the PO tab or tell the office.`);

    // The signer's clock stops with it (31 Oct 2026). Only their own open
    // work entry on this job; the rest of the crew clock off themselves.
    const clockOutError = await clockOutOfJob();
    if (clockOutError) toast.error("Signed off, but you're still clocked in — clock out on the Time tab.");

    if (p.closesJob) {
      const calendarSynced = await pushJobToCalendar(jobId);
      if (calendarSynced) toast.success("Job complete — flagged for office review");
      else toast.warning("Job complete — flagged for office review, but Google Calendar was not updated");
      setSaved(true);
    } else {
      toast.success(`Stage complete: ${p.stageNames.join(", ")}. ${stagesStillOpenMessage(p.remainingNames)}`);
      setStagesOnly(p);
    }
    setSaving(false);
  }

  async function handleSave() {
    if (!hasSignature) { toast.error("Please provide a signature first"); return; }
    if (!padRef.current) return;
    const p = confirmedPlan(false);
    if (!p) return;
    setSaving(true);

    const blob = await padRef.current.toBlob();
    if (!blob) { setSaving(false); return; }

    const path = `${jobId}/signature_${Date.now()}.png`;
    const { error: uploadError } = await supabase.storage.from("job-photos").upload(path, blob, { contentType: "image/png" });
    if (uploadError) { toast.error("Failed to save signature"); setSaving(false); return; }

    // The upload was checked; the row and the completion are the writes that
    // make the sign-off real. Without the row the signature is an orphaned
    // PNG nothing references.
    const { error: photoError } = await supabase.from("job_photos").insert({
      job_id: jobId,
      uploaded_by: currentUserId,
      storage_path: path,
      photo_type: "signature",
      caption: signerName || "Customer signature",
    });

    if (photoError) {
      toast.error(`The signature image was uploaded but not recorded: ${photoError.message}. Please sign again.`);
      setSaving(false);
      return;
    }

    await finish(
      p,
      `Signed off by: ${signerName || "Customer"} on ${new Date().toLocaleDateString("en-AU")}`,
      `customer ${signerName || "Customer"}`
    );
  }

  // Customer not on site (Justin, 2 Nov 2026: "9 times out of 10, the
  // customer is not there"): the technician signs off in their own name, with
  // no signature. Same completion and clock-off as a signature.
  async function handleTechnicianComplete() {
    const p = confirmedPlan(true);
    if (!p) return;
    setSaving(true);
    const { data: me } = await supabase.from("profiles").select("full_name").eq("id", currentUserId).maybeSingle();
    const name = me?.full_name?.trim();
    const who = name ? `technician ${name}` : "the technician";
    await finish(
      p,
      `Signed off by ${who} on ${new Date().toLocaleDateString("en-AU")} (customer not on site)`,
      `${who} (customer not on site)`
    );
  }

  const open = openStages(stages);
  const doneStages = (stages ?? []).filter((s) => s.completedAt);
  const stageOnlyNext = perStage && plan.ok && !plan.closesJob;
  const done = saved || !!existingSignature;

  return (
    <div className="p-6 max-w-xl space-y-6">
      <div>
        <h2 className="text-base font-semibold text-slate-900">Customer Sign-Off</h2>
        <p className="text-sm text-slate-500">
          {perStage ? "Sign off the stages that are finished — the job stays open for the rest" : "Capture customer signature to complete the job"}
        </p>
      </div>

      {done ? (
        <Card className="border-green-200 bg-green-50">
          <CardContent className="flex items-center gap-4 p-6">
            <CheckCircle2 className="w-8 h-8 text-green-600 flex-shrink-0" />
            <div>
              <p className="font-semibold text-green-900">Job Signed Off</p>
              <p className="text-sm text-green-700">{existingSignature}</p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {stagesOnly && (
        <Card className="border-green-200 bg-green-50">
          <CardContent className="flex items-center gap-4 p-6">
            <CheckCircle2 className="w-8 h-8 text-green-600 flex-shrink-0" />
            <div>
              <p className="font-semibold text-green-900">Stage complete: {stagesOnly.stageNames.join(", ")}</p>
              <p className="text-sm text-green-700">{stagesStillOpenMessage(stagesOnly.remainingNames)}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {voiceReportTranscript && (
        <Card className="border-blue-100 bg-blue-50/40">
          <CardContent className="p-4 space-y-1.5">
            <div className="flex items-center gap-2 text-blue-700">
              <Mic className="w-4 h-4" />
              <p className="text-sm font-semibold">Voice Report (transcribed)</p>
            </div>
            <p className="text-sm text-slate-600 whitespace-pre-wrap">{voiceReportTranscript}</p>
          </CardContent>
        </Card>
      )}

      {!done && !stagesOnly && (
        <>
          {stagesLoading && (
            <p className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin" />Checking the job&apos;s stages…
            </p>
          )}
          {stagesError && (
            <p className="flex items-center gap-2 text-sm font-medium text-amber-700">
              <AlertTriangle className="w-4 h-4" />{STAGES_UNCHECKED_WARNING}
            </p>
          )}
          {perStage && (
            <div className="space-y-2">
              <Label>Which stages are complete?</Label>
              {open.map((s) => (
                <label key={s.id} className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2 cursor-pointer has-[:checked]:border-blue-500 has-[:checked]:bg-blue-50">
                  <input type="checkbox" className="h-4 w-4" checked={picked.has(s.id)} onChange={() => toggle(s.id)} />
                  <span className="flex-1">
                    <span className="block text-sm font-medium text-slate-900">{s.name}</span>
                    {s.costCentre && <span className="block text-xs text-slate-500">{s.costCentre}</span>}
                  </span>
                </label>
              ))}
              {doneStages.map((s) => (
                <div key={s.id} className="flex items-center gap-3 rounded-lg border border-slate-100 px-3 py-2">
                  <CheckCircle2 className="w-4 h-4 text-green-600" />
                  <span className="text-sm text-slate-500">
                    {s.name} — complete {new Date(s.completedAt as string).toLocaleDateString("en-AU")}
                  </span>
                </div>
              ))}
              <p className="text-xs text-slate-500">
                {!plan.ok
                  ? plan.problem
                  : plan.closesJob
                    ? "Every open stage is ticked, so this completes the whole job."
                    : stagesStillOpenMessage(plan.remainingNames)}
              </p>
            </div>
          )}

          <Card className="border-slate-200">
            <CardContent className="flex items-center justify-between gap-4 p-4">
              <div>
                <p className="text-sm font-semibold text-slate-900">Customer not on site?</p>
                <p className="text-xs text-slate-500">
                  {stageOnlyNext ? "Sign off the ticked stages in your name." : "Complete the job in your name."} No customer name or signature needed.
                </p>
              </div>
              <Button variant="outline" onClick={handleTechnicianComplete} disabled={saving || stagesLoading} className="gap-2 shrink-0">
                <CheckCircle2 className="w-4 h-4" />{stageOnlyNext ? "Stage complete as technician" : "Complete as technician"}
              </Button>
            </CardContent>
          </Card>
        </>
      )}

      {!stagesOnly && (
        <>
          <div className="space-y-2">
            <Label htmlFor="signerName">Customer Name</Label>
            <Input id="signerName" value={signerName} onChange={(e) => setSignerName(e.target.value)} placeholder="e.g. John Smith" />
          </div>

          <div className="space-y-2">
            <Label>Signature</Label>
            <SignaturePad ref={padRef} onChange={setHasSignature} />
            <p className="text-xs text-slate-400">Draw signature above using mouse or finger on touchscreen</p>
          </div>

          <div className="flex gap-3">
            <Button variant="outline" onClick={clearCanvas} className="gap-2">
              <RotateCcw className="w-4 h-4" />Clear
            </Button>
            <Button onClick={handleSave} disabled={saving || !hasSignature || stagesLoading} className="gap-2 flex-1">
              <Save className="w-4 h-4" />
              {saving ? "Saving..." : stageOnlyNext ? "Save & Stage complete" : "Save & Complete Job"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
