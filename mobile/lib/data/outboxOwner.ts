// Who the outbox is working for: the signed-in user's id, or null.
//
// A module-level value rather than React state because the outbox reads it
// synchronously on every enqueue and selection, from code with no React tree
// (the repositories, the processor). AuthProvider keeps it current; the
// headless background-sync task builds its layer with the session it just
// read instead. See WriteOperation.userId for why ownership exists.

let current: string | null = null;
const listeners = new Set<() => void>();

export function getOutboxOwner(): string | null {
  return current;
}

export function setOutboxOwner(userId: string | null): void {
  if (userId === current) return;
  current = userId;
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch {
      // A listener must never break sign-in.
    }
  }
}

/** Told when the owner changes — DataProvider drains the new owner's queue. */
export function onOutboxOwnerChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
