"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";

export function GoogleCalendarSyncButton() {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);

  async function handleSync() {
    setSyncing(true);
    try {
      const res = await fetch("/api/google/sync-now", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Sync failed");
        return;
      }
      if (data.resyncRequired) {
        toast.info("Calendar sync token expired — resyncing from now on next run.");
      } else if (data.skipped) {
        toast.error(data.reason ?? "Google Calendar not connected");
      } else {
        const parts = [];
        if (data.updated) parts.push(`${data.updated} job${data.updated === 1 ? "" : "s"} updated`);
        if (data.clearedByDeletion) parts.push(`${data.clearedByDeletion} schedule${data.clearedByDeletion === 1 ? "" : "s"} cleared (event deleted)`);
        toast.success(parts.length ? parts.join(", ") : "Already up to date");
        router.refresh();
      }
    } catch {
      toast.error("Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <Button variant="outline" size="sm" className="gap-2" onClick={handleSync} disabled={syncing}>
      <RefreshCw className={`w-3.5 h-3.5 ${syncing ? "animate-spin" : ""}`} />
      {syncing ? "Syncing..." : "Sync now"}
    </Button>
  );
}
