import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// A screen that wraps itself in <SafeAreaView edges={[...]}> WITHOUT "top" is
// relying on a native Stack header to sit between it and the status bar. If the
// root Stack does not actually show a header for that route, the top of the
// screen renders UNDER the clock / notch.
//
// That is exactly how the backflow screens hid their own "Back" button: they
// copied job/[id]'s `edges={["bottom", "left", "right"]}` but were never
// registered with `headerShown: true`, so the root `headerShown: false` applied.
// Nothing on a simulator with a short status bar makes this obvious, and a
// technician cannot leave the screen.
//
// Derived from the file tree, not a list, so a new screen is covered the day it
// is added.

const APP = join(__dirname, "..", "..", "app");
const ROOT_LAYOUT = readFileSync(join(APP, "_layout.tsx"), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith(".tsx") && e !== "_layout.tsx") out.push(p);
  }
  return out;
}

function routeName(file: string): string {
  return relative(APP, file).replace(/\\/g, "/").replace(/\.tsx$/, "");
}

function omitsTopEdge(src: string): boolean {
  return [...src.matchAll(/edges=\{\[([^\]]*)\]\}/g)].some((m) => !/["']top["']/.test(m[1]));
}

function rootShowsHeaderFor(route: string): boolean {
  const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`<Stack\\.Screen\\s+name="${escaped}"[^>]*headerShown:\\s*true`).test(ROOT_LAYOUT);
}

const screens = walk(APP)
  .filter((f) => !/\/\([^/]+\)\//.test(f.replace(/\\/g, "/"))) // tab/group children get their navigator's header
  .filter((f) => omitsTopEdge(readFileSync(f, "utf8")))
  .map(routeName);

describe("screens that leave the top inset to a native header", () => {
  it("found some (the scan is not vacuous)", () => {
    expect(screens).toEqual(expect.arrayContaining(["job/[id]", "backflow/[id]"]));
  });

  it.each(screens)("%s is registered with headerShown: true in app/_layout.tsx", (route) => {
    expect(rootShowsHeaderFor(route)).toBe(true);
  });
});

describe("backflow screens draw no back button of their own", () => {
  it.each(["backflow/[id]", "backflow/new", "backflow-test/[id]"])("%s", (route) => {
    const src = readFileSync(join(APP, `${route}.tsx`), "utf8");
    // A hand-rolled back row is what got hidden; the native header supplies it.
    expect(src).not.toMatch(/name="arrow-back"/);
  });
});
