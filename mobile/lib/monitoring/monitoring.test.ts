import * as Sentry from "@sentry/react-native";
import {
  __resetMonitoringForTests,
  initMonitoring,
  isMonitoringEnabled,
  isReleasedSharedObjectError,
  monitoringDsn,
  reportDeadLetter,
  reportSyncError,
  wrapRoot,
} from "./index";
import { redactMessage, scrubBreadcrumb, scrubEvent } from "./scrub";
import { Outbox, MAX_ATTEMPTS } from "../data/outbox/outbox";
import { InMemoryOutboxStore } from "../data/outbox/store";
import type { WriteOperation } from "../data/outbox/types";

// @sentry/react-native is replaced by the recording stand-in in test/setup.ts.
const init = Sentry.init as jest.Mock;
const capture = Sentry.captureException as jest.Mock;
const wrap = Sentry.wrap as jest.Mock;

const DSN = { EXPO_PUBLIC_SENTRY_DSN: "https://public@o0.ingest.sentry.io/0" };

function write(over: Partial<WriteOperation> = {}): WriteOperation {
  return {
    kind: "write",
    id: "op1",
    rowId: "row1",
    aggregate: "time_entry",
    op: "insert",
    table: "time_entries",
    payload: { notes: "Customer at 12 Smith St", rate_override: 145.5 },
    status: "pending",
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 0,
    ...over,
  };
}

beforeEach(() => {
  __resetMonitoringForTests();
  init.mockClear();
  capture.mockClear();
  wrap.mockClear();
});

describe("without a DSN", () => {
  it.each([{}, { EXPO_PUBLIC_SENTRY_DSN: "" }, { EXPO_PUBLIC_SENTRY_DSN: "undefined" }, { EXPO_PUBLIC_SENTRY_DSN: "  " }])(
    "does not initialise for %p",
    (env) => {
      expect(monitoringDsn(env)).toBeUndefined();
      expect(initMonitoring(env)).toBe(false);
      expect(init).not.toHaveBeenCalled();
      expect(isMonitoringEnabled()).toBe(false);
    }
  );

  it("every reporter is a no-op and the root component is returned unwrapped", () => {
    initMonitoring({});
    reportSyncError(new Error("drain failed"), "sync-engine");
    reportDeadLetter(write({ attempts: MAX_ATTEMPTS }), "boom");
    const Root = () => null;
    expect(wrapRoot(Root)).toBe(Root);
    expect(capture).not.toHaveBeenCalled();
    expect(wrap).not.toHaveBeenCalled();
  });
});

describe("with a DSN", () => {
  beforeEach(() => initMonitoring(DSN));

  it("initialises once with PII, screenshots and view hierarchy off", () => {
    initMonitoring(DSN);
    expect(init).toHaveBeenCalledTimes(1);
    const options = init.mock.calls[0][0];
    expect(options).toMatchObject({
      dsn: DSN.EXPO_PUBLIC_SENTRY_DSN,
      sendDefaultPii: false,
      attachScreenshot: false,
      attachViewHierarchy: false,
      tracesSampleRate: 0,
    });
    expect(options.beforeSend).toBeInstanceOf(Function);
    expect(options.beforeBreadcrumb).toBeInstanceOf(Function);
  });

  it("reports a dead-lettered write with tags only — never the payload", () => {
    reportDeadLetter(write({ attempts: MAX_ATTEMPTS }), 'invalid input syntax for type numeric: "145.50"');
    expect(capture).toHaveBeenCalledTimes(1);
    const [error, hint] = capture.mock.calls[0];
    expect(hint).toEqual({
      tags: { source: "outbox", kind: "write", table: "time_entries", op: "insert", aggregate: "time_entry", attempts: String(MAX_ATTEMPTS) },
    });
    const sent = JSON.stringify([error.message, hint]);
    for (const leaked of ["Smith", "145", "rate_override", "notes"]) expect(sent).not.toContain(leaked);
  });

  it("reports a dead-lettered side effect by its effect name", () => {
    reportDeadLetter(
      { kind: "side_effect", id: "s1", effect: "backflow-submit", coalesceKey: "k", payload: { testId: "t" }, status: "dead", attempts: 8, nextAttemptAt: 0, createdAt: 0 },
      "500"
    );
    expect(capture.mock.calls[0][1]).toEqual({ tags: { source: "outbox", kind: "side_effect", effect: "backflow-submit", attempts: "8" } });
  });

  it("skips the expected released-shared-object teardown error (HANDOVER §10 trap 7)", () => {
    reportSyncError(new Error("Cannot use shared object that was already released"), "sync-status");
    reportSyncError(Object.assign(new Error("x"), { code: "ERR_USING_RELEASED_SHARED_OBJECT" }), "sync-status");
    expect(capture).not.toHaveBeenCalled();
  });

  it("reports a real sync failure once per session, not every poll", () => {
    for (let i = 0; i < 5; i++) reportSyncError(new Error("database is locked"), "sync-status");
    reportSyncError(new Error("database is locked"), "sync-engine");
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls[0][1]).toEqual({ tags: { source: "sync-status" } });
  });

  it("wraps the root component", () => {
    const Root = () => null;
    wrapRoot(Root);
    expect(wrap).toHaveBeenCalledWith(Root);
  });
});

