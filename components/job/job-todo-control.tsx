"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ListPlus, X } from "lucide-react";
import { formatHours, isTodoListable, MAX_ESTIMATED_HOURS, parseEstimatedHours, todoHours } from "@/lib/todo-list";

interface Props {
  jobId: string;
  currentUserId: string;
  status: string;
  todoListedAt: string | null;
  estimatedHours: number | string | null;
  // Office/admin only — sum of purchase_orders.total_hours. Hours, never value.
  poAllocatedHours: number;
}

// Office/admin header control for the to-do list: jobs office has set aside
// to drop into a schedule gap (see the To-do tab on /dashboard/schedule).
// Listing is manual; leaving is automatic — a database trigger clears
// todo_listed_at once the job is scheduled, so there is no "scheduled but
// still listed" state for this control to reconcile.
export function JobTodoControl({ jobId, currentUserId, status, todoListedAt, estimatedHours, poAllocatedHours }: Props) {
  const router = useRouter();
  const supabase = createClient();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [hoursInput, setHoursInput] = useState("");

  const current = todoHours(estimatedHours, poAllocatedHours);

  function openDialog() {
    // Prefill: the job's own estimate, else the PO allocation as a starting point.
    setHoursInput(current.hours !== null ? String(current.hours) : "");
    setOpen(true);
  }

  async function addToList() {
    const parsed = parseEstimatedHours(hoursInput);
    if (parsed === "invalid") {
      toast.error(`Estimated hours must be a number from 0 to ${MAX_ESTIMATED_HOURS}`);
      return;
    }
    setSaving(true);
    // count: "exact" so an RLS refusal (0 rows, no error) isn't reported as
    // success. The trigger re-stamps todo_listed_at with the database clock and
    // todo_listed_by with the caller's id; the values sent here only say "list it".
    const { data, error, count } = await supabase
      .from("jobs")
      .update(
        { todo_listed_at: new Date().toISOString(), todo_listed_by: currentUserId, estimated_hours: parsed },
        { count: "exact" }
      )
      .eq("id", jobId)
      .select("todo_listed_at");
    setSaving(false);
    if (error || count === 0) {
      toast.error(error?.message ?? "Couldn't add the job to the to-do list");
      return;
    }
    // The trigger refuses to list a job that is already scheduled/in progress/
    // closed; the write "succeeds" but the flag comes back null.
    if (!data?.[0]?.todo_listed_at) {
      toast.error("This job is already scheduled, so it can't go on the to-do list");
      router.refresh();
      return;
    }
    toast.success("Added to the to-do list");
    setOpen(false);
    router.refresh();
  }

  async function removeFromList() {
    setSaving(true);
    const { error, count } = await supabase
      .from("jobs")
      .update({ todo_listed_at: null, todo_listed_by: null }, { count: "exact" })
      .eq("id", jobId);
    setSaving(false);
    if (error || count === 0) {
      toast.error(error?.message ?? "Couldn't remove the job from the to-do list");
      return;
    }
    toast.success("Removed from the to-do list");
    router.refresh();
  }

  if (todoListedAt) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium pl-2.5 pr-1 py-0.5 rounded-full bg-indigo-100 text-indigo-700">
        On to-do list{current.hours !== null ? ` · ${formatHours(current.hours)}` : ""}
        <button
          type="button"
          onClick={removeFromList}
          disabled={saving}
          className="ml-0.5 rounded-full p-0.5 hover:bg-indigo-200 disabled:opacity-50"
          title="Remove from to-do list"
          aria-label="Remove from to-do list"
        >
          <X className="w-3 h-3" />
        </button>
      </span>
    );
  }

  if (!isTodoListable(status)) return null;

  return (
    <>
      <Button variant="outline" size="sm" className="gap-1.5" onClick={openDialog}>
        <ListPlus className="w-4 h-4" />
        Add to to-do list
      </Button>
      <Dialog open={open} onOpenChange={(o) => !saving && setOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add to to-do list</DialogTitle>
            <DialogDescription>
              The job shows on the Schedule page&apos;s To-do list until it&apos;s scheduled, then drops off by itself.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="todo-estimated-hours">Estimated hours (optional)</Label>
            <Input
              id="todo-estimated-hours"
              type="number"
              inputMode="decimal"
              min={0}
              max={MAX_ESTIMATED_HOURS}
              step={0.25}
              value={hoursInput}
              onChange={(e) => setHoursInput(e.target.value)}
              placeholder="e.g. 3"
            />
            {current.source === "po" && (
              <p className="text-xs text-slate-500">Prefilled from the PO allocated hours.</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={addToList} disabled={saving}>{saving ? "Adding..." : "Add to list"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
