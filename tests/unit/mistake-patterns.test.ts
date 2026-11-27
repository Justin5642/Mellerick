import { describe, it, expect } from "vitest";
import {
  CENTRE_SHARE_PCT,
  PATTERN_WINDOW_DAYS,
  SAME_CATEGORY_MIN,
  SAME_CAUSE_MIN,
  SAME_CUSTOMER_MIN,
  SAME_PERSON_MIN,
  SAME_SITE_MIN,
  SAME_SUPPLIER_MIN,
  daysBefore,
  findMistakePatterns,
  patternsForViewer,
  type PatternInput,
  type PatternMistake,
} from "@/lib/mistake-patterns";
import { summariseDigestPatterns } from "@/lib/mistakes-digest";
import { buildDigest } from "@/lib/weekly-digest";

const TODAY = "2026-11-27";
const centres = [
  { id: "bgd", name: "Below Ground Drainage" },
  { id: "agp", name: "Above Ground Plumbing" },
];
const lineCentre = new Map<string, string | null>([
  ["l-sewer", "bgd"],
  ["l-storm", "bgd"],
  ["l-agp", "agp"],
]);

let n = 0;
const mk = (o: Partial<PatternMistake> & { net?: number; claimed?: number; recovered?: number } = {}): PatternMistake => {
  const { net = 100, claimed = 0, recovered = 0, ...rest } = o;
  n += 1;
  return {
    id: `m${n}`,
    job_id: "j1",
    occurred_on: "2026-11-01",
    category_id: null,
    cause_code: null,
    supplier_id: null,
    cost_center_id: null,
    cost_centre_id: null,
    money: { gross: net + recovered, claimed, recovered, net },
    ...rest,
  };
};

const base = (mistakes: PatternMistake[], extra: Partial<PatternInput> = {}): PatternInput => ({
  mistakes,
  today: TODAY,
  lineCentre,
  centres,
  jobs: new Map([
    ["j1", { customer_id: "c1", site_id: "s1", open: true }],
    ["j2", { customer_id: "c1", site_id: "s2", open: true }],
    ["j3", { customer_id: "c2", site_id: "s3", open: false }],
    ["j4", { customer_id: "c1", site_id: "s4", open: true }],
  ]),
  names: {
    category: new Map([["cat-rework", "Rework"]]),
    supplier: new Map([["sup-reece", "Reece"]]),
    customer: new Map([["c1", "Luxton Homes"]]),
    site: new Map([["s1", "12 Smith St, Epping"]]),
    staff: new Map([["p1", "Brodie"]]),
    cause: (c) => (c === "ordering" ? "Ordering" : null),
  },
  ...extra,
});

const kinds = (flags: { kind: string }[]) => flags.map((f) => f.kind);

describe("thresholds", () => {
  it("are the agreed defaults", () => {
    expect([PATTERN_WINDOW_DAYS, SAME_CAUSE_MIN, SAME_CATEGORY_MIN, SAME_SUPPLIER_MIN, SAME_CUSTOMER_MIN, SAME_SITE_MIN, SAME_PERSON_MIN, CENTRE_SHARE_PCT]).toEqual([
      90, 3, 3, 2, 3, 2, 2, 5,
    ]);
  });
  it("daysBefore counts calendar days", () => {
    expect(daysBefore("2026-11-27", 90)).toBe("2026-08-29");
    expect(daysBefore("2026-03-01", 1)).toBe("2026-02-28");
  });
});

