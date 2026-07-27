# PowerSync sync rules — design + security contract (MP3, PROPOSED)

`sync-rules.yaml` is a **starter** for the PowerSync integration (MP3), which is
blocked on a PowerSync Cloud instance + the Supabase replication password. It is
**not wired into the app** — the app today uses online reads + the durable
offline-write outbox; PowerSync would add true offline *reads*. A documented
fallback (persisted read-cache over the same read-repository layer) exists if
PowerSync's cost/fit doesn't work out.

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

### ⚠️ One open question — the office/admin role gate

A **global** bucket takes no parameters, so it can't be role-filtered; a
**parameterised** bucket requires every data query to use that parameter, which a
whole-table sync can't do. Pick one before deploying that bucket:

1. **JWT custom claim** (preferred) — put the app role in the token via a
   Supabase Auth Hook, gate with `request.jwt() ->> 'app_role'`. No extra query.
2. **Sync Streams** — PowerSync's newer mode, which *does* support subqueries,
   JOINs and CTEs. Would also let the technician bucket be expressed directly.
3. **RLS only** for that bucket — accepting the sync rules stop being
   defence-in-depth for office data.

Until one is chosen the `office_admin_business` bucket has **no role gate** and
would replicate money to every authenticated device, technicians included. It is
commented as the most dangerous line in the file.

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

## Setup checklist (when the account exists)
1. PowerSync Cloud instance (AU region) + a Supabase `powersync` publication +
   replication role + "Use Supabase Auth". Needs `SUPABASE_DB_URL`.
2. Apply RLS 0035 first (the row-level pre-req).
3. Load `sync-rules.yaml`, run the role-impersonation test above, iterate until a
   technician token receives zero money columns.
4. Wire the client (`@powersync/react-native`) behind the existing
   `lib/data/reads/` layer so screens don't change; add `@powersync/attachments`
   for photos/audio.
