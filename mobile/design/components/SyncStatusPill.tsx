import { useSyncStatus } from "../../lib/data/useSyncStatus";
import { SyncStatusPillView } from "./SyncStatusPillView";

// Connected pill: wires the outbox counts + retry into the pure view.
export function SyncStatusPill() {
  const { pending, failed, retry } = useSyncStatus();
  return <SyncStatusPillView pending={pending} failed={failed} onRetry={retry} />;
}
