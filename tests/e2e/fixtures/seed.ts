import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ============================================================================
// Item 3.18 — the fixtures that let the e2e tier test more than a redirect.
//
// The suite could only assert "unauthenticated /dashboard redirects to /login"
// because CI's stack has no seed: `supabase start` applies the whole migration
// history to an EMPTY database, so there was no user to sign in as and nothing
// to look at.
//
// WHY THIS TIER IS WORTH THE TROUBLE. Every other real-database check in this
// repo runs SQL directly — supabase/tests/*.sql under psql, including the RLS
// impersonation suite and the money-boundary sweep. None of them execute a line
// of the app's TypeScript. So an app that sends a column the database does not
// have, or ignores an { error } the database DID return, passes all of them.
// That is the shape of the ready_to_invoice bug and of every unchecked-mutation
// bug found this session. The browser is the only place the query builder, the
// session cookies, RLS and the rendering meet.
//
// ---------------------------------------------------------------------------
// NO PASSWORD IS STORED ANYWHERE.
// ---------------------------------------------------------------------------
// Passwords are generated at run time by global-setup.ts, used once to sign in
// through the real login form, and discarded when that process exits. What the
// tests receive is a Playwright storageState file, not a credential. Nothing in
// the repository, and nothing that survives the run, can authenticate anything.
//
// The accounts themselves live only inside the ephemeral stack `supabase start`
// creates and `supabase stop` destroys.
//
// assertLocalStack() is what keeps that true, and it is the most important
// function in this file: it refuses to run unless NEXT_PUBLIC_SUPABASE_URL is a
// loopback address, so pointing the fixtures at a hosted project — by a stray
// .env, a copied command, or a CI variable set on the wrong environment — fails
// immediately instead of creating real users and writing real rows.
// ============================================================================

/**
 * Hosts a throwaway stack can legitimately live on.
 *
 * Loopback covers `supabase start` on the developer's own machine. The private
 * ranges cover the case where Docker itself is remote — a homelab box, a cloud
 * VM reached over a private tunnel — where the stack is still ephemeral but the
 * URL is not 127.0.0.1. 100.64.0.0/10 is the CGNAT range Tailscale allocates
 * from, and is included for that reason.
 *
 * The rule is deliberately an allow-list of PRIVATE addresses rather than a
 * deny-list of known-production hostnames. A deny-list has to anticipate every
 * spelling of every hosted project; this only has to know what "not routable
 * from the internet" looks like, and a hosted Supabase project can never match
 * it.
 */
const PRIVATE_HOST =
  /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+)(:\d+)?(\/|$)/;

/** Emails only. The secret half is generated per run and never written down. */
export const OFFICE_EMAIL = "e2e-office@mellerick.invalid";
export const TECH_EMAIL = "e2e-tech@mellerick.invalid";

/**
 * A money figure no other fixture or UI string can produce.
 *
 * The technician money check asserts this exact number is absent from the page
 * and the office check asserts it is present. A generic "contains no $" would
 * pass on a page that failed to render at all; a sentinel the office CAN see
 * proves the test is looking at something.
 */
export const SENTINEL_RATE = 987.65;

export type SeedUser = { email: string; secret: string; fullName: string; role: "office" | "technician" };

export type SeedResult = {
  officeId: string;
  techId: string;
  customerId: string;
  siteId: string;
  /** Assigned to the technician — what /dashboard/my-jobs must show. */
  jobId: string;
  jobTitle: string;
};

/** Throws unless the configured Supabase URL is a local stack. */
export function assertLocalStack(): { url: string; serviceKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  if (!PRIVATE_HOST.test(url)) {
    throw new Error(
      `E2E fixtures refuse to run against "${url || "(unset)"}". ` +
        `They create users and write rows, so the target must be a throwaway stack on a ` +
        `private address (loopback, 10/8, 172.16/12, 192.168/16, or 100.64/10). ` +
        `Start one with \`supabase start\` and export NEXT_PUBLIC_SUPABASE_URL from ` +
        `\`supabase status -o env\`.`
    );
  }
  if (!serviceKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required to seed the local stack.");
  }
  return { url, serviceKey };
}

