import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The phone's office Schedule tab has the to-do list too (Justin, 19 Nov
// 2026). It books a to-do job, takes a booking back to the list and counts a
// technician's free hours with copies of the web's pure rules. Both must agree,
// or a job placed from the phone gets different hours from one dropped on the
// web board. Only the header comment and the import lines may differ.
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").split("\n");

describe("lib/todo-board.ts and mobile/lib/todoBoard.ts", () => {
  const belowImports = (p: string) => {
    const lines = read(p);
    let lastImport = -1;
    lines.forEach((line, i) => {
      if (line.startsWith("import ")) lastImport = i;
    });
    expect(lastImport).toBeGreaterThan(-1);
    return lines.slice(lastImport + 1).join("\n");
  };

  it("are identical below the imports", () => {
    expect(belowImports("mobile/lib/todoBoard.ts")).toBe(belowImports("lib/todo-board.ts"));
  });

  it("import the same names", () => {
    const names = (p: string) =>
      read(p)
        .filter((l) => l.startsWith("import "))
        .flatMap((l) => {
          const m = l.match(/^import (?:type )?\{(.*)\} from /);
          expect(m).not.toBeNull();
          return m![1].split(",");
        })
        .map((n) => n.trim().replace(/^type /, "").replace(/^\w+ as /, ""))
        .sort();
    expect(names("mobile/lib/todoBoard.ts")).toEqual(names("lib/todo-board.ts"));
  });
});

describe("lib/todo-list.ts and mobile/lib/todoList.ts", () => {
  it("are identical from the first export on", () => {
    const fromFirstExport = (p: string) => {
      const lines = read(p);
      const first = lines.findIndex((l) => l.startsWith("export "));
      expect(first).toBeGreaterThan(-1);
      expect(lines.some((l) => l.startsWith("import "))).toBe(false);
      return lines.slice(first).join("\n");
    };
    expect(fromFirstExport("mobile/lib/todoList.ts")).toBe(fromFirstExport("lib/todo-list.ts"));
  });
});
