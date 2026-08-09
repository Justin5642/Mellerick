import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { escapeHtml } from "../../lib/html";

// escapeHtml has existed in lib/html.ts since it was written, and was used in
// exactly one place — the backflow submit route. Both customer-facing SEND
// routes interpolated untrusted values straight into email HTML:
//
//   ${invoice.customers?.name ?? "there"}   customer name, from the database
//   ${invoice.title}                        job title, typed by staff
//   ${String(body.message)}                 personal note, typed at send time
//
// This is a source scan, deliberately. A behavioural test would have to mock
// Resend, the PDF renderer, Supabase and the guards, and would then assert on
// the mock rather than on what is actually sent. The property that matters is
// simply that these interpolations are wrapped — that is visible in the source
// and invisible to a mocked send.

const ROUTES = [
  join(process.cwd(), "app", "api", "invoices", "[id]", "send", "route.ts"),
  join(process.cwd(), "app", "api", "quotes", "[id]", "send", "route.ts"),
];

describe("escapeHtml", () => {
  it("neutralises a script tag", () => {
    expect(escapeHtml('<script>alert(1)</script>')).not.toContain("<script>");
  });

  it("escapes quotes, so a value cannot break out of an attribute", () => {
    expect(escapeHtml('" onload="x')).not.toContain('"');
  });

  it("renders null/undefined as empty rather than the words", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

describe("customer-facing send routes escape untrusted values", () => {
  for (const route of ROUTES) {
    const name = route.split(/[\\/]/).slice(-4).join("/");

    it(`${name} imports escapeHtml`, () => {
      expect(readFileSync(route, "utf8")).toContain('from "@/lib/html"');
    });

    it(`${name} escapes the customer name`, () => {
      const src = readFileSync(route, "utf8");
      const raw = src.match(/\$\{(invoice|quote)\.customers\?\.name \?\? "there"\}/);
      expect(raw, "customer name is interpolated without escapeHtml").toBeNull();
    });

    it(`${name} escapes the document title`, () => {
      const src = readFileSync(route, "utf8");
      const raw = src.match(/\$\{(invoice|quote)\.title\}/);
      expect(raw, "title is interpolated without escapeHtml").toBeNull();
    });

    it(`${name} escapes the personal note BEFORE converting newlines`, () => {
      // Order matters and is easy to get backwards: escaping after the newline
      // conversion would escape the <br/> tags just inserted, so the note would
      // render with visible markup. That looks like a formatting bug, gets
      // "fixed" by removing the escape, and quietly restores the hole.
      const src = readFileSync(route, "utf8");
      expect(src).toMatch(/escapeHtml\(String\(body\.message\)\)\.replace\(\/\\n\/g, "<br\/>"\)/);
    });
  }
});
