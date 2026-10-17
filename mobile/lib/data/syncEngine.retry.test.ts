import { SyncEngine } from "./syncEngine";
import type { Processor } from "./outbox/processor";
import type { Connectivity } from "./net/connectivity";

// A write that failed while ONLINE used to wait for the next reconnect, mutation
// or app start — none of which comes on a good connection. The engine now arms
// a drain for when the backoff ends, and drains when the app is foregrounded.

const connectivity: Connectivity = { isOnline: async () => true, onOnline: () => () => {} };

function fakeProcessor(wait: number | null) {
  return {
    drain: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn(),
    msUntilNextRetry: jest.fn().mockResolvedValue(wait),
  };
}

afterEach(() => jest.useRealTimers());

describe("SyncEngine — retry scheduling", () => {
  it("drains again when the earliest backoff falls due", async () => {
    jest.useFakeTimers();
    const proc = fakeProcessor(8_000);
    const engine = new SyncEngine(proc as unknown as Processor, connectivity);
    engine.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(proc.drain).toHaveBeenCalledTimes(1);
    proc.msUntilNextRetry.mockResolvedValue(null); // the retry succeeds
    await jest.advanceTimersByTimeAsync(7_999);
    expect(proc.drain).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(proc.drain).toHaveBeenCalledTimes(2);
    // Nothing else is backing off: no further drains.
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(proc.drain).toHaveBeenCalledTimes(2);
    engine.stop();
  });

  it("never schedules faster than once a second, so a due-but-blocked op cannot spin", async () => {
    jest.useFakeTimers();
    const proc = fakeProcessor(0);
    const engine = new SyncEngine(proc as unknown as Processor, connectivity);
    engine.start();
    await jest.advanceTimersByTimeAsync(999);
    expect(proc.drain).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(proc.drain).toHaveBeenCalledTimes(2);
    engine.stop();
  });

  it("stop() cancels a pending retry", async () => {
    jest.useFakeTimers();
    const proc = fakeProcessor(5_000);
    const engine = new SyncEngine(proc as unknown as Processor, connectivity);
    engine.start();
    await jest.advanceTimersByTimeAsync(0);
    engine.stop();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(proc.drain).toHaveBeenCalledTimes(1);
  });

  it("a flush() without start() (the headless background task) arms no timer", async () => {
    jest.useFakeTimers();
    const proc = fakeProcessor(5_000);
    const engine = new SyncEngine(proc as unknown as Processor, connectivity);
    await engine.flush();
    expect(proc.msUntilNextRetry).not.toHaveBeenCalled();
  });
});

describe("SyncEngine — foreground and owner triggers", () => {
  it("drains when the app returns to the foreground, and unsubscribes on stop", async () => {
    let fire: (() => void) | undefined;
    const unsubscribe = jest.fn();
    const proc = fakeProcessor(null);
    const engine = new SyncEngine(proc as unknown as Processor, connectivity, undefined, undefined, (cb) => {
      fire = cb;
      return unsubscribe;
    });
    engine.start();
    fire!();
    await Promise.resolve();
    expect(proc.drain).toHaveBeenCalledTimes(2);
    engine.stop();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("requestDrain() drains while started and is a no-op once stopped", async () => {
    const proc = fakeProcessor(null);
    const engine = new SyncEngine(proc as unknown as Processor, connectivity);
    engine.start();
    engine.requestDrain();
    await Promise.resolve();
    expect(proc.drain).toHaveBeenCalledTimes(2);
    engine.stop();
    engine.requestDrain();
    await Promise.resolve();
    expect(proc.drain).toHaveBeenCalledTimes(2);
  });
});
