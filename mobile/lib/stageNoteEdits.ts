// Stage-note edit/delete rules for the phone's Notes tab. Pure: tested in
// stageNoteEdits.test.ts.

/**
 * Who sees the pencil and bin on a stage note. Same rule as the web
 * (components/job/job-notes.tsx) and as RLS on job_stage_notes (0074): your
 * own notes, or every note for office/admin — and never on a view-only job.
 * The database still decides; this only hides controls that would be refused.
 */
export function canChangeStageNote(
  note: { author_id?: string | null },
  viewer: { currentUserId: string | null | undefined; isOfficeOrAdmin: boolean; readOnly: boolean }
): boolean {
  if (viewer.readOnly) return false;
  if (viewer.isOfficeOrAdmin) return true;
  return !!viewer.currentUserId && note.author_id === viewer.currentUserId;
}

/** The edited text to save, or null with the reason it can't be saved. */
export function validateStageNoteEdit(text: string): { content: string } | { error: string } {
  const content = text.trim();
  if (!content) return { error: "A note can't be empty — delete it instead." };
  return { content };
}

/**
 * Merge a fresh server read of stage notes with what the screen shows, so an
 * edit or delete still waiting in the outbox is not undone by a reload:
 *
 *  - a row whose write is pending keeps the LOCAL version (the queued edit,
 *    or the optimistic insert);
 *  - a row this screen deleted (`removed`) stays hidden while its delete is
 *    pending; once the delete is done the server no longer has it, and if it
 *    was refused (dead-lettered, so no longer pending) the row comes back;
 *  - a pending row the screen doesn't hold (queued on an earlier visit) shows
 *    the server's version rather than disappearing.
 *
 * Optimistic rows absent from the server lead, as in reconcileRows.
 */
export function mergeStageNotes<T extends { id: string }>(
  local: T[],
  server: T[],
  pendingIds: Set<string>,
  removed: Set<string>
): T[] {
  const localById = new Map(local.map((r) => [r.id, r]));
  const serverIds = new Set(server.map((r) => r.id));
  const keptOptimistic = local.filter((r) => !serverIds.has(r.id) && pendingIds.has(r.id) && !removed.has(r.id));
  const fromServer: T[] = [];
  for (const row of server) {
    if (!pendingIds.has(row.id)) {
      fromServer.push(row);
      continue;
    }
    if (removed.has(row.id)) continue;
    fromServer.push(localById.get(row.id) ?? row);
  }
  return [...keptOptimistic, ...fromServer];
}
