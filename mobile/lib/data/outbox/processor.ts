import type { Outbox } from "./outbox";
import type { Operation, WriteOperation } from "./types";
import type { SupabaseGateway, ApiBridge } from "../gateway";
import type { Connectivity } from "../net/connectivity";

// Drains the outbox when online. It is the ONLY code that performs mutating
// network calls — components enqueue, the processor replays. Replay is
// idempotent (upsert on the client id; deletes tolerate 404), so a retry after
// a flaky network can never duplicate a row. Failures are backed off, not
// dropped. Serialized (one drain at a time) so intra-device ordering holds.
export class Processor {
  private draining = false;

  constructor(
    private outbox: Outbox,
    private gateway: SupabaseGateway,
    private api: ApiBridge,
    private connectivity: Connectivity
  ) {}

  // Process ready operations oldest-first until none remain (or offline).
  // Each failed op is backed off so it won't be re-selected in this pass,
  // guaranteeing termination.
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      if (!(await this.connectivity.isOnline())) return;
      let op: Operation | undefined;
      while ((op = await this.outbox.nextReady())) {
        await this.outbox.markInflight(op.id);
        try {
          await this.dispatch(op);
          await this.outbox.markDone(op.id);
        } catch (err) {
          await this.outbox.markFailed(op, err instanceof Error ? err.message : String(err));
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async dispatch(op: Operation): Promise<void> {
    if (op.kind === "side_effect") {
      await this.api.callSideEffect(op.effect, op.payload);
      return;
    }
    await this.dispatchWrite(op);
  }

  private async dispatchWrite(op: WriteOperation): Promise<void> {
    // Attachment first: upload the local file, then write the metadata row, so
    // the row only ever references an object that exists in Storage.
    if (op.attachmentLocalPath) {
      const bucket = (op.payload.bucket as string) ?? "job-photos";
      const path = op.payload.storage_path as string;
      await this.gateway.uploadObject(bucket, path, op.attachmentLocalPath);
    }
    switch (op.op) {
      case "insert":
        // rowId is the client-generated PK → idempotent upsert on replay.
        await this.gateway.upsertRow(op.table, { id: op.rowId, ...stripInternal(op.payload) });
        break;
      case "update":
        await this.gateway.updateRow(op.table, op.rowId, stripInternal(op.payload));
        break;
      case "delete":
        // Remove the associated Storage object first (photos carry storage_path),
        // then the row — mirrors the web delete order; both are idempotent.
        if (op.payload.storage_path) {
          const bucket = (op.payload.bucket as string) ?? "job-photos";
          await this.gateway.removeObject(bucket, op.payload.storage_path as string);
        }
        await this.gateway.deleteRow(op.table, op.rowId);
        break;
    }
    // The row is now durable server-side; drop the queued local attachment so the
    // outbox attachment dir doesn't grow without bound. Only reached on success —
    // a failure throws above and the file is kept for the retry. Never throws.
    if (op.attachmentLocalPath) {
      await this.gateway.cleanupAttachment(op.attachmentLocalPath);
    }
  }
}

// Drop the transport-only keys we stash in the payload for attachments.
function stripInternal(payload: Record<string, unknown>): Record<string, unknown> {
  const { bucket: _b, ...rest } = payload;
  void _b;
  return rest;
}
