#!/usr/bin/env bash
# Apply the FULL migration history to the local CI Supabase stack.
#
# Extracted from .github/workflows/ci.yml so the `rls` and `e2e` jobs share one
# copy. They previously did not: only `rls` applied migrations, so the `e2e`
# stack had NO SCHEMA AT ALL. The old smoke tests never noticed — a redirect to
# /login and a rendered login form need no tables — and the first test that
# touched one failed with "Could not find the table 'public.profiles' in the
# schema cache". Two jobs needing the same bootstrap, with one of them quietly
# not doing it, is exactly the drift this repo keeps finding.
#
# ROLE GRANTS ARE RE-APPLIED BEFORE EACH MIGRATION, and that is not
# belt-and-braces — it is N19, found by the rls job on its very first run.
#
# Production grants anon and authenticated INSERT/UPDATE/DELETE on the public
# tables, and NOT ONE migration creates those grants: `grep -i "grant .*insert"`
# over supabase/migrations returns nothing. They come from Supabase's default
# privileges on the hosted project, which a database built purely from
# migrations never receives. Without them 0045 fails its OWN assertion —
#
#     ASSERTION FAILED: authenticated lost INSERT on time_entries
#
# — because it asserts a privilege nothing in the repo ever granted.
#
# The consequence is not confined to CI: `supabase db reset` produces a database
# where a technician cannot clock in at all. Tracked separately; this makes CI
# represent production faithfully rather than inventing a migration that changes
# production semantics.
#
# BEFORE, not after: `grant all on all tables` would undo 0045's deliberate
# column-level revoke, and the chain aborts at 0045 anyway, so a single grant
# step afterwards would never run. Granting ahead of each file lets the grants
# keep pace with newly created tables while leaving the last migration's intent
# intact.
set -euo pipefail

SUPABASE_DB_URL="${SUPABASE_DB_URL:-$(supabase status -o env | grep DB_URL | cut -d= -f2 | tr -d '"')}"
export SUPABASE_DB_URL

grant_public() {
  psql "$SUPABASE_DB_URL" -q -v ON_ERROR_STOP=1 \
    -c "grant usage on schema public to anon, authenticated, service_role;" \
    -c "grant all on all tables in schema public to anon, authenticated, service_role;" \
    -c "grant all on all sequences in schema public to anon, authenticated, service_role;"
}

# DRAFTS ARE APPLIED SEPARATELY, AND THAT SEPARATION IS THE POINT.
#
# This script applied every file in the directory, including the five that say
# "STATUS: DRAFT — NOT APPLIED" because they are handed over rather than run
# against production. The result was circular: ci.yml has a step titled "Prove
# the security migrations are actually in force", and one of the suites it runs
# (supabase/tests/0049_storage_delete_scoping_test.sql) calls
# user_can_manage_job(), a function that exists ONLY in draft 0049. So the step
# could only ever pass, and what it proved was that CI had just applied the
# draft — not that production has it.
#
# Production's only job_photos policy is still 0000_baseline.sql:165,
# `for all using (auth.role() = 'authenticated')`. Meanwhile app code states
# 0049's scoping as present fact (components/job/job-photos.tsx tells a user
# "You can only delete photos on jobs assigned to you"). A green CI run was the
# reason nobody noticed the gap.
#
# APPLIED holds what production has. DRAFTS are applied afterwards, into the
# same database, so their own test suites can still run — but the split is
# visible in the log, and PROD_ONLY=1 skips them entirely so a job can assert
# against the real production schema.
applied=0
drafts=0
for f in $(ls supabase/migrations/*.sql | sort); do
  if grep -q "STATUS: DRAFT" "$f"; then
    drafts=$((drafts + 1))
    continue
  fi
  echo "::group::$f"
  grant_public
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$f"
  echo "::endgroup::"
  applied=$((applied + 1))
done
echo "Applied $applied migrations (production schema). Held back $drafts draft(s)."

if [ "${PROD_ONLY:-0}" = "1" ]; then
  echo "PROD_ONLY=1 — drafts NOT applied. The database now matches production."
else
  for f in $(ls supabase/migrations/*.sql | sort); do
    grep -q "STATUS: DRAFT" "$f" || continue
    echo "::group::DRAFT $f"
    grant_public
    psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$f"
    echo "::endgroup::"
  done
  echo "Applied $drafts draft migration(s) — anything asserted below covers a schema PRODUCTION DOES NOT HAVE."
fi

# A loop that silently matched nothing would leave an empty database and every
# assertion downstream trivially true — the exact failure mode this bootstrap
# was rebuilt to remove, and the one that let the e2e job run against no schema.
if [ "$applied" -lt 40 ]; then
  echo "::error::Only $applied production migrations applied — expected the full chain."
  exit 1
fi

# The grant above runs before EVERY file, so whichever migration sorts last
# leaves the coarse table-level grant in place and 0045's column-level revoke
# undone. Re-assert it once, at the end, using the helper 0046 exists to
# provide — order-independent, so adding a 0047 cannot silently re-open the leak.
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -c "select reapply_time_entries_grants();"
