import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The SDK is mocked so these tests can see whether it is ever touched.
vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import * as Sentry from "@sentry/nextjs";
import { reportError, reportFailure, isMonitoringEnabled } from "@/lib/monitoring";
import { sentryOptions } from "@/lib/monitoring/options";
import { scrubEvent, scrubBreadcrumb, stripQuery } from "@/lib/monitoring/scrub";

describe("reportError without a DSN", () => {
  const saved = process.env.NEXT_PUBLIC_SENTRY_DSN;
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(Sentry.captureMessage).mockClear();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    else process.env.NEXT_PUBLIC_SENTRY_DSN = saved;
  });

  it("is a no-op and never touches the SDK", () => {
    expect(isMonitoringEnabled()).toBe(false);
    reportError(new Error("boom"), { route: "api/test" });
    reportFailure("upstream 500", { route: "api/test" });
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("treats an empty DSN as unset", () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = "";
    reportError(new Error("boom"), { route: "api/test" });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

describe("reportError with a DSN", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://public@o0.ingest.sentry.io/0";
    vi.mocked(Sentry.captureException).mockClear();
  });
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  });

  it("sends the error with tags only — no extra/payload channel", () => {
    const err = new Error("Anthropic 529");
    reportError(err, { route: "api/ai/polish-note", integration: "anthropic", status: 529, skipped: undefined });
    expect(Sentry.captureException).toHaveBeenCalledWith(err, {
      tags: { route: "api/ai/polish-note", integration: "anthropic", status: "529" },
    });
  });

  it("keeps only the message and code of a plain-object (PostgREST) error", () => {
    reportError({ message: "permission denied", code: "42501", details: "Failing row contains (… 123.45 …)" }, { route: "api/x" });
    const [sent, hint] = vi.mocked(Sentry.captureException).mock.calls[0];
    expect((sent as Error).message).toBe("permission denied");
    expect(JSON.stringify(sent)).not.toContain("123.45");
    expect(hint).toEqual({ tags: { route: "api/x", error_code: "42501" } });
  });

  it("never throws, even if the SDK does", () => {
    vi.mocked(Sentry.captureException).mockImplementationOnce(() => {
      throw new Error("sdk broke");
    });
    expect(() => reportError(new Error("x"), { route: "api/x" })).not.toThrow();
  });
});

describe("sentryOptions", () => {
  it("keeps PII off, replay off and tracing low", () => {
    const o = sentryOptions("https://public@o0.ingest.sentry.io/0");
    expect(o.sendDefaultPii).toBe(false);
    expect(o.replaysSessionSampleRate).toBe(0);
    expect(o.replaysOnErrorSampleRate).toBe(0);
    expect(o.tracesSampleRate).toBeLessThanOrEqual(0.1);
    expect(o.beforeSend).toBeTypeOf("function");
    expect(o.beforeSendTransaction).toBeTypeOf("function");
  });
});

describe("scrubEvent", () => {
  it("removes request body, cookies, query string and auth headers", () => {
    const event = scrubEvent({
      request: {
        url: "https://app.example/api/xero/callback?code=SECRET&state=abc",
        method: "POST",
        data: { text: "Customer at 12 Smith St, quote $4,200" },
        cookies: { "sb-access-token": "jwt" },
        query_string: "code=SECRET",
        headers: {
          Authorization: "Bearer jwt",
          Cookie: "sb-access-token=jwt",
          "x-forwarded-for": "203.0.113.9",
          "User-Agent": "okhttp/4",
          "content-type": "application/json",
        },
      },
      user: { id: "u1", email: "tech@example.com", ip_address: "203.0.113.9", username: "tech" },
      extra: { payload: { amount: 4200 } },
    });

    expect(event.request?.data).toBeUndefined();
    expect(event.request?.cookies).toBeUndefined();
    expect(event.request?.query_string).toBeUndefined();
    expect(event.request?.url).toBe("https://app.example/api/xero/callback");
    expect(event.request?.headers).toEqual({ "User-Agent": "okhttp/4", "content-type": "application/json" });
    expect(event.user).toEqual({ id: "u1" });
    expect(event.extra).toBeUndefined();

    const serialised = JSON.stringify(event);
    for (const leaked of ["SECRET", "jwt", "4,200", "4200", "Smith", "203.0.113.9", "tech@example.com"]) {
      expect(serialised).not.toContain(leaked);
    }
  });

  it("scrubs breadcrumbs carried on the event", () => {
    const event = scrubEvent({
      breadcrumbs: [
        { category: "console", message: "Polish note error: <note text>" },
        { category: "fetch", data: { url: "https://api.x/v1?key=abc", method: "POST", status_code: 500, request_body: "{…}" } },
      ],
    });
    expect(event.breadcrumbs).toEqual([
      { category: "fetch", data: { url: "https://api.x/v1", method: "POST", status_code: 500 } },
    ]);
  });

  it("leaves an event with no request alone", () => {
    expect(scrubEvent({ message: "hello", tags: { route: "x" } })).toEqual({ message: "hello", tags: { route: "x" } });
  });
});

describe("scrubBreadcrumb / stripQuery", () => {
  it("drops console breadcrumbs outright", () => {
    expect(scrubBreadcrumb({ category: "console", message: "anything" })).toBeNull();
  });

  it("strips query and fragment from navigation", () => {
    expect(scrubBreadcrumb({ category: "navigation", data: { from: "/a?x=1", to: "/b#frag" } })).toEqual({
      category: "navigation",
      data: { from: "/a", to: "/b" },
    });
    expect(stripQuery("/plain")).toBe("/plain");
  });
});