export function adminClient(): SupabaseClient {
  const { url, serviceKey } = assertLocalStack();
  return createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

/**
 * Create (or reset) a user and force its profile role.
 *
 * `handle_new_user` (migration 0044) deliberately IGNORES self-supplied role
 * metadata and makes every non-invited signup a technician, so the role has to
 * be set afterwards with the service-role key — which
 * `prevent_unauthorised_role_change` permits precisely because service_role is
 * one of the two callers it trusts. Seeding therefore exercises both of 0044's
 * guards rather than working around them.
 *
 * If the account already exists from an earlier run against the same stack, its
 * password is reset to this run's generated one; the previous one is not stored
 * anywhere and cannot be recovered.
 */
export async function upsertUser(admin: SupabaseClient, user: SeedUser): Promise<string> {
  const created = await admin.auth.admin.createUser({
    email: user.email,
    password: user.secret,
    email_confirm: true,
    user_metadata: { full_name: user.fullName },
  });

  let id = created.data.user?.id;
  if (!id) {
    const { data, error } = await admin.auth.admin.listUsers({ perPage: 200 });
    if (error) throw new Error(`could not list users: ${error.message}`);
    id = data.users.find((u) => u.email === user.email)?.id;
    if (!id) throw new Error(`could not create or find ${user.email}: ${created.error?.message}`);
    const reset = await admin.auth.admin.updateUserById(id, { password: user.secret });
    if (reset.error) throw new Error(`could not reset ${user.email}: ${reset.error.message}`);
  }

  const { error } = await admin
    .from("profiles")
    .update({ role: user.role, full_name: user.fullName, is_active: true })
    .eq("id", id);
  if (error) throw new Error(`could not set ${user.email} role to ${user.role}: ${error.message}`);

  return id;
}

/**
 * Bring the local stack to a known state.
 *
 * Idempotent, because `supabase start` reuses a running stack and the suite is
 * run more than once. Every write is checked — an unchecked fixture write would
 * produce exactly the "reports success while doing nothing" failure this whole
 * tier exists to detect, except it would make the TESTS lie rather than the app.
 */
export async function seed(office: SeedUser, tech: SeedUser): Promise<SeedResult> {
  const admin = adminClient();

  const officeId = await upsertUser(admin, office);
  const techId = await upsertUser(admin, tech);

  const customerId = await upsertRow(admin, "customers", { name: "E2E Customer" }, { name: "E2E Customer" });
  const siteId = await upsertRow(
    admin,
    "sites",
    { name: "E2E Site" },
    {
      customer_id: customerId,
      name: "E2E Site",
      address_line1: "1 Test Street",
      suburb: "Testville",
      state: "VIC",
      postcode: "3000",
    }
  );

  const jobTitle = "E2E assigned job";
  const jobId = await upsertRow(
    admin,
    "jobs",
    { title: jobTitle },
    {
      title: jobTitle,
      customer_id: customerId,
      site_id: siteId,
      assigned_to: techId,
      status: "scheduled",
      created_by: officeId,
      scheduled_start: "2026-08-12T08:00:00.000Z",
      scheduled_end: "2026-08-12T09:00:00.000Z",
    }
  );

  // A money row on that job. The technician must never see SENTINEL_RATE; the
  // office must. Both halves are asserted, so neither can pass vacuously.
  // THE RATE HAS TO LIVE ON THE TYPE, not on the variation.
  //
  // job_variations has a BEFORE INSERT trigger, apply_variation_pricing
  // (migration 0028:59-98), which for an auto_approve preset DISCARDS whatever
  // rate the client sent and re-prices the row from the variation TYPE:
  //
  //     new.rate         := vt_rate;
  //     new.total_amount := round(quantity * vt_rate, 2);
  //
  // Triggers fire for service_role — only RLS is bypassed. So seeding the
  // variation with rate 987.65 while the type had the default 0 meant the
  // sentinel was overwritten with 0.00 before it ever landed, and the number
  // existed NOWHERE in the database. The technician assertion
  // `expect(body).not.toContain("987.65")` therefore passed for the emptiest
  // possible reason, and the office control could not find it because there
  // was nothing to find. That is what the fixme on the office test was really
  // about; it was not a selector problem.
  const variationTypeId = await upsertRow(
    admin,
    "variation_types",
    { name: "E2E Variation" },
    { name: "E2E Variation", unit: "hour", rate: SENTINEL_RATE, auto_approve: true }
  );

  // upsertRow returns early when the row already exists, so a stack that ran an
  // earlier version of this file still holds the 0.00 type. Force the rate.
  const rateFix = await admin
    .from("variation_types")
    .update({ rate: SENTINEL_RATE, auto_approve: true })
    .eq("id", variationTypeId);
  if (rateFix.error) throw new Error(`could not set the sentinel rate: ${rateFix.error.message}`);

  const existing = await admin.from("job_variations").select("id").eq("job_id", jobId).maybeSingle();
  if (existing.error) throw new Error(`could not read job_variations: ${existing.error.message}`);
  if (!existing.data) {
    const { error } = await admin.from("job_variations").insert({
      job_id: jobId,
      variation_type_id: variationTypeId,
      description: "E2E money sentinel",
      quantity: 1,
      // rate, total_amount and status are NOT set here on purpose: the trigger
      // overwrites all three from the variation type. Setting them is what made
      // this look seeded when it was not.
    });
    if (error) throw new Error(`could not seed job_variations: ${error.message}`);
  }

  return { officeId, techId, customerId, siteId, jobId, jobTitle };
}

/** Find a row by `match`, or insert `values`; returns its id. Always checked. */
async function upsertRow(
  admin: SupabaseClient,
  table: string,
  match: Record<string, unknown>,
  values: Record<string, unknown>
): Promise<string> {
  const found = await admin.from(table).select("id").match(match).maybeSingle();
  if (found.error) throw new Error(`could not read ${table}: ${found.error.message}`);
  if (found.data?.id) return found.data.id as string;

  const inserted = await admin.from(table).insert(values).select("id").single();
  if (inserted.error) throw new Error(`could not seed ${table}: ${inserted.error.message}`);
  return inserted.data.id as string;
}
