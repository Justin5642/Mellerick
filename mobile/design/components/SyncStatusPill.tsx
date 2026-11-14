import { useState } from "react";
import { useSyncStatus } from "../../lib/data/useSyncStatus";
import { SyncStatusPillView } from "./SyncStatusPillView";
import { UnsyncedSheet } from "./UnsyncedSheet";

// Connected pill: wires the outbox counts into the pure view. Tapping the red
// "not synced" state opens the list of what didn't sync and why.
export function SyncStatusPill() {
  const status = useSyncStatus();
  const [open, setOpen] = useState(false);
  return (
    <>
      <SyncStatusPillView pending={status.pending} failed={status.failed} onPress={() => setOpen(true)} />
      {open && <UnsyncedSheet status={status} onClose={() => setOpen(false)} />}
    </>
  );
}
