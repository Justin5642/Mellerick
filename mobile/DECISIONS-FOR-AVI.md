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
| D8 | Build the offline write-outbox layer NOW (durable SQLite outbox + processor + repositories), behind a swappable data layer, and connect PowerSync later behind the same interfaces ("do both") | Avi asked for both; the outbox needs no browser/password so it unblocked progress while the PowerSync DB-password step (B1) is pending. Repositories are the only place table names live → PowerSync slots in without touching screens |
| D9 | `WriteOperation` carries a distinct operation-id (outbox PK) AND rowId (target row PK); side-effect coalescing adopts the latest trigger's `dependsOn` | Correctness: without the split, an offline clock-in (insert) + clock-out (update) to the same row collided on the store PK and lost the insert. Both fixed with regression tests |
| D10 | Offline read model (interim): reads refresh from the server only when online; offline, local state (incl. optimistic writes) is authoritative. **Consequence: offline COLD-START shows an empty time log until the first online load** — within-session offline writes are visible via optimistic rows | Full offline reads = the persisted read-cache (the other half of the outbox design) or PowerSync buckets, deferred. Keeps online UX identical to today and makes offline writes durable + visible without a half-built cache that could show stale/partial data |
| D11 | Parity: deleting a time entry and assigning a cost-center do NOT resync billing (matches the web app exactly) | Web's deleteEditing/assignCostCenter don't call syncBilling. Deleting an entry that contributed hours arguably should shrink the labour line item — flagged as Q6, a possible pre-existing web bug, not "fixed" unilaterally to preserve parity |
| D12 | Photo delete removes the Storage object BEST-EFFORT (never throws). Photos' outbox delete carries storage_path so cleanup works the instant a policy exists | **The `job-photos` Storage bucket has no DELETE policy** (only INSERT + SELECT). So `storage.remove()` is silently RLS-denied *today* in BOTH web and mobile — deleted photos' objects already orphan in the bucket; only the DB row is removed. If `removeObject` threw, every offline photo delete would wedge on retry. Fix = add a storage.objects DELETE policy for job-photos (touches shared `supabase/` → coordinate with Jason, see Q8) — then object cleanup starts working with zero mobile code change |
| D13 | Photo Storage object key derived from the client rowId (`${jobId}/${rowId}.jpg`), not `Date.now()_rand` as the old screen did | A stable key tied to the row makes offline replay idempotent — a retried upload hits the same object (upsert) and the same row re-inserts, so a flaky network can't scatter duplicate objects. Behaviourally invisible (storage_path is just an opaque key) |
| D14 | Queued attachments are copied into a durable app-documents dir (`outbox-attachments/`) before queueing, and deleted after the write syncs (gateway.cleanupAttachment) | Picker/camera files live in volatile cache the OS can purge before sync; copying guarantees the photo survives restarts. Cleanup-after-sync stops the dir growing without bound (kept on failure for retry) |
| D15 | Signature and Voice-report are SEPARATE compound verticals, NOT built in this Photos/Notes pass | Recon captured them fully: signature = job_photos insert (photo_type='signature', caption) + a `jobs` UPDATE (status=completed, ready_to_invoice, completion_notes, actual_end) + a `sync-calendar` side-effect; voice = `job-audio` upload + a `transcribe-voice-report` side-effect (effectively online-only). They cross into the `job` aggregate + calendar/transcribe side-effects and are the natural next vertical (job-completion). See Q9 |

## Open questions (resolve in cleanup MP11)

- Q1: `sync-calendar` API route currently posts with no Authorization header — confirm intended auth before mobile replays it offline.
- Q2: Confirm every mobile write target accepts a client-supplied UUID PK (no server-gen-only triggers) for idempotent offline replay.
- Q3: Backflow submit server-side dedupe (must not double-email the water authority on retry).
- Q4: Auth refresh-token lifetime across a long offline workday — confirm acceptable.
- Q5: Expo SDK: mobile/AGENTS.md says v57 but package.json pins SDK 54 — confirm target SDK.
- Q6: Web app does not resync billing when a time entry is deleted (or a cost-center is reassigned). Deleting a billed entry may leave a stale labour line item. Confirm intended, or fix in web + mobile together (see D11).
- Q7: Offline cold-start empty time log (D10) — acceptable interim, or prioritise the persisted read-cache / PowerSync buckets so previously-viewed jobs read offline too?
- Q8: Add a `storage.objects` DELETE policy for the `job-photos` bucket so deleted photos' files are actually removed (fixes a pre-existing orphaned-object leak in web too)? Touches shared `supabase/` → needs Jason coordination (see D12).
- Q9: Build the Signature + Voice-report (job-completion) vertical next? It's the last offline-critical tech-core write path — compound job_photos + jobs update + sync-calendar/transcribe side-effects (see D15).
