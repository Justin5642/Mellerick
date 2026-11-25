"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";
import { formatDate } from "@/lib/date";
import { causeLabel, mistakeStatusLabel, myMistakeSummary } from "@/lib/mistake-raise";
import type { CrewMistakeState } from "@/lib/mistakes-crew";
import { LogMistakeDialog } from "./log-mistake-dialog";

// The crew's Mistakes card on the job's Overview (technicians on a job
// they're on): "Log mistake", and the mistakes they raised here with their
// status. No money anywhere — the office costs them.

export function CrewMistakes({ jobId }: { jobId: string }) {
  const [state, setState] = useState<CrewMistakeState | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    void fetch(`/api/jobs/${jobId}/mistakes`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        setState((await res.json()) as CrewMistakeState);
        setError(false);
      })
      .catch(() => setError(true));
  }, [jobId]);
  useEffect(load, [load]);

  if (state && !state.ready) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4 text-amber-500" /> Mistakes
          </CardTitle>
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Log mistake
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {error && <p className="text-sm text-red-600">Couldn&apos;t load your mistakes on this job.</p>}
        {state && state.mistakes.length === 0 && (
          <p className="text-sm text-slate-500">Something gone wrong — wrong material, damage, rework, a callback? Log it so the office can sort it out.</p>
        )}
        {state?.mistakes.map((m) => (
          <div key={m.id} className="rounded border border-slate-200 px-3 py-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-slate-800">{myMistakeSummary(m)}</span>
              <span className="text-xs text-slate-500">
                {formatDate(m.occurredOn, { day: "numeric", month: "short" })} · {mistakeStatusLabel(m.status)}
              </span>
            </div>
            <p className="text-slate-700 whitespace-pre-wrap">{m.description}</p>
            <p className="text-xs text-slate-500">
              {[causeLabel(m.causeCode), m.photoCount ? `${m.photoCount} photo${m.photoCount === 1 ? "" : "s"}` : null, m.reworkEntryIds.length ? `${m.reworkEntryIds.length} time entr${m.reworkEntryIds.length === 1 ? "y" : "ies"} marked as rework` : null]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
        ))}
      </CardContent>
      <LogMistakeDialog jobId={jobId} open={open} onOpenChange={setOpen} onSaved={setState} />
    </Card>
  );
}
