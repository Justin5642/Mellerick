"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { loadJobCostCenters, loadScheduleDialogData, type DialogStaff, type ScheduleDialogData } from "@/lib/schedule-dialog-data";
import type { SchedulePrefill } from "@/lib/schedule-existing-job";

// Fetched the first time the board opens a job's schedule.
const ScheduleJobDialog = dynamic(() => import("@/components/job/schedule-job-dialog").then((m) => m.ScheduleJobDialog), { ssr: false });

/**
 * A job's Schedule dialog opened over the board (23 Nov 2026): the office
 * picks a job and a technician's day without leaving the board, as on the
 * phone. Reads what the dialog needs (lib/schedule-dialog-data.ts — the same
 * helpers the job page uses), then shows the dialog itself, unchanged: a new
 * row for the clicked technician and day (`prefill`) beside the saved
 * bookings, and its own cost-centre, leave, clash and closed-job rules. Its
 * Save refreshes the page, which redraws the board.
 */
export function BoardScheduleDialog({
  request,
  staff,
  currentUserId,
  onClose,
}: {
  /** The job to open, and the technician/day to start a new booking on (null = just open it). */
  request: { jobId: string; jobNumber: number; prefill: SchedulePrefill | null } | null;
  staff: DialogStaff[];
  currentUserId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [data, setData] = useState<ScheduleDialogData | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setData(null);
    setOpen(false);
    if (!request) return;
    let live = true;
    const loading = toast.loading(`Opening #${request.jobNumber}…`);
    void loadScheduleDialogData(supabase, request.jobId, staff).then((result) => {
      toast.dismiss(loading);
      if (!live) return;
      if (!result.ok) {
        toast.error(result.error);
        onClose();
        return;
      }
      setData(result.data);
      setOpen(true);
    });
    return () => {
      live = false;
      toast.dismiss(loading);
    };
    // A new request (or none) is the only trigger; staff and onClose are read as they are then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  if (!request || !data) return null;
  return (
    <ScheduleJobDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) onClose();
      }}
      prefill={request.prefill}
      jobId={data.job.id}
      jobNumber={data.job.job_number}
      jobStatus={data.job.status}
      staff={data.staff}
      currentUserId={currentUserId}
      costCenters={data.costCenters}
      scheduledCostCenterId={data.job.scheduled_cost_center_id}
      onCostCentreAdded={() => {
        // A $0 line was added from the picker: re-read the job's lines only
        // (re-reading the bookings would reset the rows being edited).
        void loadJobCostCenters(supabase, data.job.id).then(({ costCenters }) =>
          setData((d) => (d && d.job.id === data.job.id ? { ...d, costCenters } : d)),
        );
      }}
      bookings={data.bookings}
      bookingsReady={data.bookingsReady}
      onReopen={() => router.push(`/dashboard/jobs/${data.job.id}`)}
    />
  );
}
