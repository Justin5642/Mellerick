import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// "Make sure every dead end has a back button" (Justin, 27 Nov 2026 — an
// invoice PDF preview he couldn't get out of). iOS has no hardware back and a
// swipe isn't obvious, so every place a user can end up must SHOW a way out.
// Derived from the file tree, not a list, so a new screen or modal is covered
// the day it is added.

const ROOT = join(__dirname, "..", "..");
const APP = join(ROOT, "app");
const ROOT_LAYOUT = readFileSync(join(APP, "_layout.tsx"), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e !== "node_modules") walk(p, out);
    } else if (e.endsWith(".tsx") && !/\.test\.tsx$/.test(e)) out.push(p);
  }
  return out;
}

const rel = (f: string) => relative(ROOT, f).replace(/\\/g, "/");

describe("stack screens", () => {
  // Screens with no native header that are not a dead end for another reason.
  const NO_HEADER_OK: Record<string, string> = {
    login: "the signed-out start screen — there is nowhere to go back to",
  };

  const routes = walk(APP)
    .map((f) => relative(APP, f).replace(/\\/g, "/").replace(/\.tsx$/, ""))
    .filter((r) => !r.endsWith("_layout"))
    .filter((r) => !/^\([^/]+\)\//.test(r)); // tab roots: the tab bar is the way out

  it("found the routes (the scan is not vacuous)", () => {
    expect(routes).toEqual(expect.arrayContaining(["job/[id]", "invoices/[id]", "run/today"]));
  });

  it("the root Stack gives every header a visible Back (ScreenBackButton)", () => {
    expect(ROOT_LAYOUT).toMatch(/screenOptions=\{\{[^}]*headerLeft:\s*\(\)\s*=>\s*<ScreenBackButton\b/);
  });

  it.each(routes)("%s shows the native header (so it gets the Back), or is allowed not to", (route) => {
    if (NO_HEADER_OK[route]) return;
    const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(ROOT_LAYOUT).toMatch(new RegExp(`<Stack\\.Screen\\s+name="${escaped}"[^>]*headerShown:\\s*true`));
  });

  it("nothing hides or replaces the shared Back", () => {
    for (const f of walk(APP)) {
      const src = readFileSync(f, "utf8");
      expect({ file: rel(f), hides: /headerBackVisible:\s*false|headerLeft:\s*\(\)\s*=>\s*null|gestureEnabled:\s*false/.test(src) }).toEqual({
        file: rel(f),
        hides: false,
      });
    }
  });

  it("only the root layout is a Stack (a nested Stack would need its own Back)", () => {
    const stacks = walk(APP)
      .filter((f) => f.endsWith("_layout.tsx"))
      .filter((f) => /<Stack\b/.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(stacks).toEqual(["app/_layout.tsx"]);
  });
});

/** Each `<Modal …>…</Modal>` in a source file: the opening tag and the whole block. */
function modals(src: string): { tag: string; block: string; line: number }[] {
  const out: { tag: string; block: string; line: number }[] = [];
  const re = /<Modal\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    // The opening tag ends at the first ">" outside braces (props hold "=>").
    let depth = 0;
    let i = m.index + 1;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    const tag = src.slice(m.index, i + 1);
    const end = src.indexOf("</Modal>", i);
    out.push({ tag, block: src.slice(m.index, end === -1 ? undefined : end), line: src.slice(0, m.index).split("\n").length });
  }
  return out;
}

// A visible control that closes the modal: the shared ones, or a button that
// plainly says so.
const WAY_OUT =
  /\bModalHeader\b|\bModalCloseButton\b|\bSheetCancelButton\b|accessibilityLabel="Close|label="Close"|>\s*(Cancel|Close|Done|Got it|Retake)\s*</i;
// The few whose way out is a decision button, named here with why.
const DECISION_OK: Record<string, RegExp> = {
  "components/ClockPromptSheet.tsx": /title="No, I'm not on site"|title="Still working"/,
  "components/LocationDisclosure.tsx": /title="No thanks/,
  "app/jobs/new.tsx": /styles\.cancelBtn[^>]*onPress=\{onClose\}/,
};

describe("every <Modal> has a way out", () => {
  const found = walk(ROOT)
    .filter((f) => !rel(f).startsWith("test/"))
    .flatMap((f) => modals(readFileSync(f, "utf8")).map((m) => ({ ...m, file: rel(f) })));

  it("found the modals (the scan is not vacuous)", () => {
    expect(found.map((m) => m.file)).toEqual(expect.arrayContaining(["components/finance/pdf-preview.tsx", "components/KeyboardSheet.tsx"]));
  });

  it.each(found.map((m) => [`${m.file}:${m.line}`, m] as const))("%s closes on Android back (onRequestClose)", (_k, m) => {
    expect(m.tag).toMatch(/onRequestClose=/);
  });

  it.each(found.map((m) => [`${m.file}:${m.line}`, m] as const))("%s shows a Close / Cancel / Back control", (_k, m) => {
    const ok = WAY_OUT.test(m.block) || (DECISION_OK[m.file]?.test(m.block) ?? false);
    expect(ok).toBe(true);
  });

  it("full-screen modals close from the top-left (ModalHeader / ModalCloseButton) or a bottom Cancel", () => {
    for (const m of found.filter((x) => /presentationStyle="fullScreen"/.test(x.tag))) {
      expect({ at: `${m.file}:${m.line}`, ok: /\bModalHeader\b|\bModalCloseButton\b|>\s*Cancel\s*<|title="No thanks/.test(m.block) }).toEqual({
        at: `${m.file}:${m.line}`,
        ok: true,
      });
    }
  });
});
