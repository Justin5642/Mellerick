# PowerSync sync rules — design + security contract (MP3, PROPOSED)

`sync-rules.yaml` is a **starter** for the PowerSync integration (MP3), which is
blocked on a PowerSync Cloud instance + the Supabase replication password. It is
**not wired into the app** — the app today uses online reads + the durable
offline-write outbox; PowerSync would add true offline *reads*. A documented
fallback (persisted read-cache over the same read-repository layer) exists if
PowerSync's cost/fit doesn't work out.

> **Two things need validation before deploy** (do not deploy unreviewed):
> 1. The PowerSync **YAML syntax** — the parameter-query form and whether
>    `WHERE … IN (SELECT …)` subqueries are supported in data queries on the
>    target PowerSync version. Read the versioned PowerSync sync-rules docs and
>    test against the instance; the bucket **shapes** may need to be expressed as
>    parameter lists instead of inline subqueries.
> 2. The **role parameter query** — this assumes PowerSync can run a parameter
>    query that reads `profiles.role` for `request.user_id()`. Confirm that, or
>    move the app role into a JWT custom claim (Supabase Auth hook) and read it
>    via `request.jwt()`.
>
> What is **authoritative** and must NOT be weakened is the money-column contract
> below — it is the same boundary as the RLS migrations (0027 + proposed 0035).

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
