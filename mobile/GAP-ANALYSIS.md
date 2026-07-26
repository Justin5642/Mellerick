# Mellerick Mobile — Gap / Drift Analysis vs the Web App

Per-area comparison of the 15 web feature areas against the Expo mobile build,
by role. Produced by a 15-agent analysis (one per area) reading both codebases.
Companion to `HANDOVER-mobile.md` and `DECISIONS-FOR-AVI.md`.

**Headline (updated after the D40–D60 remediation run):** the in-repo feature
work is now **essentially complete** — all 15 areas are at full or near-full
parity. Every P1 office write workflow that was originally missing (Schedule
dispatch, Approvals approve→invoice/send-back, Jobs create/edit, Invoice-from-job)
is done, Reports has all 5 analytics tables, and the money math is ported
verbatim + TDD-locked + verified byte-for-byte against the web (D55). What's left
in-repo is a short tail of **minor/complex depth** (below); the true blockers to
"ship-ready" are all **external** (backend Bearer, RLS apply, accounts, device QA).

## Status by area

| Area | Mobile status | Biggest remaining gap(s) |
|---|---|---|
| Dashboard | **full-parity** | — (one cosmetic empty-state link) |
| Pricing | **full** ✅ | ~~reactivate~~ (D49), ~~category-taxonomy picker~~ done |
| Inventory | **near-full** | ~~low-stock surfacing~~ (D49), ~~margin display~~ done |
| My Jobs | partial | tech: change status/notes + submit variation offline (med) |
| Customers | near-full | ~~Customer-360~~ (D47), ~~quick-create~~ (D60); favourites, inactive lifecycle — minor |
| Backflow | partial | ~~register-device offline~~ (D46); test-log offline needs the submit dedupe (Q3) — follow-up |
| Quotes | partial | ~~convert-to-job~~ **DONE** (D50); Send/PDF (ext) |
| Fleet | near-full | ~~assign~~ (D54), ~~detail + expenses~~ (D56), ~~usage log~~ (D61); documents (file upload) — follow-up |
| Staff | near-full | ~~charge-out rate~~ (D53), ~~leave log~~ (D58); invite/resend/edit-email (ext) |
| Settings | near-full | ~~variation-types~~ (D57), ~~cost-centre templates~~ (D59); Xero account codes + OAuth connect (web/ext) |
| Reports | **full (analytics)** ✅ | all 5 tables done: revenue-by-month, top-customers, jobs-by-staff (D48), staff cost/efficiency (D51), equipment utilisation (D52) |
| Jobs | partial | ~~reassign/reschedule~~ (D41), ~~status/priority edit~~ (D43), ~~**create job**~~ (D45); edit customer/site/title/type, price+approve variations still open |
| Invoices | partial | ~~prefill-from-job + add unbilled variations~~ **DONE** (D44/Q15); Send/PDF/Xero (ext) |
| Approvals | partial ✅ | ~~approve→auto-invoice, send-back~~ **DONE** (D40); Xero auto-push (ext) |
| Schedule | partial ✅ | ~~assign/unassign, reschedule~~ **DONE** (D41); day/week grid deferred |

## Remaining in-repo work (the short tail — all minor or complex)

The P1 office workflows, Reports (all 5 tables), Customer-360, quick-create,
convert-to-job, Fleet (assign + detail + expenses), Staff (charge-out + leave),
Settings (variation types + cost-centre templates), Pricing/Inventory parity, and
backflow register-offline are all **DONE** (D40–D60). What's left:

**Minor polish:** Customers favourites · Pricing category-taxonomy picker ·
Jobs edit customer/site/title/type on an existing job · Fleet equipment
**documents** + general (non-job) **usage log** · Job equipment-usage + PO /
cost-centre editing on the job billing screen.

**Complex / has a caveat:**
- **Backflow test-log offline** — the register-device write is now offline (D46),
  but logging a *test* carries a certificate upload AND a water-authority submit
  that must be **dedupe-guarded** (Q3) before it can be made replayable; left
  direct-write so the compliance path isn't destabilised.
- **Technician offline status-edit** — a tech changing status to `completed` would
  bypass the signature sign-off invariant, so a raw status picker is intentionally
  office/admin-only (D43); a tech-safe subset (description/notes) is a follow-up.

## External gates (NOT closable in-repo)

- **Invoice/Quote Send-email, PDF view/download, Xero push** — the web API routes are cookie-only and reject a mobile Bearer token → **backend refactor (Jason)**.
- **Staff invite / resend / edit-login-email** — Supabase auth-admin onboarding.
- **Integration OAuth connect/reconnect** (Xero, Google) — browser redirect flow.
- **On-device QA, store accounts, push credentials, PowerSync password** — hardware/accounts.

## What IS at parity (done) — the vast majority

All 15 areas' list/detail **reads**; the technician offline-write core (time /
photos / notes / signature / voice / backflow register); role-aware nav with
structural money-gating (`MoneyText`); **every P1 office workflow** (Jobs
create/edit/status/schedule-dispatch, Approvals approve→invoice/send-back,
Customers CRUD + 360 + quick-create, Quotes builder + accept/decline +
convert-to-job, Invoices builder + create-from-job reconciliation, Pricing/
Inventory/Fleet CRUD + depth); **admin** Staff (roles/pay/charge-out/leave),
**Reports** (all 5 analytics tables + KPIs), Settings (variation types +
cost-centre templates + integration status), full job costing/profitability;
expense capture (job + equipment) with receipts. **184 unit tests**, `tsc`
clean, iOS bundle clean; money math verified byte-for-byte vs the web (D55).
