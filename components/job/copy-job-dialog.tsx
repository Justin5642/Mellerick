"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { COPY_TITLE_MAX, defaultCopyTitle } from "@/lib/job-copy";

interface Props {
  jobId: string;
  jobNumber: number;
  jobTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * "Copy job" (Justin's notebook list, 20 Nov 2026): a new job from this one
 * as a template — same customer, site, job type, priority and description,
 * and the cost-centre lines under a $0 `<new number>-1` PO. Office/admin
 * (the page shows the button to them; POST /api/jobs/[id]/copy checks).
 * Opens the new job when done.
 */
export function CopyJobDialog({ jobId, jobNumber, jobTitle, open, onOpenChange }: Props) {
  const router = useRouter();
  const [title, setTitle] = useState(defaultCopyTitle(jobTitle));
  const [copying, setCopying] = useState(false);

  useEffect(() => {
    if (open) setTitle(defaultCopyTitle(jobTitle));
  }, [open, jobTitle]);

  async function handleCopy() {
    setCopying(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/copy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, newJobId: crypto.randomUUID() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || typeof data.id !== "string") {
        toast.error(typeof data.error === "string" ? data.error : "Couldn't copy the job. Try again.");
        setCopying(false);
        return;
      }
      if (typeof data.warning === "string") toast.warning(data.warning);
      else toast.success(`Copied to job #${data.jobNumber}`);
      onOpenChange(false);
      setCopying(false);
      router.push(`/dashboard/jobs/${data.id}`);
    } catch {
      toast.error("Couldn't reach the server. Check your connection and try again.");
      setCopying(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !copying && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Copy job #{jobNumber}</DialogTitle>
          <DialogDescription>
            A new job for the same customer and site, with the same type, priority and description, and this job&apos;s
            cost centres (with their hours) under a $0 PO. Bookings, time, photos, notes, documents, invoices,
            variations and money are not copied.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="copy-title">Title</Label>
          <Input id="copy-title" value={title} maxLength={COPY_TITLE_MAX} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={copying}>Cancel</Button>
          <Button onClick={handleCopy} disabled={copying || title.trim() === ""} className="gap-1.5">
            <Copy className="w-4 h-4" />
            {copying ? "Copying…" : "Copy job"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
