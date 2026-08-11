import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

import { adminClient, SENTINEL_RATE, type SeedResult } from "./fixtures/seed";
import { OFFICE_STATE, TECH_STATE, SEED_FILE } from "./fixtures/paths";

// ============================================================================
// Item 3.18 — the tier that runs the app's own TypeScript against real Postgres.
//
// Everything else in this repo that touches a real database runs SQL directly:
// supabase/tests/*.sql under psql, the RLS impersonation suite, the money
// boundary sweep. They are good, and they caught four real bugs this session,
// but not one of them executes a line of the app. An app that sends a column
// the database does not have, or ignores an { error } the database DID return,
// passes every one of them — and that is the shape of the ready_to_invoice bug
// and of every unchecked-mutation bug found this session.
//
// The 430-odd mocked unit tests cover the other end: they run the app's code
// against a fake that accepts anything, including columns that do not exist.
//
// This file is where the query builder, the session cookies, RLS, and the
// rendering meet. Assertions are on PERSISTED OUTCOMES read back with the
// service-role key, or on what a real browser actually displays — never on
// "the request was made".
// ============================================================================

/**
 * The seeded ids, read on first use rather than at import time.
 *
 * Playwright collects specs in a separate process BEFORE globalSetup runs, so
 * reading this at module scope makes `--list` — and any collection error
 * anywhere in the suite — fail with ENOENT instead of listing the tests.
 */
let cached: SeedResult | null = null;
function seeded(): SeedResult {
  if (!cached) cached = JSON.parse(readFileSync(SEED_FILE, "utf8")) as SeedResult;
  return cached;
}

test.describe("office session", () => {
  test.use({ storageState: OFFICE_STATE });

  test("the dashboard renders for a signed-in office user", async ({ page }) => {
    // The whole authenticated path in one assertion: cookies survive the
    // middleware refresh, the server client reads the session, RLS lets the
    // dashboard's queries through, and the page renders instead of bouncing to
    // /login. When this breaks, everything below is noise.
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole("main")).toBeVisible();
  });

  test("office is NOT redirected away from an office-only route", async ({ page }) => {
    // The control for the technician gating test below. Without it, that test
    // would also pass if middleware redirected EVERYONE, which is a broken app
    // and a green suite.
    await page.goto("/dashboard/invoices");
    await expect(page).toHaveURL(/\/dashboard\/invoices$/);
  });

  test("creating a job through the UI actually persists it", async ({ page }) => {
    // The defect class this repo keeps producing is a write that reports
    // success while doing nothing, so the assertion is the ROW, read back with
    // a separate service-role client — not the toast, and not the redirect.
    const title = `E2E created ${Date.now()}`;

    await page.goto("/dashboard/jobs/new");
    await page.locator("#title").fill(title);

    // CustomerPicker is a search Input plus a list of `role="button"` rows —
    // not a <select>, and its Label has no htmlFor, so getByLabel does not
    // reach it. Drive it the way a user does: focus, type, click the row.
    await page.getByPlaceholder("Search customers...").click();
    await page.getByPlaceholder("Search customers...").fill("E2E Customer");
    await page.getByRole("button", { name: /E2E Customer/ }).first().click();

    await page.getByRole("button", { name: "Create Job" }).click();

    // ANCHORED, and that `$` is the whole fix for a flake.
    //
    // This waited on /\/dashboard\/jobs(\/|$)/ — which the page it starts on,
    // /dashboard/jobs/new, ALREADY MATCHES. So waitForURL resolved immediately,
    // before the form had submitted, and the read below raced the insert. It
    // usually won and occasionally did not; CI recorded it as "flaky, passed on
    // retry", which is the least useful thing a test can be.
    //
    // The page navigates with window.location.href AFTER the insert resolves
    // (app/dashboard/jobs/new/page.tsx:96), so arriving at the list is genuine
    // evidence the row was written — but only if the wait cannot be satisfied
    // by the page we were already on.
    await page.waitForURL(/\/dashboard\/jobs$/, { timeout: 20_000 });

    const admin = adminClient();
    await expect
      .poll(
        async () => (await admin.from("jobs").select("title").eq("title", title).maybeSingle()).data?.title,
        { timeout: 10_000, message: `no jobs row with title ${title}` }
      )
      .toBe(title);
  });

  test("office CAN see the money the technician must not", async ({ page }) => {
    // Un-fixme'd, with the cause understood rather than guessed at.
    //
    // This failed three times and the fixme blamed an unknown selector. It was
    // not a selector. job_variations has a BEFORE INSERT trigger
    // (apply_variation_pricing, migration 0028) that re-prices every row from
    // the variation TYPE and discards whatever the client sent — so seeding the
    // variation with the sentinel while the type carried the default 0 meant
    // 987.65 never reached the database at all.
    //
    // Which also means the technician assertion below was passing for the
    // emptiest possible reason: the string existed nowhere in the system. This
    // control is what makes that one mean something, and it is the reason it
    // was written even though it is the office half of a technician test.
    await page.goto(`/dashboard/jobs/${seeded().jobId}?tab=variations`);

    // `.first()` because the office page shows the amount in FOUR places —
    // "1 unbilled variation · $987.65", the header total, the line total, and
    // "1 hour × $987.65 = $987.65" — and Playwright's strict mode refuses an
    // ambiguous locator. That ambiguity is the result being asserted: four
    // renderings of a number the technician must not see even once.
    await expect(page.getByText(String(SENTINEL_RATE), { exact: false }).first()).toBeVisible({
      timeout: 15_000,
    });
  });
});

