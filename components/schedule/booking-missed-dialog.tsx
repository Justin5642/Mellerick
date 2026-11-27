"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { KeyboardSafeDialogContent } from "@/components/ui/keyboard-safe-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  isMissed,
  MISSED_NOTE_MAX,
  MISSED_REASONS,
  missedDetailText,
  validateMissed,
  type MissedFields,
} from "@/lib/booking-attendance";
import { cn } from "@/lib/utils";

// "Didn't make it" for the office on the web (Justin, 27 Nov 2026; migration
// 0121). The phone is the technician's door; this is the office's, from the
// board's booking menu and the job Overview's bookings list. Same reasons and
// rules as the phone's sheet (lib/booking-attendance.ts validateMissed), and
// the same route: POST/DELETE /api/jobs/[id]/bookings/[bookingId]/missed,
// which runs flag_booking_missed() / clear_booking_missed() as the caller.
// No money: a reason and a note.

export interface MissedTarget {
  jobId: string;
  bookingId: string;
  /** "#123 — Dan, Tue 25 Nov". */
  title: string;
  missed: MissedFields;
}

async function callMissed(target: MissedTarget, body: { reason: string; note: string | null } | null): Promise<string | null> {
  try {
    const res = await fetch(`/api/jobs/${target.jobId}/bookings/${target.bookingId}/missed`, {
      method: body ? "POST" : "DELETE",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return null;
    const answer = (await res.json().catch(() => null)) as { error?: string } | null;
    return answer?.error ?? "Couldn't save that. Try again.";
  } catch {
    return "Couldn't reach the server. Try again.";
  }
}

export function BookingMissedDialog({
  target,
  onClose,
  onSaved,
}: {
  target: MissedTarget | null;
  onClose: () => void;
  /** After a flag or clear the server accepted — refresh the page. */
  onSaved: () => void;
}) {
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    setReason(target.missed.missed_reason ?? null);
    setNote(target.missed.missed_note ?? "");
    setError(null);
  }, [target]);

  const flagged = target ? isMissed(target.missed) : false;

  async function save() {
    if (!target) return;
    const checked = validateMissed({ reason, note });
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setSaving(true);
    const refused = await callMissed(target, { reason: checked.reason, note: checked.note });
    setSaving(false);
    if (refused) {
      setError(refused);
      return;
    }
    toast.success("Marked \"Didn't make it\" — the booking stays where it is until it's moved.");
    onSaved();
    onClose();
  }

  async function clear() {
    if (!target) return;
    setSaving(true);
    const refused = await callMissed(target, null);
    setSaving(false);
    if (refused) {
      setError(refused);
      return;
    }
    toast.success("\"Didn't make it\" cleared");
    onSaved();
    onClose();
  }

  return (
    <Dialog open={!!target} onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <KeyboardSafeDialogContent
        className="sm:max-w-md"
        header={
          <DialogHeader>
            <DialogTitle>Didn&apos;t make it</DialogTitle>
            <DialogDescription>{target?.title}</DialogDescription>
          </DialogHeader>
        }
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              {flagged && (
                <Button variant="outline" className="border-red-200 text-red-600 hover:bg-red-50" onClick={clear} disabled={saving}>
                  Clear
                </Button>
              )}
              <Button onClick={save} disabled={saving || !reason}>
                {saving ? "Saving…" : flagged ? "Save" : "Mark didn't make it"}
              </Button>
            </div>
          </div>
        }
      >
        <div className="space-y-4">
          {flagged && target && <p className="text-sm text-red-700">Now: {missedDetailText(target.missed)}</p>}
          <div role="radiogroup" aria-label="Why" className="space-y-1.5">
            {MISSED_REASONS.map((r) => (
              <button
                key={r.key}
                type="button"
                role="radio"
                aria-checked={reason === r.key}
                onClick={() => { setReason(r.key); setError(null); }}
                className={cn(
                  "block w-full rounded-md border px-3 py-2 text-left text-sm",
                  reason === r.key ? "border-blue-500 bg-blue-50 font-medium text-blue-900" : "border-slate-200 hover:bg-slate-50",
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="missed-note">Note{reason === "other" ? " (needed for Other)" : " (optional)"}</Label>
            <Textarea
              id="missed-note"
              value={note}
              maxLength={MISSED_NOTE_MAX}
              onChange={(e) => { setNote(e.target.value); setError(null); }}
              rows={3}
              placeholder="What happened?"
            />
            <p className="text-xs text-slate-400">{note.length}/{MISSED_NOTE_MAX}</p>
          </div>
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <p className="text-xs text-slate-500">The booking stays where it is, flagged. Moving it to another day or technician clears the flag.</p>
        </div>
      </KeyboardSafeDialogContent>
    </Dialog>
  );
}
