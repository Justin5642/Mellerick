# Mellerick Mobile — Gap / Drift Analysis vs the Web App

Per-area comparison of the 15 web feature areas against the Expo mobile build,
by role. Produced by a 15-agent analysis (one per area) reading both codebases.
Companion to `HANDOVER-mobile.md` and `DECISIONS-FOR-AVI.md`.

**Headline (updated after the D40–D68 run):** the in-repo feature work is now
**complete** — every one of the 15 areas is either at **full parity** or has only
work that is genuinely **out of repo scope**: an external backend gate (Send-email
/ PDF / Xero via the cookie-only routes → Jason's Bearer refactor; Staff invite via
auth-admin; integration OAuth), a native-module deferral (document *upload* needs a
file/PDF picker that can't be device-QA'd here), or the one **flagged crucial
decision** (Q3 — backflow test-submit dedupe, so the compliance email can't
double-send on replay). The full **technician offline-write core** (time / photos /
notes / signature / voice / variations / backflow register) is uniformly
outbox-backed (D68); every P1 office workflow is done; Reports has all 5 analytics
tables; and the money math is ported verbatim + TDD-locked + verified byte-for-byte
against the web (D55, re-verified D66). The true blockers to a **shippable build**
remain **external**: backend Bearer refactor, RLS migration 0035 apply, store/push
accounts, PowerSync password, on-device QA.

## Status by area

| Area | Mobile status | Biggest remaining gap(s) |
|---|---|---|
| Dashboard | **full-parity** | — (one cosmetic empty-state link) |
| Pricing | **full** ✅ | ~~reactivate~~ (D49), ~~category-taxonomy picker~~ done |
| Inventory | **full** ✅ | ~~low-stock surfacing~~ (D49), ~~margin display~~ done |
| My Jobs | **full** ✅ | ~~submit variation offline~~ (D68); notes already outbox-backed; tech status is clock-in/sign-off-driven by design (D43) |
| Customers | **full** ✅ | ~~Customer-360~~ (D47), ~~quick-create~~ (D60), ~~favourites~~ (D62); inactive lifecycle handled via deactivate |
| Backflow | full (in-repo) ✅ | ~~register-device offline~~ (D46); test-log offline is **blocked on Q3** (water-authority submit dedupe) — flagged crucial, not deferrable in-repo |
| Quotes | full (in-repo) ✅ | ~~convert-to-job~~ (D50); Send/PDF are the **external** Bearer gate |
| Fleet | **full** ✅ | ~~assign~~ (D54), ~~detail + expenses~~ (D56), ~~usage log~~ (D61), ~~documents view/open~~ (D67); document *upload* stays a web action (matches job docs) |
| Staff | near-full | ~~charge-out rate~~ (D53), ~~leave log~~ (D58); invite/resend/edit-email (ext) |
| Settings | near-full | ~~variation-types~~ (D57), ~~cost-centre templates~~ (D59); Xero account codes + OAuth connect (web/ext) |
| Reports | **full (analytics)** ✅ | all 5 tables done: revenue-by-month, top-customers, jobs-by-staff (D48), staff cost/efficiency (D51), equipment utilisation (D52) |
| Jobs | **full** ✅ | ~~reassign/reschedule~~ (D41), ~~status/priority edit~~ (D43), ~~**create job**~~ (D45), ~~equipment-usage~~ (D63), ~~title/type/description edit~~ (D64), ~~price+approve variations~~ (D65); customer/site reassignment left to web |
| Invoices | partial | ~~prefill-from-job + add unbilled variations~~ **DONE** (D44/Q15); Send/PDF/Xero (ext) |
| Approvals | partial ✅ | ~~approve→auto-invoice, send-back~~ **DONE** (D40); Xero auto-push (ext) |
| Schedule | partial ✅ | ~~assign/unassign, reschedule~~ **DONE** (D41); day/week grid deferred |

## Remaining in-repo work — NONE closable without a crucial decision or a native dep

All P1 office workflows, Reports (all 5 tables), Customer-360 / quick-create /
favourites, convert-to-job, Fleet (assign + detail + expenses + usage + documents),
Staff (charge-out + leave), Settings (variation types + cost-centre templates),
Pricing/Inventory parity, backflow register-offline, job equipment-usage, job
title/type/description edit, **variation price+approve**, and the **offline tech
variation submit** are all **DONE** (D40–D68). What is *not* done is, in every case,
out of in-repo scope:

**Blocked on a flagged crucial decision:**
- **Backflow test-log offline (Q3)** — the register-device write is offline (D46),
  but logging a *test* carries a certificate upload AND a water-authority **submit**
  that must be **dedupe-guarded server-side** before it can be safely replayed;
  left direct-write (online) so a retry can't double-email the authority. Needs
  Avi/Jason to confirm the dedupe contract — the one genuinely-open in-repo item.

**Deferred to web by design (native-module / dependent-field cascade):**
- Document **upload** (job + equipment *view/open* done, D67) — needs a native
  file/PDF picker that can't be device-QA'd in this environment.
- Jobs **customer/site reassignment** on an existing job (title/type/description
  editable D64) — clears the site + assignee and re-runs calendar sync; the web
  already handles that cascade.
- PO / cost-centre **editing** on the job billing screen (read + display done).

**Not a gap (intentional):**
- **Technician status-edit** — a tech setting `completed` would bypass the
  signature sign-off invariant, so status stays clock-in/sign-off-driven (D43);
  notes are already offline-durable.

## External gates (NOT closable in-repo)

- **Invoice/Quote Send-email, PDF view/download, Xero push** — the web API routes are cookie-only and reject a mobile Bearer token → **backend refactor (Jason)**.
- **Staff invite / resend / edit-login-email** — Supabase auth-admin onboarding.
- **Integration OAuth connect/reconnect** (Xero, Google) — browser redirect flow.
- **On-device QA, store accounts, push credentials, PowerSync password** — hardware/accounts.

## What IS at parity (done) — the vast majority

All 15 areas' list/detail **reads**; the **full** technician offline-write core
(time / photos / notes / signature / voice / **variations** / backflow register —
all uniformly outbox-backed, D68); role-aware nav with structural money-gating
(`MoneyText`); **every P1 office workflow** (Jobs create/edit/status/type/
schedule-dispatch + **equipment-usage** + **variation price+approve**, Approvals
approve→invoice/send-back, Customers CRUD + 360 + quick-create + favourites, Quotes
builder + accept/decline + convert-to-job, Invoices builder + create-from-job
reconciliation, Pricing/Inventory/Fleet CRUD + full depth incl. equipment
documents); **admin** Staff (roles/pay/charge-out/leave), **Reports** (all 5
analytics tables + KPIs), Settings (variation types + cost-centre templates +
integration status), full job costing/profitability; expense capture (job +
equipment) with receipts. **195 unit tests**, `tsc` clean, iOS bundle clean; money
math verified byte-for-byte vs the web (D55, re-verified D66).
