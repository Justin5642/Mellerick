import { ACTIVE_POLL_MS, IDLE_POLL_MS, nextPollDelay } from "./syncStatusCadence";

describe("sync badge polling cadence", () => {
  it("polls quickly while anything is pending, retrying or in flight", () => {
    expect(nextPollDelay({ pending: 1, failed: 0 })).toBe(ACTIVE_POLL_MS);
    expect(nextPollDelay({ pending: 3, failed: 2 })).toBe(ACTIVE_POLL_MS);
  });

  it("drops to the slow heartbeat when the queue is empty", () => {
    expect(nextPollDelay({ pending: 0, failed: 0 })).toBe(IDLE_POLL_MS);
  });

  it("uses the heartbeat for dead-only queues — they change only via Retry, which emits an event", () => {
    expect(nextPollDelay({ pending: 0, failed: 4 })).toBe(IDLE_POLL_MS);
  });

  it("retries soon after a failed or first read", () => {
    expect(nextPollDelay(null)).toBe(ACTIVE_POLL_MS);
  });

  it("is genuinely slower when idle (the point of the change)", () => {
    expect(IDLE_POLL_MS).toBeGreaterThanOrEqual(10 * ACTIVE_POLL_MS);
  });
});
