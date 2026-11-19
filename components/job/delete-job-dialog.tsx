"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Trash2 } from "lucide-react";

interface Props {
  jobId: string;
  jobNumber: number;
  jobTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Deleting goes through DELETE /api/jobs/[id] (admin only, run as the caller
// under RLS), the same route the phone uses. Deleting a job cascades (at the database level) to its notes, photos,
// documents, time entries, expenses, and variations — those tables all
// reference jobs(id) with "on delete cascade". Quotes and invoices, however,
// reference jobs(id) with no delete action (the default "restrict"), so the
// database itself refuses to delete a job that already has a quote or
// invoice linked to it — that shows up here as a Postgres foreign-key
// violation (error code 23503), which we translate into a clear message
// instead of a raw SQL error.
export function DeleteJobDialog({ jobId, jobNumber, jobTitle, open, onOpenChange }: Props) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    let message: string | null = null;
    try {
      const res = await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        message = typeof data.error === "string" ? data.error : "Couldn't delete the job. Try again.";
      }
    } catch {
      message = "Couldn't reach the server. Check your connection and try again.";
    }
    if (message) {
      toast.error(message);
      setDeleting(false);
      return;
    }
    toast.success("Job deleted");
    router.push("/dashboard/jobs");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete job #{jobNumber}?</DialogTitle>
          <DialogDescription>
            This permanently deletes &ldquo;{jobTitle}&rdquo; along with all of its notes, photos, documents,
            time entries, expenses, and variations. This can&apos;t be undone. If the details were just wrong,
            consider editing the job instead — most fields including customer, site, and title can be corrected
            on the Overview tab.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={deleting}>Cancel</Button>
          <Button variant="destructive" className="gap-2" onClick={handleDelete} disabled={deleting}>
            <Trash2 className="w-4 h-4" />{deleting ? "Deleting..." : "Delete Job"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
