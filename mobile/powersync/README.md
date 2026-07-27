# PowerSync sync rules — design + security contract (MP3)

**The deployable artifact is `sync-streams.yaml`** — the live PowerSync Cloud
instance (project mellerick / Development) runs **Sync Streams edition 3**, not
legacy Sync Rules. `sync-rules.yaml` is the legacy-dialect version, kept for
reference; both encode the same money contract below.

**The client IS wired (2026-07-27) and the instance is LIVE** — streams v2
deployed, replication slot active. Reads serve from the device mirror through
`lib/data/reads/source.ts` (`fromLocalOr`: per-call fallback to byte-identical
Supabase bodies); PowerSync is **read-only** on the device (`uploadData` is a
tripwire — every write stays on the outbox). The device schema is **generated**:
`node mobile/scripts/generate-powersync-schema.mjs` (from the deployed streams ×
the live database); `lib/powersync/schema.test.ts` enforces the money contract
in CI. See DECISIONS-FOR-AVI.md D89–D92 for the dialect rules the live
validator actually enforces (no literal IN-lists; JOIN-on-auth.user_id() gate).

Password rotation for `powersync_role`: `pwsh -File scripts\set-powersync-password.ps1`
(add `-Show` when the dashboard is open on a different computer — see the script
header). Never commit or display the password; rotate on any suspected exposure.

## Syntax validation — done, and the first draft was WRONG

Checked against the official docs (`docs.powersync.com/usage/sync-rules`,
`.../data-queries`, `.../operators-and-functions`). The original draft of
`sync-rules.yaml` **would have been rejected**. Legacy Sync Rules support none of:

> "Subqueries, JOINs, CTEs, aggregation, sorting, or set operations" — and no
> scalar subqueries.

The first draft used all of: `WHERE job_id IN (SELECT id FROM jobs WHERE …)` for
child tables, and a scalar subquery (`WHERE (SELECT role FROM profiles …) =
'technician'`) for the role gate. It also broke the hard rule that **every data
query must use every bucket parameter**.

**Rewritten to the documented pattern:** the *parameter* query returns the parent
row ids (one bucket per assigned job) and every data query filters on
`bucket.job_id`. Confirmed supported: `bucket_definitions` root, parameter
queries that read a table (`SELECT id as job_id FROM jobs WHERE assigned_to =
request.user_id()`), and `bucket.<param>` references in data queries.

### Role gate — RESOLVED (table-backed, not a JWT claim)

Gated with PowerSync's documented **"No Output Columns"** parameter query — a
parameter query selecting nothing, whose only job is deciding whether the bucket
syncs to this user. Zero output columns means zero bucket parameters, so the
"every data query must use every bucket parameter" rule is vacuous and whole-table
`SELECT *` queries are legal. PowerSync ships this exact shape as its
`global_admins` reference example.

```yaml
office_admin_business:
  parameters: |
      SELECT FROM profiles WHERE
         profiles.id = request.user_id() AND
         profiles.role IN ('office', 'admin')
  data:
    - SELECT * FROM invoices
    # …
```

**Why the table and not a JWT custom claim** (the option originally chosen, then
reversed on evidence): PowerSync's docs note that gating on a source-database row
means *"access can instantly be revoked"*. A claim cannot be re-read from an
already-issued token, so with `jwt_expiry = 3600` a demoted technician would keep
syncing financial data to their device for up to **an hour**. The table gate also
avoids a custom access token hook entirely — a malformed hook runs on every token
issuance and can block all logins.

**Fail-closed:** no profiles row, or a NULL/`technician` role → the WHERE matches
nothing → the bucket is never created → nothing syncs. There is no path where a
missing or unknown role leaks money.

**RLS remains the authority.** This is defence-in-depth; migrations 0027 / 0035 /
0038 are what actually enforce the boundary — and they are now **APPLIED in
production**.

> The money-column contract below is **authoritative** and must not be weakened —
> it is the same boundary as the RLS migrations (0027 + proposed 0035 / 0038).

## Why the sync path is a second authorization surface
PowerSync replicates Postgres rows into **plaintext SQLite on the device**,
bypassing the app's UI money-gating (`MoneyText`), the role-gated routes, and the
read-repository layer. So a dollar figure is kept off a technician's phone only if
BOTH hold: (a) row-level RLS (0035) denies the technician the money tables, and
(b) the per-column `SELECT`s in the technician bucket omit every money column.
Belt **and** braces — either alone is insufficient.

## Money-column contract (authoritative)

### Technician bucket — NEVER sync these tables at all
`invoices`, `invoice_items`, `quotes`, `quote_items`, `job_items`,
`pricing_items`, `job_expenses`, `equipment_expenses`, `inventory` (cost/sell),
`staff_cost_profiles`, `billing_rate_config`, `purchase_orders` (total_value),
`po_cost_centers` (allocated_amount), `xero_tokens`, `google_tokens`,
`cost_center_templates`. (These are exactly the tables 0027 + 0035 lock to
office/admin.)

