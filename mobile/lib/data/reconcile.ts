// Merge a fresh server read with the current local rows so an optimistic row
// that hasn't synced yet (still pending in the outbox) is NOT wiped by the
// reload. Server rows are authoritative for anything they contain; a local row
// absent from the server is kept ONLY while its write is still pending — once it
// syncs (server has it) or its op is gone, the server view wins. Optimistic rows
// are the newest, so they lead.
export function reconcileRows<T extends { id: string }>(
  local: T[],
  server: T[],
  pendingIds: Set<string>
): T[] {
  const serverIds = new Set(server.map((r) => r.id));
  const keptOptimistic = local.filter((r) => !serverIds.has(r.id) && pendingIds.has(r.id));
  return [...keptOptimistic, ...server];
}
