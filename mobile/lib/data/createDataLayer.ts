import { Outbox, systemClock, type Clock } from "./outbox/outbox";
import { Processor } from "./outbox/processor";
import type { OutboxStore } from "./outbox/store";
import type { SupabaseGateway, ApiBridge } from "./gateway";
import type { Connectivity } from "./net/connectivity";
import { SyncEngine } from "./syncEngine";
import { cryptoIdGen, type IdGen } from "./ids";
import { TimeEntriesRepository } from "./repositories/timeEntries";
import { JobPhotosRepository } from "./repositories/jobPhotos";
import { JobNotesRepository } from "./repositories/jobNotes";
import { SignatureRepository } from "./repositories/signature";
import { VoiceReportRepository } from "./repositories/voiceReport";

// The wired offline stack a screen consumes: repositories for writes, the sync
// engine to drive them out, and the outbox for the pending/failed badge.
export interface DataLayer {
  outbox: Outbox;
  engine: SyncEngine;
  timeEntries: TimeEntriesRepository;
  photos: JobPhotosRepository;
  notes: JobNotesRepository;
  signature: SignatureRepository;
  voiceReport: VoiceReportRepository;
}

export interface DataLayerDeps {
  store: OutboxStore;
  gateway: SupabaseGateway;
  api: ApiBridge;
  connectivity: Connectivity;
  ids?: IdGen;
  clock?: Clock;
}

// Composition root, injectable end-to-end so the whole stack can be integration-
// tested with fakes (no native SQLite/netinfo). DataProvider calls this with the
// real adapters.
export function createDataLayer(deps: DataLayerDeps): DataLayer {
  const outbox = new Outbox(deps.store, deps.clock ?? systemClock);
  const processor = new Processor(outbox, deps.gateway, deps.api, deps.connectivity);
  const engine = new SyncEngine(processor, deps.connectivity);
  const ids = deps.ids ?? cryptoIdGen;
  const timeEntries = new TimeEntriesRepository(outbox, ids);
  const photos = new JobPhotosRepository(outbox, ids);
  const notes = new JobNotesRepository(outbox, ids);
  const signature = new SignatureRepository(outbox, ids);
  const voiceReport = new VoiceReportRepository(outbox, ids);
  return { outbox, engine, timeEntries, photos, notes, signature, voiceReport };
}
