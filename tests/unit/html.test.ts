import { describe, it, expect } from "vitest";
import { escapeHtml } from "@/lib/html";

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<script>alert("x")&'`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;");
  });

  it("neutralizes a tag-injection attempt in a customer name", () => {
    const malicious = `Acme <img src=x onerror=alert(1)>`;
    const out = escapeHtml(malicious);
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
  });

  it("renders null/undefined as an empty string", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});
