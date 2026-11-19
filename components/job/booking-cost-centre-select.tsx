"use client";

import { useState } from "react";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  addableCostCentres,
  costCentreChoiceValue,
  lineLabel,
  parseCostCentreChoice,
  PICK_COST_CENTRE,
  type BookingLineOption,
  type CompanyCostCentreOption,
} from "@/lib/booking-cost-centre";
import { addCostCentreToJob } from "@/lib/booking-cost-centre-client";
import { cn } from "@/lib/utils";

interface Props {
  jobId: string;
  /** The booking's PO line, or null when none is picked yet. */
  value: string | null;
  /** The job's PO lines. */
  lines: BookingLineOption[];
  /** The company's cost centres; the ones the job has no line for are offered under "Add to this job". */
  company: CompanyCostCentreOption[];
  onChange: (lineId: string) => void;
  /** A company cost centre was added to the job as a $0 line (now in the job's lines). */
  onLineAdded?: (line: Required<BookingLineOption>) => void;
  /** Show "Pick a cost centre" in red under the picker when nothing is picked. */
  showProblem?: boolean;
  disabled?: boolean;
  id?: string;
}

/**
 * A booking's cost centre — required (19 Nov 2026). Lists the job's PO lines,
 * then the company cost centres the job doesn't have yet; picking one of
 * those adds it to the job as a $0 line on the spot (the office user's own
 * write, through /api/jobs/[id]/booking-cost-centre) and picks it. Names
 * only — never an amount.
 */
export function BookingCostCentreSelect({ jobId, value, lines, company, onChange, onLineAdded, showProblem, disabled, id }: Props) {
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const addable = addableCostCentres(lines, company);
  const known = value ? lines.some((l) => l.id === value) : false;

  async function pick(raw: unknown) {
    const choice = parseCostCentreChoice(typeof raw === "string" ? raw : null);
    if (!choice) return;
    setError(null);
    if (choice.kind === "line") {
      onChange(choice.id);
      return;
    }
    const centre = company.find((c) => c.id === choice.costCentreId);
    setAdding(centre?.name ?? "the cost centre");
    const result = await addCostCentreToJob(jobId, choice.costCentreId);
    setAdding(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onLineAdded?.(result.line);
    onChange(result.line.id);
  }

  return (
    <div className="space-y-1">
      <Select value={value && known ? costCentreChoiceValue({ kind: "line", id: value }) : null} onValueChange={(v) => void pick(v)} disabled={disabled || !!adding}>
        <SelectTrigger id={id} className={cn(showProblem && !value && "border-red-400")}>
          <SelectValue placeholder={adding ? `Adding ${adding}…` : value && !known ? "This booking's cost centre" : PICK_COST_CENTRE} />
        </SelectTrigger>
        <SelectContent>
          {lines.length > 0 && (
            <SelectGroup>
              <SelectLabel>This job</SelectLabel>
              {lines.map((l) => (
                <SelectItem key={l.id} value={costCentreChoiceValue({ kind: "line", id: l.id })}>
                  {lineLabel(l)}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {addable.length > 0 && (
            <SelectGroup>
              <SelectLabel>Add to this job</SelectLabel>
              {addable.map((c) => (
                <SelectItem key={c.id} value={costCentreChoiceValue({ kind: "add", costCentreId: c.id })}>
                  + {c.name}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {lines.length === 0 && addable.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-slate-500">No cost centres yet — add them in Settings → Cost Centres.</p>
          )}
        </SelectContent>
      </Select>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {!error && showProblem && !value && <p className="text-xs font-medium text-red-600">{PICK_COST_CENTRE}</p>}
    </div>
  );
}