describe("Outbox dead-letter hook", () => {
  it("fires when retries are exhausted, and not before", async () => {
    const onDead = jest.fn();
    const store = new InMemoryOutboxStore();
    const box = new Outbox(store, { now: () => 0 }, onDead);
    const op = write();
    await box.enqueue(op);
    await box.markFailed({ ...op, attempts: MAX_ATTEMPTS - 2 }, "e");
    expect(onDead).not.toHaveBeenCalled();
    await box.markFailed({ ...op, attempts: MAX_ATTEMPTS - 1 }, "rejected");
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(onDead.mock.calls[0][0]).toMatchObject({ id: "op1", status: "dead", attempts: MAX_ATTEMPTS });
    expect(onDead.mock.calls[0][1]).toBe("rejected");
  });

  it("fires for a dependent cascaded dead, and a throwing hook never breaks the outbox", async () => {
    const onDead = jest.fn(() => {
      throw new Error("reporter broke");
    });
    const store = new InMemoryOutboxStore();
    const box = new Outbox(store, { now: () => 0 }, onDead);
    await box.enqueue(write({ id: "a", status: "dead" }));
    await box.enqueue(write({ id: "b", rowId: "row2", dependsOn: "a" }));
    await expect(box.cascadeDeadDependencies()).resolves.toBeUndefined();
    expect(onDead).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }), "dependency failed");
    expect((await store.all()).find((o) => o.id === "b")?.status).toBe("dead");
  });
});

describe("scrubbing", () => {
  it("removes request body, cookies, query string and auth headers", () => {
    const event = scrubEvent({
      request: {
        url: "https://x.supabase.co/rest/v1/invoices?id=eq.42&select=total",
        data: '{"total_amount":1234.5}',
        cookies: { sb: "jwt" },
        query_string: "id=eq.42",
        headers: { Authorization: "Bearer jwt", apikey: "anon", "User-Agent": "okhttp" },
      },
      user: { id: "u1", email: "tech@example.com", ip_address: "1.2.3.4" },
      extra: { payload: { amount: 99 } },
    });
    expect(event.request).toEqual({ url: "https://x.supabase.co/rest/v1/invoices", headers: { "User-Agent": "okhttp" } });
    expect(event.user).toEqual({ id: "u1" });
    expect(event.extra).toBeUndefined();
    const s = JSON.stringify(event);
    for (const leaked of ["1234", "jwt", "anon", "tech@example.com", "eq.42"]) expect(s).not.toContain(leaked);
  });

  it("drops console and touch breadcrumbs and strips URLs", () => {
    expect(scrubBreadcrumb({ category: "console", message: "note text" })).toBeNull();
    expect(scrubBreadcrumb({ category: "touch", message: "Touch event within element: Text 'Pay $1,234'" })).toBeNull();
    expect(
      scrubBreadcrumb({ category: "xhr", data: { url: "https://x/rest/v1/jobs?id=eq.1", method: "PATCH", status_code: 409, body: "{}" } })
    ).toEqual({ category: "xhr", data: { url: "https://x/rest/v1/jobs", method: "PATCH", status_code: 409 } });
  });

  it("redacts numbers and echoed values from server messages", () => {
    expect(redactMessage('invalid input syntax for type numeric: "145.50"')).toBe('invalid input syntax for type numeric: "…"');
    expect(redactMessage('new row violates row-level security policy for table "time_entries"')).toBe(
      'new row violates row-level security policy for table "time_entries"'
    );
    expect(redactMessage("amount 1,234.50 exceeds limit")).toBe("amount # exceeds limit");
  });
});

describe("isReleasedSharedObjectError", () => {
  it("recognises only the teardown error", () => {
    expect(isReleasedSharedObjectError(new Error("Cannot use shared object that was already released"))).toBe(true);
    expect(isReleasedSharedObjectError(new Error("network request failed"))).toBe(false);
    expect(isReleasedSharedObjectError(undefined)).toBe(false);
  });
});
