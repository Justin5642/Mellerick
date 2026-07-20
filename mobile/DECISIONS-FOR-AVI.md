# Mobile Build — Decision Log

Non-crucial questions/decisions indexed for the cleanup phase (MP11). Crucial items
are flagged to Avi in real time per the plan's crucial-flag protocol.

## Crucial blockers (flagged to Avi, block specific phases)

| # | Item | Blocks |
|---|---|---|
| B1 | `SUPABASE_DB_URL` (Postgres connection string) — needed to set up the PowerSync publication + connector | MP3 |
| B2 | PowerSync Cloud account (AU region) + monthly-cost approval | MP3 |
| B3 | Apple Developer ($99/yr) + Google Play Console ($25 once) accounts | MP10 store submission |
| B4 | Expo push credentials (APNs key / FCM) | MP9 push |

## Decisions made (with rationale)

| # | Decision | Why |
|---|---|---|
| D1 | Scope = full parity, all 15 areas, all roles (Avi-confirmed), native-redesigned (capability parity, not desktop pixel-clones) | Avi's explicit goal; both consensus models require native redesign of dense/desktop patterns |
| D2 | Offline = PowerSync (Avi-confirmed) despite the offline agent + gemini recommending a lighter outbox; PowerSync sync rules treated as security-reviewed code with role-impersonation tests | Avi's choice; guardrails mandatory because PowerSync bypasses RLS/views on the sync path |
| D3 | Dollar-leak RLS tightening (inventory/job_expenses/equipment/PO/cost_center_templates → office/admin) is MANDATORY and lands first (MP1) | Both models: UI hiding can't stop DB disclosure; PowerSync would replicate $ to tech phones otherwise |
| D4 | UI = NativeWind v4 (port web Tailwind tokens + badge-colors 1:1) + a new dark theme the web never built | Web-token reuse, team Tailwind familiarity, Expo-endorsed; premium via design system not framework |
| D5 | Icons switch Ionicons → lucide-react-native | Exact parity with the web icon set |
| D6 | Background auto-clock: foreground-only for early phases; background build in MP9 | Needs custom dev client; not required for first shippable |
| D7 | Branch mobile/full-parity off main; MP1 touches shared supabase/ → PR, coordinate with Jason (active on repo) | Avoid colliding with Jason's concurrent work |

## Open questions (resolve in cleanup MP11)

- Q1: `sync-calendar` API route currently posts with no Authorization header — confirm intended auth before mobile replays it offline.
- Q2: Confirm every mobile write target accepts a client-supplied UUID PK (no server-gen-only triggers) for idempotent offline replay.
- Q3: Backflow submit server-side dedupe (must not double-email the water authority on retry).
- Q4: Auth refresh-token lifetime across a long offline workday — confirm acceptable.
- Q5: Expo SDK: mobile/AGENTS.md says v57 but package.json pins SDK 54 — confirm target SDK.