describe("findMistakePatterns — cause", () => {
  it("flags the same cause 3 times in 90 days, not 2", () => {
    const two = [mk({ cause_code: "ordering", job_id: null }), mk({ cause_code: "ordering", job_id: null })];
    expect(findMistakePatterns(base(two))).toEqual([]);
    const three = [...two, mk({ cause_code: "ordering", job_id: null, net: 50 })];
    const flags = findMistakePatterns(base(three));
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ kind: "cause", key: "ordering", title: "Cause: Ordering", count: 3, net: 250, rule: "3 times in the last 90 days" });
  });

  it("ignores mistakes outside the window (and in the future)", () => {
    const flags = findMistakePatterns(
      base([
        mk({ cause_code: "install", job_id: null, occurred_on: "2026-08-28" }), // 91 days back
        mk({ cause_code: "install", job_id: null, occurred_on: "2026-08-29" }), // exactly 90
        mk({ cause_code: "install", job_id: null }),
        mk({ cause_code: "install", job_id: null, occurred_on: "2026-12-01" }),
      ])
    );
    expect(flags).toEqual([]);
  });

  it("flags a cause within one cost centre when it isn't the whole overall flag", () => {
    const flags = findMistakePatterns(
      base([
        mk({ cause_code: "install", job_id: null, cost_center_id: "l-sewer" }),
        mk({ cause_code: "install", job_id: null, cost_center_id: "l-storm" }),
        mk({ cause_code: "install", job_id: null, cost_centre_id: "bgd" }),
        mk({ cause_code: "install", job_id: null, cost_center_id: "l-agp" }),
      ])
    );
    expect(kinds(flags).sort()).toEqual(["cause", "cause_centre"]);
    const c = flags.find((f) => f.kind === "cause_centre")!;
    expect(c.title).toBe("Cause: install in Below Ground Drainage");
    expect(c.count).toBe(3);
  });

  it("doesn't repeat the overall flag when every one is in the same centre", () => {
    const flags = findMistakePatterns(base([1, 2, 3].map(() => mk({ cause_code: "install", job_id: null, cost_center_id: "l-sewer" }))));
    expect(kinds(flags)).toEqual(["cause"]);
  });
});

describe("findMistakePatterns — category, supplier, builder, site", () => {
  it("category 3+", () => {
    const flags = findMistakePatterns(base([1, 2, 3].map(() => mk({ category_id: "cat-rework", job_id: null }))));
    expect(flags[0]).toMatchObject({ kind: "category", title: "Category: Rework", count: 3 });
  });

  it("supplier 2+, with what was claimed and received", () => {
    const flags = findMistakePatterns(
      base([mk({ supplier_id: "sup-reece", job_id: null, net: 300, claimed: 200, recovered: 100 }), mk({ supplier_id: "sup-reece", job_id: null, net: 50, claimed: 50 })])
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ kind: "supplier", title: "Supplier: Reece", count: 2, net: 350, claimed: 250, recovered: 100, gross: 450 });
  });

  it("builder 3+ across different jobs and sites", () => {
    const flags = findMistakePatterns(base([mk({ job_id: "j1" }), mk({ job_id: "j2" }), mk({ job_id: "j4" }), mk({ job_id: "j3" })]));
    expect(flags.map((f) => f.kind)).toEqual(["customer"]);
    expect(flags[0]).toMatchObject({ title: "Builder: Luxton Homes", count: 3 });
  });

  it("site 2+ ever — even years apart", () => {
    const flags = findMistakePatterns(base([mk({ job_id: "j3", occurred_on: "2024-02-01" }), mk({ job_id: "j3" })]));
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ kind: "site", key: "s3", count: 2, rule: "2 mistakes at this site (all time)" });
    // newest first
    expect(flags[0].mistakes.map((m) => m.occurred_on)).toEqual(["2026-11-01", "2024-02-01"]);
  });
});

describe("findMistakePatterns — person (admin only)", () => {
  const two = () => [mk({ job_id: null }), mk({ job_id: null })];

  it("is only made when the responsibility map is passed", () => {
    const ms = two();
    expect(findMistakePatterns(base(ms))).toEqual([]);
    const flags = findMistakePatterns(base(ms, { responsible: new Map(ms.map((m) => [m.id, "p1"])) }));
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ kind: "person", title: "Person: Brodie", adminOnly: true });
  });

  it("is hidden from anyone but admin", () => {
    const ms = two();
    const flags = findMistakePatterns(base(ms, { responsible: new Map(ms.map((m) => [m.id, "p1"])) }));
    expect(patternsForViewer(flags, true)).toHaveLength(1);
    expect(patternsForViewer(flags, false)).toEqual([]);
  });
});

