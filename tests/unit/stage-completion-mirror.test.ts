import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The phone's sign-off decides per stage with a copy of the web's rule
// (Justin, 22 Nov 2026). Both must agree, or a job closes from one and stays
// open from the other. Only the header comment may differ.
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").split("\n");

describe("lib/stage-completion.ts and mobile/lib/stageCompletion.ts", () => {
  const fromImports = (p: string) => {
    const lines = read(p);
    const first = lines.findIndex((l) => l.startsWith("import "));
    expect(first).toBeGreaterThan(-1);
    return lines.slice(first).join("\n");
  };

  it("are identical from the imports on", () => {
    expect(fromImports("mobile/lib/stageCompletion.ts")).toBe(fromImports("lib/stage-completion.ts"));
  });
});
