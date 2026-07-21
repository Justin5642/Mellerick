import type { Operation, OpStatus } from "./types";

// Persistence seam for the outbox. The real implementation is SQLite
// (expo-sqlite); tests use the in-memory implementation below. Keeping this an
// interface is what lets the queue logic (outbox.ts) be unit-tested with no
// native modules.
export interface OutboxStore {
  insert(op: Operation): Promise<void>;
  update(id: string, patch: Partial<Operation>): Promise<void>;
  all(): Promise<Operation[]>;
  findByCoalesceKey(key: string): Promise<Operation | undefined>;
  countByStatus(status: OpStatus): Promise<number>;
}

// In-memory store for unit tests and previewing. Ordered by insertion.
export class InMemoryOutboxStore implements OutboxStore {
  private ops: Operation[] = [];

  async insert(op: Operation): Promise<void> {
    this.ops.push({ ...op });
  }

  async update(id: string, patch: Partial<Operation>): Promise<void> {
    const i = this.ops.findIndex((o) => o.id === id);
    if (i >= 0) this.ops[i] = { ...this.ops[i], ...patch } as Operation;
  }

  async all(): Promise<Operation[]> {
    return this.ops.map((o) => ({ ...o }));
  }

  async findByCoalesceKey(key: string): Promise<Operation | undefined> {
    const found = this.ops.find(
      (o) => o.kind === "side_effect" && o.coalesceKey === key && o.status !== "done"
    );
    return found ? { ...found } : undefined;
  }

  async countByStatus(status: OpStatus): Promise<number> {
    return this.ops.filter((o) => o.status === status).length;
  }
}
