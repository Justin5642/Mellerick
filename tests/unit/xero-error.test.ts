import { describe, it, expect } from "vitest";
import { describeXeroError } from "@/lib/xero";

// Characterization tests for the one pure function in lib/xero.ts. It digs the
// real Xero message out of the several shapes xero-node v18 throws (response
// body, top-level body, or a JSON string only reachable via String(err)).
// The rest of the module makes live Xero/Supabase calls and is covered by
// integration/E2E, not unit tests.

describe("describeXeroError", () => {
  it("joins per-line validation messages from err.response.body.Elements", () => {
    const err = {
      response: {
        body: {
          Elements: [
            { ValidationErrors: [{ Message: "Account code 'X' is archived" }] },
            { ValidationErrors: [{ Message: "Invoice must have a due date" }] },
          ],
        },
      },
    };
    expect(describeXeroError(err)).toBe("Account code 'X' is archived; Invoice must have a due date");
  });

  it("de-duplicates repeated validation messages", () => {
    const err = {
      body: {
        Elements: [
          { ValidationErrors: [{ Message: "Same problem" }] },
          { ValidationErrors: [{ Message: "Same problem" }] },
        ],
      },
    };
    expect(describeXeroError(err)).toBe("Same problem");
  });

  it("combines a top-level headline with its detail for auth/other failures", () => {
    const err = { body: { Title: "Unauthorized", Detail: "Token has expired" } };
    expect(describeXeroError(err)).toBe("Unauthorized: Token has expired");
  });

  it("returns just the headline when detail is absent or identical", () => {
    expect(describeXeroError({ body: { Message: "Forbidden" } })).toBe("Forbidden");
    expect(describeXeroError({ body: { Message: "Same", Detail: "Same" } })).toBe("Same");
  });

  it("recovers the message from an error that only stringifies to JSON (xero-node v18 quirk)", () => {
    // response.body reads back undefined; the detail is only in String(err).
    const err = {
      toString: () => JSON.stringify({ response: { body: { Message: "Rate limit exceeded" } } }),
    };
    expect(describeXeroError(err)).toBe("Rate limit exceeded");
  });

  it("prefers validation messages over a top-level headline when both are present", () => {
    const err = {
      body: {
        Message: "A validation exception occurred",
        Elements: [{ ValidationErrors: [{ Message: "The specific field is wrong" }] }],
      },
    };
    expect(describeXeroError(err)).toBe("The specific field is wrong");
  });

  it("falls back to err.message when no structured body is present", () => {
    expect(describeXeroError({ message: "HTTP request failed" })).toBe("HTTP request failed");
  });

  it("falls back to a generic string for a bare/empty error", () => {
    expect(describeXeroError({})).toBe("Unknown Xero error");
    expect(describeXeroError(null)).toBe("Unknown Xero error");
  });
});
