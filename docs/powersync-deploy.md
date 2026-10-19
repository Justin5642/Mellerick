# Deploying the PowerSync sync streams

`mobile/powersync/sync-streams.yaml` is **not** deployed by anything in this
repo — not CI, not Vercel, not EAS, not `supabase db push`. Merging a change to
it changes nothing on any phone until a person pastes it into the PowerSync
dashboard. This page is that procedure.

## Where it lives

- **Service:** PowerSync Cloud, project **mellerick**, the app's instance
  `6a5f0bf6367771958b496c5e` (the one `EXPO_PUBLIC_POWERSYNC_URL` points at).
  A second instance, `6a5f0bf73ab36f9f81820437`, exists and is **not** the
  app's — see HANDOVER §6 ("Second replication outage").
- **Dialect:** Sync Streams edition 3 (`config: edition: 3` at the top of the
  file). There is no legacy `sync-rules.yaml` any more; do not create one.
- **History so far:** v2 (2026-07-27), v3, v4 (2026-10-12, new slot after the
  password reset), redeployed 2026-10-14 for 0071.

## Order — database first, always

1. Apply every migration the streams depend on (SQL editor, one at a time,
   each followed by its `supabase/tests/<n>_*_test.sql` gate test). A stream
   reading a table that is not in the `powersync` publication silently syncs
   nothing (`0039` scoped the publication; each new table adds itself).
2. Then deploy the YAML (below).
3. Then ship the app build that reads the new data.

The filters are written `<flag> IS NOT false`, so a stream deployed before its
flag column exists over-syncs rather than under-syncs. That is a safety net,
not the plan.

## Deploying

1. Open the PowerSync dashboard → project **mellerick** → the app's instance.
2. Open the **Sync Streams** (sync config) editor.
3. Replace its whole contents with `mobile/powersync/sync-streams.yaml` from
   `main` — the entire file, not a diff.
4. Press **Validate**. It must report no errors. Warnings about tables it
   cannot see mean step 1 was skipped: stop and apply the migration first.
5. Press **Deploy**. PowerSync builds the new version alongside the old one
   and switches over when it has caught up; devices keep syncing the old
   version until then, then download the difference.
6. Check: the dashboard shows the new version **active** and the replication
   slot healthy; `npm run check:sync` passes. If anything looks wrong, read
   the dashboard log first (HANDOVER §6) before touching credentials.

### Optional local check before step 1 of "Deploying"

The same compiler the service uses validates the file locally:

```bash
mkdir -p /tmp/psrules && cd /tmp/psrules && npm init -y >/dev/null
npm install @powersync/service-sync-rules
node --js-explicit-resource-management -e '
  const { SqlSyncRules } = require("@powersync/service-sync-rules");
  const yaml = require("fs").readFileSync(process.argv[1], "utf8");
  const errs = SqlSyncRules.validate(yaml, { defaultSchema: "public" });
  errs.forEach((e) => console.log(e.message));
  console.log(errs.length ? "FAIL" : "OK");
' /path/to/mellerick-app/mobile/powersync/sync-streams.yaml
```

## After changing the YAML in a PR

- Regenerate the device schema: `node mobile/scripts/generate-powersync-schema.mjs`
  (needs the linked Supabase CLI, i.e. the migration applied) — or, while the
  migration is still a draft, edit `mobile/lib/powersync/schema.ts` to exactly
  what the generator would write; `tests/unit/device-schema-vs-migrations.test.ts`
  and `mobile/lib/powersync/schema.test.ts` check it.
- Technician streams list their columns; never `SELECT *` (HANDOVER §2,
  enforced by `tests/unit/sync-streams-contract.test.ts`).
- Note the deploy (date, version) in HANDOVER.md when it is done.

## Pending deploys

| Change | Needs first | Status |
|---|---|---|
| `tech_job_bookings`, `office_job_bookings` (job bookings on the phone, build 16) | `0079_job_bookings.sql` then `0080_job_bookings_sync.sql` applied (both drafts, not applied yet) | **not deployed** |