### Technician bucket — sync these, but with money columns STRIPPED
| Table | Synced columns | OMITTED (money) |
|---|---|---|
| `job_variations` | id, job_id, variation_type_id, custom_name, description, quantity, unit, status, photo_storage_path, logged_by, logged_at | **rate, total_amount, admin_notes** |
| `variation_types` | id, name, unit, auto_approve, is_active | **rate** |
| `equipment` (only if a tech ever needs it — currently NOT in the tech bucket) | id, name, category, registration | purchase_cost, insurance_annual, maintenance_annual, registration_annual, other_annual_costs, fuel_cost_per_hour, estimated_life_years, target_hours_per_year |

### Technician bucket — safe as-is (no money columns)
`jobs`, `job_photos`, `time_entries` (hours only), `backflow_devices`,
`backflow_tests`, `customers`, `sites`, `profiles` (id/name/role).

### Office/admin bucket
Full rows of the business tables (they are authorised to see money; RLS is the
backstop). **Payroll** tables (`staff_cost_profiles`, `billing_rate_config`) are
**admin-only** — split them into a separate `admin_payroll` bucket gated on
`role = 'admin'` when implementing, rather than including them in the office set.

## Role-impersonation test (the parity check — MP3 DoD)

> ✅ **VERIFIED AGAINST THE LIVE SERVICE — 2026-07-27**, via the dashboard's
> Sync Diagnostics Client with real identities (dev tokens; read-only):
> **technician** `1720afed-…` → 6 money-free tables only (customers 138,
> sites 519, profiles 6, variation_types 2 **without the `rate` column**,
> backflow 1+1); office buckets synced ZERO rows and no money table exists
> client-side; `tech_jobs` correctly parameterized on their UUID.
> **admin** `3d9d69ad-…` → the full 18-table business set (jobs 825,
> job_photos 9,714, invoices/items/expenses/POs/cost-centres present),
> 11,257 rows / 30 buckets. Development tokens were enabled on the instance
> for this check (Client Auth toggle) — disable there if unwanted.
Mirror the RLS role-impersonation test (`supabase/tests/0035_…`). Against a
PowerSync test instance, for a **technician** token assert:
1. Every table in the "NEVER sync" list yields **zero rows** in the device DB.
2. For each rate-stripped table, the **columns** present in the device schema do
   **not** include any money column (`rate`, `total_amount`, `unit_cost`,
   `unit_sell`, `purchase_cost`, `allocated_amount`, `total_value`, `amount`,
   `gst_amount`, `admin_notes`). This is the sync-path equivalent of the app's
   `MoneyText`/route-gating unit tests and the `.maestro/` money-gating flow.
3. A technician only receives rows for jobs where `assigned_to = them` (+ their
   own time entries / backflow tests).

For **office/admin**, assert the broader set is present and correctly scoped.

## Setup status

**Supabase side — DONE and verified in production (2026-07-27):**
- `wal_level = logical` ✅
- `powersync` publication ✅ — **scoped to the 24 tables the sync rules reference**
  (migration `0039`). It was `FOR ALL TABLES` (68), which would have streamed
  `xero_tokens` / `google_tokens` (live OAuth tokens), `staff_cost_profiles`,
  `billing_rate_config`, `staff_leave` and `device_tokens` into PowerSync's cloud
  service. Sync rules gate *devices*; the publication gates *the service*. Now
  excluded — verified `secrets_still_published = NONE`.
- `powersync_role` ✅ — has REPLICATION, USAGE on `public`, and SELECT on all 24.
- RLS pre-req ✅ — `0035` / `0038` applied AND role-impersonation verified
  (technician denied on every money table; money-free views still readable).

⚠️ **Keep the publication in sync with `sync-streams.yaml`.** Add a table to a
stream and you must `alter publication powersync add table <t>;` or it silently
never syncs — then regenerate the schema
(`node mobile/scripts/generate-powersync-schema.mjs`).

**PowerSync side — DONE (2026-07-27):** Cloud instance live ("Use Supabase Auth"
enabled), streams v2 deployed and dashboard-validated, replication slot active,
client wired: connector + serialized provider + `fromLocalOr` seam; 13 read
modules converted or documented Supabase-only; jobs extracted from screens.
`@powersync/attachments` deliberately dropped (D90 — reads-only architecture;
photos stay on the outbox → Storage).

**Still required (needs hardware):** the on-device role-impersonation pass above
via a custom dev client (`npx expo run:android` — Expo Go cannot load
op-sqlite), plus the serialization/ordering spot-checks listed in D89–D92's
design notes.