test.describe("technician session", () => {
  test.use({ storageState: TECH_STATE });

  test("my-jobs shows the job assigned to this technician", async ({ page }) => {
    // Proves the real query builder — `.eq("assigned_to", user.id)` with a
    // `.not("status", "in", …)` filter — runs against real Postgres under real
    // RLS and returns the row. A mock would have accepted any of it.
    await page.goto("/dashboard/my-jobs");
    await expect(page.getByText(seeded().jobTitle)).toBeVisible({ timeout: 15_000 });
  });

  test("an office-only route redirects to my-jobs", async ({ page }) => {
    // middleware.ts, which until now had unit tests only. A technician who can
    // reach /dashboard/invoices is not a cosmetic problem.
    await page.goto("/dashboard/invoices");
    await expect(page).toHaveURL(/\/dashboard\/my-jobs$/);
  });

  test("no dollar figure from the job reaches a technician's screen", async ({ page }) => {
    // The last layer of the four-layer money boundary, and the only one that
    // was never checked through a browser. The first three are RLS policies,
    // the rate-stripped views, and the sync-stream column lists — all verified
    // in SQL. None of them can prove the RENDERED page is clean.
    // Same tab the office test asserts the number IS on. Checking the
    // technician against a page that never renders money would prove nothing.
    await page.goto(`/dashboard/jobs/${seeded().jobId}?tab=variations`);
    await expect(page.getByText(seeded().jobTitle).first()).toBeVisible({ timeout: 15_000 });

    // Assert on the whole document, not a component: the point is that the
    // number is nowhere, including in a tab that has not been opened, a title
    // attribute, or a script payload Next inlined for hydration.
    // A THIRD run taught the next thing: the technician cannot see the
    // variation's DESCRIPTION either, so asserting the row is on screen fails
    // for them. That is consistent with migration 0028 withholding variation
    // pricing from technicians rather than merely blanking the amount — the
    // row is not theirs to see at all.
    //
    // Non-vacuity therefore rests on the job title above: the page loaded, this
    // job rendered, and the number is not in it. What remains unproven is that
    // a technician was denied something an office user IS shown; see the fixme
    // above.

    const body = await page.locator("body").innerText();
    expect(body).not.toContain(String(SENTINEL_RATE));

    const html = await page.content();
    expect(html).not.toContain(String(SENTINEL_RATE));
  });
});
