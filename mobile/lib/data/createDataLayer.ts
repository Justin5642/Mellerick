import { Outbox, systemClock, type Clock } from "./outbox/outbox";
import { Processor } from "./outbox/processor";
import type { OutboxStore } from "./outbox/store";
import type { Operation } from "./outbox/types";
import type { SupabaseGateway, ApiBridge } from "./gateway";
import type { Connectivity } from "./net/connectivity";
import { SyncEngine } from "./syncEngine";
import { cryptoIdGen, type IdGen } from "./ids";
import { TimeEntriesRepository } from "./repositories/timeEntries";
import { JobPhotosRepository } from "./repositories/jobPhotos";
import { JobNotesRepository } from "./repositories/jobNotes";
import { JobStageNotesRepository } from "./repositories/jobStageNotes";
import { SignatureRepository } from "./repositories/signature";
import { VoiceReportRepository } from "./repositories/voiceReport";
import { FinanceRepository } from "./repositories/finance";
import { CustomersRepository } from "./repositories/customers";
import { InventoryRepository } from "./repositories/inventory";
import { EquipmentRepository } from "./repositories/fleet";
import { JobBillingRepository } from "./repositories/jobBilling";
import { ApprovalsRepository } from "./repositories/approvals";
import { ScheduleRepository } from "./repositories/schedule";
import { JobsRepository } from "./repositories/jobs";
import { BackflowRepository } from "./repositories/backflow";
import { SettingsRepository } from "./repositories/settings";
import { VariationsRepository } from "./repositories/variations";

// The wired offline stack a screen consumes: repositories for writes, the sync
// engine to drive them out, and the outbox for the pending/failed badge.
export interface DataLayer {
  outbox: Outbox;
  engine: SyncEngine;
  timeEntries: TimeEntriesRepository;
  photos: JobPhotosRepository;
  notes: JobNotesRepository;
  stageNotes: JobStageNotesRepository;
  signature: SignatureRepository;
  voiceReport: VoiceReportRepository;
  finance: FinanceRepository;
  customers: CustomersRepository;
  inventory: InventoryRepository;
  equipment: EquipmentRepository;
  jobBilling: JobBillingRepository;
  approvals: ApprovalsRepository;
  schedule: ScheduleRepository;
  jobs: JobsRepository;
  backflow: BackflowRepository;
  settings: SettingsRepository;
  variations: VariationsRepository;
  /**
   * Discard `userId`'s queued work and every staged attachment no remaining
   * operation needs. For a sign-out the user has CONFIRMED (lib/signOutFlow.ts)
   * — stop the engine first.
   */
  clearLocalWorkFor(userId: string): Promise<void>;
}

export interface DataLayerDeps {
  store: OutboxStore;
  gateway: SupabaseGateway;
  api: ApiBridge;
  connectivity: Connectivity;
  ids?: IdGen;
  clock?: Clock;
  /** Refresh the auth session before a drain (Q4) — see SyncEngine. */
  ensureSession?: () => Promise<unknown>;
  /** Where a background drain's failure goes instead of an unhandled rejection. */
  onSyncError?: (error: unknown) => void;
  /** Told when an outbox operation dead-letters — see Outbox. */
  onDeadLetter?: (op: Operation, reason: string) => void;
  /** Who is signed in — stamps and filters queued work. See Outbox. */
  owner?: () => string | null;
  /** AppState 'active' subscription, so returning to the app drains. See SyncEngine. */
  onForeground?: (cb: () => void) => () => void;
}

// Composition root, injectable end-to-end so the whole stack can be integration-
// tested with fakes (no native SQLite/netinfo). DataProvider calls this with the
// real adapters.
export function createDataLayer(deps: DataLayerDeps): DataLayer {
  const outbox = new Outbox(deps.store, deps.clock ?? systemClock, deps.onDeadLetter, deps.owner);
  const processor = new Processor(outbox, deps.gateway, deps.api, deps.connectivity);
  const engine = new SyncEngine(processor, deps.connectivity, deps.ensureSession, deps.onSyncError, deps.onForeground);
  const ids = deps.ids ?? cryptoIdGen;
  const timeEntries = new TimeEntriesRepository(outbox, ids);
  const photos = new JobPhotosRepository(outbox, ids);
  const notes = new JobNotesRepository(outbox, ids);
  const stageNotes = new JobStageNotesRepository(outbox, ids);
  const signature = new SignatureRepository(outbox, ids);
  const voiceReport = new VoiceReportRepository(outbox, ids);
  const finance = new FinanceRepository(outbox, ids);
  const customers = new CustomersRepository(outbox, ids);
  const inventory = new InventoryRepository(outbox, ids);
  const equipment = new EquipmentRepository(outbox, ids);
  const jobBilling = new JobBillingRepository(outbox, ids);
  const approvals = new ApprovalsRepository(outbox, ids, finance);
  const schedule = new ScheduleRepository(outbox, ids);
  const jobs = new JobsRepository(outbox, ids);
  const backflow = new BackflowRepository(outbox, ids);
  const settings = new SettingsRepository(outbox, ids);
  const variations = new VariationsRepository(outbox, ids);
  async function clearLocalWorkFor(userId: string): Promise<void> {
    await outbox.clearForOwner(userId);
    // No grace period, unlike the drain's orphan sweep: nothing is being
    // enqueued during a sign-out, so every unreferenced file is garbage — and
    // these are job photos, receipts and signatures that must not outlive the
    // session. Another user's queued attachments are still referenced and kept.
    const [staged, referenced] = await Promise.all([deps.gateway.listStagedAttachments(), outbox.referencedAttachmentUris()]);
    for (const file of staged) {
      if (!referenced.has(file.uri)) await deps.gateway.cleanupAttachment(file.uri); // never throws
    }
  }
  return { clearLocalWorkFor, outbox, engine, timeEntries, photos, notes, stageNotes, signature, voiceReport, finance, customers, inventory, equipment, jobBilling, approvals, schedule, jobs, backflow, settings, variations };
}
