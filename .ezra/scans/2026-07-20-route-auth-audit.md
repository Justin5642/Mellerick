# Route authorization audit — 2026-07-20

Full sweep of every `app/api/**` route handler, closing the consensus review's
caveat that guards must be applied *consistently* across all routes. Status
after Phase 2 + this audit.

| Route | Method | Authorization | Notes |
|---|---|---|---|
| ai/polish-note | POST | authenticated | via getAuthenticatedUserId helper |
| backflow/scan-data-plate | POST | authenticated | " |
| backflow/tests/[id]/certificate | GET | authenticated | read-only, all staff |
| backflow/tests/[id]/submit | POST | office/admin or tester | + email HTML escaped |
| geocode | GET | authenticated + rate-limit | was open proxy |
| google/auth | GET | **admin** | hardened this audit |
| google/callback | GET | **admin** | hardened this audit (token write) |
| google/disconnect | POST | admin | Phase 2 |
| google/poll-calendar | GET | CRON_SECRET | refactored to requireCronSecret |
| google/sync-now | POST | authenticated (inline) | pre-existing |
| invoices/[id]/pdf | GET | authenticated + RLS | session client |
| invoices/[id]/send | POST | authenticated (inline) | see follow-up |
| jobs/[id]/sync-billing | POST | office/admin or assigned tech | Phase 2 |
| jobs/[id]/sync-calendar | POST | authenticated | Phase 2 |
| jobs/[id]/transcribe-voice-report | POST | authenticated | pre-existing helper |
| quotes/[id]/pdf | GET | authenticated + RLS | session client |
| quotes/[id]/send | POST | authenticated (inline) | see follow-up |
| staff/invite | POST | admin (inline) | pre-existing, correct |
| staff/resend-invite | POST | admin (inline) | pre-existing |
| staff/update | POST | admin (inline) | pre-existing |
| time-entries/[id]/sync-billing | POST | office/admin or assigned tech | Phase 2 |
| xero/auth | GET | **admin** | hardened this audit |
| xero/callback | GET | **admin** | hardened this audit (token write) |
| xero/expense-account-code | POST | office/admin | Phase 2 |
| xero/poll-invoices | GET | CRON_SECRET | Phase 2 |
| xero/push-expense | POST | authenticated (inline) | see follow-up |
| xero/push-invoice | POST | admin (inline) | pre-existing, correct |
| xero/sales-account-code | POST | office/admin | Phase 2 |
| xero/sync-now | POST | authenticated (inline) | see follow-up |

## New finding closed this audit (account-takeover vector)
`xero/auth`, `google/auth` and their **callbacks** had NO authorization. The
callbacks delete the org's existing integration tokens and insert new ones. An
attacker completing an OAuth flow with their OWN Xero/Google account could
repoint the business's invoicing/calendar to their account — especially since
`xero_tokens` RLS is unverified (Phase 4). Fixed: `requireAdmin` on all four
(initiation + callback). Callbacks re-check because they can be hit directly
with a self-obtained OAuth code.

## Follow-ups (logged, not blocking — lower severity)
These are authenticated but not role-restricted; they mutate/read financial data
under the session client so RLS (migrations 0027/0028) is the backstop. Consider
tightening to office/admin in a later pass once Phase 4 confirms RLS is sound:
- xero/push-expense, xero/sync-now, google/sync-now
- invoices/[id]/send, quotes/[id]/send (send financial docs by email)

## Not applicable
- xero/callback & google/callback are provider redirects; admin gate via the
  browser session cookie is the correct control (state param alone is insufficient).
