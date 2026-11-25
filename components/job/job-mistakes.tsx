"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { MistakesPanel } from "@/components/mistakes/mistakes-panel";
import type { TrackingMode } from "@/lib/mistakes-data";
import { JobMistakes0115 } from "./job-mistakes-0115";
import { LogMistakeDialog } from "./log-mistake-dialog";

// Mistakes on the job's Purchase Orders tab — office and admin (the tab is
// never shown to technicians). Since 0119 (a draft, not applied yet) this is the office's review: what
// the crew logged and what the office logs, each costed by LINKING the costs
// already on the job (no double counting) plus manual lines, with recovery,
// status and — admin only — whose mistake it was (components/mistakes/).
//
// Before 0119 is applied the database has only 0115's one-amount mistakes:
// the 0115 card (job-mistakes-0115.tsx) is shown instead, unchanged.

interface Props {
  jobId: string;
  costCenters: { id: string; name: string; po_number?: string | null }[];
  staff: { id: string; full_name: string | null }[];
  isAdmin: boolean;
}

export function JobMistakes({ jobId, costCenters, staff, isAdmin }: Props) {
  const [mode, setMode] = useState<TrackingMode | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  if (mode === "legacy") return <JobMistakes0115 jobId={jobId} costCenters={costCenters} staff={staff} />;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Mistakes</CardTitle>
            <p className="text-xs text-slate-500 mt-0.5">
              Rework, wrong materials, damage, callbacks, mis-quotes. Link the time, expenses, POs, equipment or Day Works already on the job (counted
              once), add a manual cost only for what has no record, and record any credit back. Office only — technicians don&apos;t see costs.
            </p>
          </div>
          {mode === "tracking" && (
            <Button size="sm" variant="outline" className="gap-1.5 shrink-0" onClick={() => setLogOpen(true)}>
              <Plus className="w-3.5 h-3.5" /> Log mistake
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <MistakesPanel
          jobId={jobId}
          costCenters={costCenters}
          staff={staff}
          isAdmin={isAdmin}
          emptyText="No mistakes logged on this job."
          reloadKey={reloadKey}
          onMode={setMode}
        />
      </CardContent>
      <LogMistakeDialog jobId={jobId} open={logOpen} onOpenChange={setLogOpen} onSaved={() => setReloadKey((k) => k + 1)} />
    </Card>
  );
}
