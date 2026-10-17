import { DEFAULT_TIMEOUT_MS, STORAGE_TIMEOUT_MS, RequestTimeoutError, fetchWithTimeout, timeoutFor } from "./fetchWithTimeout";

// Every Supabase request goes through this (lib/supabase.ts global.fetch). A
// stalled request used to hang the serial outbox queue forever.

const realFetch = global.fetch;

// A fetch that never settles unless its signal aborts — the failure mode.
function hangingFetch() {
  return jest.fn(
    (_url: unknown, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })));
      })
  );
}

afterEach(() => {
  global.fetch = realFetch;
  jest.useRealTimers();
});

describe("timeoutFor", () => {
  it("gives storage traffic the long deadline and everything else the short one", () => {
    expect(timeoutFor("https://x.supabase.co/storage/v1/object/job-photos/a.jpg")).toBe(STORAGE_TIMEOUT_MS);
    expect(timeoutFor("https://x.supabase.co/rest/v1/time_entries")).toBe(DEFAULT_TIMEOUT_MS);
    expect(timeoutFor("https://x.supabase.co/auth/v1/token")).toBe(DEFAULT_TIMEOUT_MS);
  });
});

describe("fetchWithTimeout", () => {
  it("rejects with a RequestTimeoutError once the deadline passes", async () => {
    jest.useFakeTimers();
    global.fetch = hangingFetch() as never;
    const pending = fetchWithTimeout("https://x.supabase.co/rest/v1/jobs");
    const assertion = expect(pending).rejects.toBeInstanceOf(RequestTimeoutError);
    await jest.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    await assertion;
  });

  it("does NOT time out a storage request at the ordinary deadline", async () => {
    jest.useFakeTimers();
    global.fetch = hangingFetch() as never;
    let settled = false;
    const pending = fetchWithTimeout("https://x.supabase.co/storage/v1/object/b/p").catch(() => (settled = true));
    await jest.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS + 1);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(STORAGE_TIMEOUT_MS);
    await pending;
    expect(settled).toBe(true);
  });

  it("passes the response through untouched when the server answers in time", async () => {
    const response = { ok: true, status: 200 } as Response;
    global.fetch = jest.fn().mockResolvedValue(response) as never;
    await expect(fetchWithTimeout("https://x/rest/v1/jobs")).resolves.toBe(response);
  });

  it("honours the caller's own abort, and does not report it as a timeout", async () => {
    global.fetch = hangingFetch() as never;
    const controller = new AbortController();
    const pending = fetchWithTimeout("https://x/rest/v1/jobs", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("a network failure is passed through as-is", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("Network request failed")) as never;
    await expect(fetchWithTimeout("https://x/rest/v1/jobs")).rejects.toThrow("Network request failed");
  });
});
