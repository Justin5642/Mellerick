"use client";

import { useState } from "react";
import { MistakesPanel, LogJoblessMistake, type PanelStaff } from "./mistakes-panel";

// Reports → Mistakes: the office's review of every mistake not yet closed —
// the crew's, the office's and those with no job — to cost, link, recover and
// close (0119, a draft not applied yet). Office/admin; the page checks the role, RLS decides the rows.

export function MistakesReview({ staff, isAdmin }: { staff: PanelStaff[]; isAdmin: boolean }) {
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <div className="space-y-3">
      <LogJoblessMistake onSaved={() => setReloadKey((k) => k + 1)} />
      <MistakesPanel staff={staff} isAdmin={isAdmin} reloadKey={reloadKey} emptyText="Nothing to review — every mistake is closed." />
    </div>
  );
}
