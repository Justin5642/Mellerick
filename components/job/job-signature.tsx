"use client";

import { useRef, useState } from "react";
import { SignaturePad, type SignaturePadHandle } from "./signature-pad";
import { createClient } from "@/lib/supabase/client";
import { pushJobToCalendar } from "@/lib/schedule-dispatch";
import { toast } from "sonner";
import { plausibleClockedHours } from "@/lib/time-entry-hours";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle2, RotateCcw, Save, Mic } from "lucide-react";

interface Props {
  jobId: string;
  currentUserId: string;
  existingSignature?: string | null;
  voiceReportTranscript?: string | null;
}

export function JobSignature({ jobId, currentUserId, existingSignature, voiceReportTranscript }: Props) {
  const padRef = useRef<SignaturePadHandle>(null);
  const [signerName, setSignerName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);

  function clearCanvas() {
    padRef.current?.clear();
    setSaved(false);
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

  async function handleSave() {
    if (!hasSignature) { toast.error("Please provide a signature first"); return; }
    if (!padRef.current) return;
    setSaving(true);

    const blob = await padRef.current.toBlob();
    if (!blob) { setSaving(false); return; }

    const path = `${jobId}/signature_${Date.now()}.png`;
    const { error: uploadError } = await supabase.storage.from("job-photos").upload(path, blob, { contentType: "image/png" });
    if (uploadError) { toast.error("Failed to save signature"); setSaving(false); return; }

    // The upload was checked; these two were not, and they are the writes that
    // make the sign-off real. Without the row the signature is an orphaned PNG
    // nothing references; without the job update the work is never marked
    // complete and never reaches the office's Ready-to-Invoice queue — while
    // the technician is told "Job complete", packs up and drives away.
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

    const { error: jobError } = await supabase.from("jobs").update({
      completion_notes: `Signed off by: ${signerName || "Customer"} on ${new Date().toLocaleDateString("en-AU")}`,
      status: "completed",
      actual_end: new Date().toISOString(),
      ready_to_invoice: true,
    }).eq("id", jobId);

    if (jobError) {
      // The signature IS saved against the job, so do not ask for it again —
      // that would stack duplicate signature rows. Only the completion flags
      // failed, and the office needs to know they are missing.
      toast.error(
        `Signature saved, but this job was not marked complete: ${jobError.message}. ` +
          `Tell the office — it will not appear in Ready to Invoice.`
      );
      setSaving(false);
      return;
    }

    // The job is complete either way, so this is not an error — but the
    // technician's calendar still showing it as booked is worth one sentence
    // rather than the silence `.catch(() => {})` used to give it.
    // The job is finished, so the signer's clock stops with it (31 Oct 2026).
    // Only their own open work entry on this job; the rest of the crew clock
    // off themselves. A failure here leaves the sign-off intact and says so.
    const clockOutError = await clockOutOfJob();
    if (clockOutError) toast.error("Job complete, but you're still clocked in — clock out on the Time tab.");

    const calendarSynced = await pushJobToCalendar(jobId);
    if (calendarSynced) toast.success("Job complete — flagged for office review");
    else toast.warning("Job complete — flagged for office review, but Google Calendar was not updated");
    setSaved(true);
    setSaving(false);
  }

  // Customer not on site (Justin, 2 Nov 2026: "9 times out of 10, the
  // customer is not there"): the technician completes the job in their own
  // name, with no signature. Same completion and clock-off as a signature.
  async function handleTechnicianComplete() {
    if (!window.confirm("Complete this job in your name, without the customer's signature?")) return;
    setSaving(true);
    const { data: me } = await supabase.from("profiles").select("full_name").eq("id", currentUserId).maybeSingle();
    const name = me?.full_name?.trim();
    const { error: jobError } = await supabase.from("jobs").update({
      completion_notes: `Signed off by ${name ? `technician ${name}` : "the technician"} on ${new Date().toLocaleDateString("en-AU")} (customer not on site)`,
      status: "completed",
      actual_end: new Date().toISOString(),
      ready_to_invoice: true,
    }).eq("id", jobId);
    if (jobError) {
      toast.error(`This job was not marked complete: ${jobError.message}`);
      setSaving(false);
      return;
    }
    const clockOutError = await clockOutOfJob();
    if (clockOutError) toast.error("Job complete, but you're still clocked in — clock out on the Time tab.");
    const calendarSynced = await pushJobToCalendar(jobId);
    if (calendarSynced) toast.success("Job complete — flagged for office review");
    else toast.warning("Job complete — flagged for office review, but Google Calendar was not updated");
    setSaved(true);
    setSaving(false);
  }

  const supabase = createClient();

  return (
    <div className="p-6 max-w-xl space-y-6">
      <div>
        <h2 className="text-base font-semibold text-slate-900">Customer Sign-Off</h2>
        <p className="text-sm text-slate-500">Capture customer signature to complete the job</p>
      </div>

      {saved || existingSignature ? (
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

      {!(saved || existingSignature) && (
        <Card className="border-slate-200">
          <CardContent className="flex items-center justify-between gap-4 p-4">
            <div>
              <p className="text-sm font-semibold text-slate-900">Customer not on site?</p>
              <p className="text-xs text-slate-500">Complete the job in your name. No customer name or signature needed.</p>
            </div>
            <Button variant="outline" onClick={handleTechnicianComplete} disabled={saving} className="gap-2 shrink-0">
              <CheckCircle2 className="w-4 h-4" />Complete as technician
            </Button>
          </CardContent>
        </Card>
      )}

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
        <Button onClick={handleSave} disabled={saving || !hasSignature} className="gap-2 flex-1">
          <Save className="w-4 h-4" />
          {saving ? "Saving..." : "Save & Complete Job"}
        </Button>
      </div>
    </div>
  );
}
