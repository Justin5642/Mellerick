// A clock shared by repositories. nowMs() feeds outbox ordering (createdAt);
// nowIso() feeds timestamp columns. Injected so repositories are deterministic
// in tests.
export interface TimeSource {
  nowMs(): number;
  nowIso(): string;
}

export const systemTime: TimeSource = {
  nowMs: () => Date.now(),
  nowIso: () => new Date().toISOString(),
};
