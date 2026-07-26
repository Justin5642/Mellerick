# Mellerick Mobile — Gap / Drift Analysis vs the Web App

Per-area comparison of the 15 web feature areas against the Expo mobile build,
by role. Produced by a 15-agent analysis (one per area) reading both codebases.
Companion to `HANDOVER-mobile.md` and `DECISIONS-FOR-AVI.md`.

**Headline:** viewing/read parity is near-complete across all 15 areas and the
technician offline-write core is done, but a meaningful slice of **office/admin
write workflows** is still missing — most importantly **Schedule is view-only
(no dispatch/reschedule)** and **Approvals is view-only (no approve→invoice /
send-back)**. So the app is broad and usable but **not at full parity**.

## Status by area

| Area | Mobile status | Biggest remaining gap(s) |
|---|---|---|
| Dashboard | **full-parity** | — (one cosmetic empty-state link) |
| Pricing | partial | reactivate deactivated items (med) |
| Inventory | partial | low-stock surfacing, margin display (low) |
| My Jobs | partial | tech: change status/notes + submit variation offline (med) |
| Customers | partial | Customer-360 detail w/ jobs/quotes/invoices + $ rollups (**high**) |
| Backflow | partial | offline-durable backflow writes (**high**) |
| Quotes | partial | convert-to-job (med); Send/PDF (ext) |
| Fleet | partial | assign equipment, equipment expenses/docs/usage (med ×4) |
| Staff | partial | leave log, charge-out rate (med); invite/email (ext) |
| Settings | partial | variation-types / cost-centre-template / account-code config (med/low) |
| Reports | partial | staff cost & efficiency table (**high**) + 4 analytics tables (med) |
| Jobs | partial | ~~reassign/reschedule~~ (D41), ~~status/priority edit~~ (D43); **create job**, edit customer/site/title/type, price+approve variations still open |
| Invoices | partial | prefill-from-job + add unbilled variations (**high ×2**); Send/PDF/Xero (ext) |
| Approvals | partial ✅ | ~~approve→auto-invoice, send-back~~ **DONE** (D40); Xero auto-push (ext) |
| Schedule | partial ✅ | ~~assign/unassign, reschedule~~ **DONE** (D41); day/week grid deferred |

## Prioritized in-repo remaining work (buildable without external gates)

**P1 — core office/admin workflows (highest impact):**
1. ~~**Approvals actions**~~ — **DONE (D40)**: approve→auto-draft-invoice (+ items, dup-guard) + Send-Back/reject with note + calendar resync. *(Xero auto-push on approve remains an external gate.)*
2. ~~**Schedule dispatch**~~ — **DONE (D41)**: reassign/unassign + reschedule (DST-safe, offline-durable, calendar resync). Day/week grid + drag-drop deferred (touch action sheet is the mobile equivalent).
3. **Jobs create + edit** — a create-job flow (title/customer/site/assignee/type/priority/schedule/notes) and edit of an existing job (reassign, reschedule, change customer/site/title/type); admin delete. Unlocks the Dashboard/Recent-Jobs "create" affordance too.
4. **Invoice-from-job (Q15)** — prefill invoice items from a linked job's `job_items` + add approved-but-unbilled variations and mark them billed + reset `ready_to_invoice`. Closes the reconciliation gap the generic builder leaves open.

**P2 — technician + field:**
5. **Backflow offline-durable writes** — route register-device / log-test / signature / authority-submit through the outbox (they're currently direct writes, so not offline-safe — the one place the tech app isn't fully offline).
6. **Tech job actions offline** — change job status/priority + edit description/notes; submit a variation with photo; upload/delete a job document — all via the outbox.
7. **Job equipment usage + PO/cost-centre editing** — log equipment usage on a job; create/edit POs + cost-centre stages; tag expenses to a stage.

**P3 — admin depth & polish:**
8. **Reports analytics tables** — staff cost & efficiency (admin), equipment cost & utilization, revenue-by-month trend, top customers, jobs-by-staff. (Charts can be pure `react-native-svg`, no Skia dep needed.)
9. **Customer-360 detail** — related jobs/quotes/invoices + counts + total-invoiced/outstanding rollups; active/inactive lifecycle; favourites.
10. **Fleet depth** — assign equipment, equipment expenses/documents/usage, equipment detail screen.
11. **Staff depth** — leave log, charge-out rate override, loaded-rate summary.
12. **Settings management** — variation types, cost-centre templates, Xero account codes, manual sync triggers.
13. **Quotes convert-to-job**, **Pricing reactivate**, **Inventory low-stock**, small list-parity items.

## External gates (NOT closable in-repo)

- **Invoice/Quote Send-email, PDF view/download, Xero push** — the web API routes are cookie-only and reject a mobile Bearer token → **backend refactor (Jason)**.
- **Staff invite / resend / edit-login-email** — Supabase auth-admin onboarding.
- **Integration OAuth connect/reconnect** (Xero, Google) — browser redirect flow.
- **On-device QA, store accounts, push credentials, PowerSync password** — hardware/accounts.

## What IS at parity (done)

Dashboard (full); all list/detail **reads** across the 15 areas; technician
offline-write core (time / photos / notes / signature / voice); role-aware nav
with structural money-gating (`MoneyText`); Quotes & Invoices **create/edit
builders**; Pricing/Inventory/Fleet CRUD; **expense capture w/ receipt**; office
**Backflow list**; admin **job costing/profitability**.