describe("findMistakePatterns — cost centre share of open jobs", () => {
  it(`flags a centre over ${CENTRE_SHARE_PCT}% of its open jobs' PO value, not at or under`, () => {
    const ms = [mk({ job_id: "j1", cost_center_id: "l-sewer", net: 600 }), mk({ job_id: "j3", cost_center_id: "l-sewer", net: 5000 }), mk({ job_id: "j2", cost_center_id: "l-agp", net: 500 })];
    const flags = findMistakePatterns(base(ms, { openCentreValue: new Map([["bgd", 10000], ["agp", 10000]]) }));
    // bgd: only the open job counts → 600 / 10000 = 6%; agp: exactly 5% → not flagged
    const share = flags.filter((f) => f.kind === "centre_share");
    expect(share).toHaveLength(1);
    expect(share[0]).toMatchObject({ key: "bgd", value: 10000, pct: 6, net: 600, count: 1 });
    expect(share[0].rule).toContain("6% of its builder PO value");
  });

  it("skips a centre with no PO value and untagged mistakes", () => {
    const flags = findMistakePatterns(base([mk({ job_id: "j1", net: 900 }), mk({ job_id: "j1", cost_center_id: "l-agp", net: 900 })], { openCentreValue: new Map() }));
    expect(flags.filter((f) => f.kind === "centre_share")).toEqual([]);
  });
});

describe("ordering", () => {
  it("worst first by net cost, then count", () => {
    const flags = findMistakePatterns(
      base([
        mk({ supplier_id: "sup-reece", job_id: null, net: 10 }),
        mk({ supplier_id: "sup-reece", job_id: null, net: 10 }),
        ...[1, 2, 3].map(() => mk({ category_id: "cat-rework", job_id: null, net: 500 })),
      ])
    );
    expect(kinds(flags)).toEqual(["category", "supplier"]);
  });
});

describe("Monday email", () => {
  it("counts the office's patterns and names the top 3 — never a person", () => {
    const ms = [
      ...[1, 2].map(() => mk({ supplier_id: "sup-reece", job_id: null, net: 10 })),
      ...[1, 2, 3].map(() => mk({ category_id: "cat-rework", job_id: null, net: 500 })),
      ...[1, 2, 3].map(() => mk({ cause_code: "ordering", job_id: null, net: 200 })),
      ...[1, 2, 3].map(() => mk({ cause_code: "install", job_id: null, net: 100 })),
    ];
    const flags = findMistakePatterns(base(ms, { responsible: new Map(ms.map((m) => [m.id, "p1"])) }));
    expect(flags.some((f) => f.kind === "person")).toBe(true);
    const d = summariseDigestPatterns(flags);
    expect(d.count).toBe(4);
    expect(d.top.map((t) => t.title)).toEqual(["Category: Rework", "Cause: Ordering", "Cause: install"]);
    expect(JSON.stringify(d)).not.toContain("Brodie");
  });

  it("puts the line in the email text and HTML", () => {
    const email = buildDigest({
      appUrl: "https://app.test",
      unallocated: { count: 0, total: 0, bills: [] },
      coverage: [],
      overdue: { total: 0, count: 0, top: [] },
      awaitingInvoice: { count: 0, oldest: [] },
      mistakes: { newThisWeek: 1, open: 2, openRecoverable: 0, patterns: { count: 2, top: [{ title: "Supplier: Reece", rule: "2 times in the last 90 days", net: 350 }] } },
    });
    expect(email.text).toContain("2 patterns to look at:");
    expect(email.text).toContain("Supplier: Reece — 2 times in the last 90 days, $350 so far");
    expect(email.html).toContain("2 patterns to look at");
  });
});
