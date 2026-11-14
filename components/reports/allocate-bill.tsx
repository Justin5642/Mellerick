"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// One row's controls on the Unallocated bills page: a job number + Assign, or
// Overhead. The server resolves the job number and says if there is no such job.
export function AllocateBill({ billId }: { billId: string }) {
  const router = useRouter();
  const [jobNumber, setJobNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(body: { kind: "job"; jobNumber: number } | { kind: "overhead" }) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/xero/bills/${encodeURIComponent(billId)}/allocate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        setError(j?.error ?? "Could not save that");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not save that — check your connection");
    } finally {
      setBusy(false);
    }
  }

  const n = Number(jobNumber);
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <Input
          value={jobNumber}
          onChange={(e) => setJobNumber(e.target.value.replace(/\D/g, ""))}
          inputMode="numeric"
          placeholder="Job #"
          aria-label="Job number"
          className="w-24 h-8"
        />
        <Button size="sm" disabled={busy || !Number.isInteger(n) || n <= 0} onClick={() => save({ kind: "job", jobNumber: n })}>
          Assign
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => save({ kind: "overhead" })}>
          Overhead
        </Button>
      </div>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
