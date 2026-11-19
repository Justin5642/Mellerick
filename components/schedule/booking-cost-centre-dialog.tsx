"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { BookingCostCentreSelect } from "@/components/job/booking-cost-centre-select";
import { defaultBookingCostCentre, type BookingLineOption, type CompanyCostCentreOption } from "@/lib/booking-cost-centre";
import { loadBookingCostCentreOptions } from "@/lib/booking-cost-centre-client";

export interface CostCentreRequest {
  jobId: string;
  /** "Book #123 — Fix pipe" */
  title: string;
  /** "Dave on Thu 20 Nov, All day" */
  detail: string;
}

export interface PickedCostCentre {
  id: string;
  name: string;
}

/**
 * The to-do drop's first question (19 Nov 2026 — every booking asks for a
 * cost centre): which of the job's PO lines this booking is for, or a company
 * cost centre to add to the job at $0. Office/admin only (the to-do panel is).
 * Resolves with the line, or null when cancelled.
 */
export function BookingCostCentreDialog({
  request,
  onDone,
}: {
  request: CostCentreRequest | null;
  onDone: (picked: PickedCostCentre | null) => void;
}) {
  const [lines, setLines] = useState<BookingLineOption[]>([]);
  const [company, setCompany] = useState<CompanyCostCentreOption[]>([]);
  const [value, setValue] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const jobId = request?.jobId ?? null;
  useEffect(() => {
    if (!jobId) return;
    let live = true;
    setLoading(true);
    setLines([]);
    setValue(null);
    void loadBookingCostCentreOptions(createClient(), jobId).then((o) => {
      if (!live) return;
      setLines(o.lines);
      setCompany(o.company);
      setValue(defaultBookingCostCentre({ scheduled: o.scheduled, lines: o.lines }));
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [jobId]);

  const picked = value ? lines.find((l) => l.id === value) : undefined;

  return (
    <Dialog open={!!request} onOpenChange={(open) => { if (!open) onDone(null); }}>
      <DialogContent>
        {request && (
          <>
            <DialogHeader>
              <DialogTitle>{request.title}</DialogTitle>
              <DialogDescription>{request.detail}</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="drop-cost-centre">Cost centre</Label>
              {loading ? (
                <p className="text-sm text-slate-500">Loading the job&apos;s cost centres…</p>
              ) : (
                <BookingCostCentreSelect
                  id="drop-cost-centre"
                  jobId={request.jobId}
                  value={value}
                  lines={lines}
                  company={company}
                  onChange={setValue}
                  onLineAdded={(line) => setLines((prev) => (prev.some((l) => l.id === line.id) ? prev : [...prev, line]))}
                  showProblem
                />
              )}
              <p className="text-xs text-slate-400">What this booking&apos;s work is costed to. Change it later in the job&apos;s Schedule dialog.</p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onDone(null)}>Cancel</Button>
              <Button disabled={!picked} onClick={() => picked && onDone({ id: picked.id, name: picked.name })}>
                Continue
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
