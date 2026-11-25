import { useCallback } from "react";
import { useDataLayer } from "../DataProvider";
import { useFlush } from "./useFlush";
import { persistOutboxAttachment } from "../attachments";
import type { ManualEntryInput, EditEntryInput } from "../repositories/timeEntries";
import type { ClockFix } from "../../clockFix";

// Write-side hook for time tracking. Every action enqueues a durable outbox
// operation (works offline) and then flushes — draining immediately when online,
// a harmless no-op when offline. Each action resolves to whether the flush
// actually synced, so the screen knows whether to refresh from the server
// (online) or keep its optimistic local state (offline).

/**
 * A variation raised from the clock-on picker ("+ New variation (e.g. hit
 * rock)", 0120 — draft). Logged exactly as the Variations tab logs a custom
 * one — no rate, no amount, priced by the office — then the time goes against
 * it. The clock-on waits for the variation's insert (time_entries.variation_id
 * references it).
 */
export interface NewVariationArgs {
  customName: string;
  description: string | null;
  loggedBy: string;
  photo?: { sourceUri: string; ext?: string } | null;
}

export interface TimeClock {
  ready: boolean;
  clockIn(input: {
    jobId: string;
    staffId: string;
    costCenterId?: string | null;
    fix?: ClockFix | null;
    id?: string;
    /** Time against this variation (0120, draft). */
    variationId?: string | null;
    /** …or against a variation raised now. */
    newVariation?: NewVariationArgs | null;
  }): Promise<{ id: string; variationId: string | null; synced: boolean }>;
  clockOut(input: { entryId: string; clockInIso: string; fix?: ClockFix | null }): Promise<{ synced: boolean }>;
  /**
   * While clocked on: end the open entry and start one on `variationId` (null =
   * back to the stage) — or on a variation raised now — at the same instant.
   */
  switchClock(input: {
    open: { id: string; jobId: string; staffId: string; clockInIso: string };
    atIso: string;
    costCenterId: string | null;
    variationId: string | null;
    newVariation?: NewVariationArgs | null;
    fix?: ClockFix | null;
  }): Promise<{ id: string; variationId: string | null; synced: boolean }>;
  /** Move an entry onto a variation, or back to the stage (null). */
  setVariation(entryId: string, variationId: string | null): Promise<{ synced: boolean }>;
  addManual(input: ManualEntryInput): Promise<{ id: string; synced: boolean }>;
  editEntry(input: EditEntryInput): Promise<{ synced: boolean }>;
  assignCostCenter(entryId: string, costCenterId: string | null): Promise<{ synced: boolean }>;
  remove(entryId: string, jobId?: string): Promise<{ synced: boolean }>;
}

export function useTimeClock(): TimeClock {
  const layer = useDataLayer();
  const flush = useFlush();

  /** Queue a new custom variation; resolves to its id and its insert's op id. */
  const queueVariation = useCallback(
    async (jobId: string, v: NewVariationArgs, dependsOn: string | null) => {
      if (!layer) throw new Error("Data layer not ready");
      const photo = v.photo ? { localUri: await persistOutboxAttachment(v.photo.sourceUri, v.photo.ext ?? "jpg"), ext: v.photo.ext } : null;
      return layer.variations.submitVariation({
        jobId,
        variationTypeId: null,
        customName: v.customName.trim(),
        description: v.description?.trim() || null,
        quantity: 1,
        unit: "unit",
        loggedBy: v.loggedBy,
        photo,
        dependsOn,
      });
    },
    [layer]
  );

  const clockIn = useCallback<TimeClock["clockIn"]>(async (input) => {
    if (!layer) throw new Error("Data layer not ready");
    let variationId = input.variationId ?? null;
    let dependsOn: string | null = null;
    if (input.newVariation) {
      const created = await queueVariation(input.jobId, input.newVariation, null);
      variationId = created.id;
      dependsOn = created.opId;
    }
    const id = await layer.timeEntries.clockIn({
      jobId: input.jobId,
      staffId: input.staffId,
      costCenterId: input.costCenterId,
      fix: input.fix,
      id: input.id,
      variationId,
      dependsOn,
    });
    return { id, variationId, synced: await flush() };
  }, [layer, flush, queueVariation]);

  const clockOut = useCallback<TimeClock["clockOut"]>(async (input) => {
    if (!layer) throw new Error("Data layer not ready");
    await layer.timeEntries.clockOut(input);
    return { synced: await flush() };
  }, [layer, flush]);

  const switchClock = useCallback<TimeClock["switchClock"]>(async (input) => {
    if (!layer) throw new Error("Data layer not ready");
    if (!input.newVariation) {
      const id = await layer.timeEntries.switchClock({
        open: input.open,
        atIso: input.atIso,
        costCenterId: input.costCenterId,
        variationId: input.variationId,
        fix: input.fix,
      });
      return { id, variationId: input.variationId, synced: await flush() };
    }
    // A new variation: clock off → the variation (waits for the clock-off) →
    // the clock-on (waits for the variation), so the one-open-entry rule
    // (0090) and the variation's foreign key are both met in order.
    const offOp = await layer.timeEntries.clockOutOp({ entryId: input.open.id, clockInIso: input.open.clockInIso, fix: input.fix, atIso: input.atIso });
    const created = await queueVariation(input.open.jobId, input.newVariation, offOp);
    const id = await layer.timeEntries.clockIn({
      jobId: input.open.jobId,
      staffId: input.open.staffId,
      costCenterId: input.costCenterId,
      fix: input.fix,
      atIso: input.atIso,
      variationId: created.id,
      dependsOn: created.opId,
    });
    return { id, variationId: created.id, synced: await flush() };
  }, [layer, flush, queueVariation]);

  const setVariation = useCallback<TimeClock["setVariation"]>(async (entryId, variationId) => {
    if (!layer) throw new Error("Data layer not ready");
    await layer.timeEntries.setVariation(entryId, variationId);
    return { synced: await flush() };
  }, [layer, flush]);

  const addManual = useCallback<TimeClock["addManual"]>(async (input) => {
    if (!layer) throw new Error("Data layer not ready");
    const id = await layer.timeEntries.addManual(input);
    return { id, synced: await flush() };
  }, [layer, flush]);

  const editEntry = useCallback<TimeClock["editEntry"]>(async (input) => {
    if (!layer) throw new Error("Data layer not ready");
    await layer.timeEntries.editEntry(input);
    return { synced: await flush() };
  }, [layer, flush]);

  const assignCostCenter = useCallback<TimeClock["assignCostCenter"]>(async (entryId, costCenterId) => {
    if (!layer) throw new Error("Data layer not ready");
    await layer.timeEntries.assignCostCenter(entryId, costCenterId);
    return { synced: await flush() };
  }, [layer, flush]);

  const remove = useCallback<TimeClock["remove"]>(async (entryId, jobId) => {
    if (!layer) throw new Error("Data layer not ready");
    await layer.timeEntries.remove(entryId, jobId);
    return { synced: await flush() };
  }, [layer, flush]);

  return { ready: !!layer, clockIn, clockOut, switchClock, setVariation, addManual, editEntry, assignCostCenter, remove };
}
