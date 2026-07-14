"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";

export function XeroInvoiceSyncButton() {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);

  async function handleSync() {
    setSyncing(true);
    try {
      const res = await fetch("/api/xero/sync-now", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Sync failed");
        return;
      }
      if (data.skipped) {
        toast.error(data.reason ?? "Xero not connected");
      } else {
        const parts = [];
        if (data.markedPaid) parts.push(`${data.markedPaid} invoice${data.markedPaid === 1 ? "" : "s"} marked paid`);
        if (data.markedOverdue) parts.push(`${data.markedOverdue} marked overdue`);
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
