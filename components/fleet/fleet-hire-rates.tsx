"use client";

import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Construction } from "lucide-react";
import { fleetHireOverview, type FleetHireMachineInput } from "@/lib/fleet-hire-overview";
import type { HireOptionRow } from "@/components/fleet/equipment-hire-dialog";

// Fleet → Hire rates (office/admin): every machine Day Works lists, with its
// hire rates or an amber "No hire rate yet", unpriced first. A machine with no
// rate shows greyed out in the job's Day Works picker until it is set up here.

export function FleetHireRates({
  equipment,
  hireOptions,
  onEdit,
}: {
  equipment: FleetHireMachineInput[];
  hireOptions: HireOptionRow[];
  onEdit: (machine: { id: string; name: string }) => void;
}) {
  const { rows, missing } = useMemo(() => fleetHireOverview(equipment, hireOptions), [equipment, hireOptions]);

  return (
    <Card id="hire-rates">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Hire rates</CardTitle>
        <p className="text-sm text-slate-500">
          Day Works rates per machine, ex GST. Operator labour is costed separately.{" "}
          {rows.length === 0 ? (
            "No active machines in the register."
          ) : missing > 0 ? (
            <span className="font-medium text-amber-700">
              {missing === 1 ? "1 machine has" : `${missing} machines have`} no hire rate yet — {missing === 1 ? "it can't" : "they can't"} be picked in Day Works.
            </span>
          ) : (
            <span className="text-green-700">Every machine has a hire rate.</span>
          )}
        </p>
      </CardHeader>
      {rows.length > 0 && (
        <CardContent className="p-0">
          <div className="divide-y">
            {rows.map((r) => (
              <div key={r.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900 break-words">{r.name}</p>
                  {r.hasRate ? null : (
                    <span className="mt-1 inline-block rounded bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-800">No hire rate yet</span>
                  )}
                  {r.options.length > 0 && (
                    <ul className="mt-1 space-y-0.5">
                      {r.options.map((o, i) => (
                        <li key={i} className={`text-xs ${o.active ? "text-slate-600" : "text-slate-400"}`}>
                          {o.label}: {o.rateText}
                          {!o.active && " (switched off)"}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <Button
                  variant={r.hasRate ? "ghost" : "outline"}
                  size="sm"
                  className="h-7 shrink-0 gap-1 self-start text-xs sm:self-center"
                  onClick={() => onEdit({ id: r.id, name: r.name })}
                >
                  <Construction className="h-3 w-3" />
                  {r.hasRate ? "Edit" : "Set up"}
                </Button>
              </div>
            ))}
          </div>
        </CardContent>
      )}
    </Card>
  );
}
