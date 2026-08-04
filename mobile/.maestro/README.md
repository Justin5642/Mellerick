# Mellerick Field — Maestro E2E flows

End-to-end UI flows for the critical role-based journeys. They are the on-device
backstop for the invariants already covered by the 200 unit/component tests, and
map to the plan's Definition-of-Done scenarios.

> **Status:** these are authored and version-controlled, but **not yet executed**
> — this build environment has no simulator/emulator or seeded backend. They are
> ready to run the moment a device/emulator + test accounts exist (that is one of
> the flagged external gates: on-device QA). Treat them as an executable spec.

## Flows

| File | Role | Asserts |
|---|---|---|
| `flows/01-technician-clock-in.yaml` | technician | login → My Jobs → open job → **clock in → clock out** |
| `flows/02-office-approve-job.yaml` | admin | login → **Approvals → approve** (drafts an invoice, clears the queue) |
| `flows/03-technician-money-gating.yaml` | technician | **no `$` figure** anywhere a technician can reach; office money areas absent |
| `flows/04-offline-clock-in.yaml` | technician (Android) | **airplane-mode clock-in persists** across reconnect (durable outbox) |

`subflows/login.yaml` is a reusable login fragment (invoked via `runFlow`), not a
standalone flow.

## Prerequisites

1. **Maestro CLI** — install from the official GitHub release artifact, NOT the
   `curl … | bash` one-liner on the website. Piping a remote script straight into
   a shell executes whatever that URL serves at that moment, unverified; the
   release artifact publishes a checksum you can actually check first.

   ```bash
   gh release download cli-2.8.0 --repo mobile-dev-inc/maestro \
     --pattern "maestro.zip" --pattern "checksums_sha256.txt" --dir /tmp/maestro-dl
   ```

   Verify BEFORE extracting — this must print a match against
   `checksums_sha256.txt`:

   ```powershell
   (Get-FileHash /tmp/maestro-dl/maestro.zip -Algorithm SHA256).Hash.ToLower()
   ```

   Then extract and copy `maestro/bin` and `maestro/lib` into `~/.maestro/`
   (copy those two directories only — `~/.maestro` also holds sessions and
   analytics that a wholesale overwrite would destroy). Add `~/.maestro/bin` to
   PATH. Verify with `maestro --version` → `2.8.0`.

   Needs a JRE on PATH (Java 17 works).
2. **A running app build on a device/emulator** with app id `au.com.mellerick.field`:
   - iOS Simulator or Android emulator, or a physical device.
   - Install a build: `eas build --profile preview --platform android` (APK) then
     install it, or run a local dev build. Expo Go will NOT work for the offline /
     background-location paths — use a dev/preview build.
3. **Seeded test accounts** in the target Supabase env, one per role, and at least
   one job assigned to the technician and one job awaiting approval. Never use real
   customer data.

   **⚠ THE TECHNICIAN MUST HAVE A JOB — this is not optional.** Flows 01, 03 and
   04 each open one (`tapOn: "#.* — .*"`), so with an empty list they fail at
   that step. Flow 03 is the sharp case: every assertion before the tap is an
   `assertNotVisible`, and all of them are trivially true against an empty
   list — so without a job it proves nothing at all. It carries an explicit
   precondition saying exactly that, so the failure reads as "no fixture" rather
   than as a UI regression or a money leak.

   In production this is job **#834, "QA FIXTURE — do not invoice, do not
   delete"**, assigned to the test technician (`admin@basnmore.com.au`).
   It exists because on 4 August 2026 NO technician in the database had an open
   job — Jake Henderson had none either — so this was never a matter of one
   stray test row. Recreate it with:

   ```sql
   insert into jobs (title, description, status, priority, job_type,
                     customer_id, site_id, assigned_to, scheduled_start)
   select 'QA FIXTURE — do not invoice, do not delete',
          'Permanent e2e fixture. Deleting this makes flows 01/03/04 fail.',
          'scheduled', 'low', 'service', s.customer_id, s.id, p.id, now()
   from sites s cross join profiles p
   where p.email = 'admin@basnmore.com.au'
     and not exists (select 1 from jobs where title like 'QA FIXTURE%')
   limit 1;
   ```

   It is idempotent — re-running never creates a second one.
4. **Credentials via environment variables** (never committed):

   ```bash
   export TECH_EMAIL=... TECH_PASSWORD=...
   export ADMIN_EMAIL=... ADMIN_PASSWORD=...
   ```

## Run

```bash
# From mobile/ — run the whole suite (config.yaml picks up flows/*.yaml):
maestro test .maestro

# A single flow:
maestro test .maestro/flows/01-technician-clock-in.yaml

# Android-only offline flow (setAirplaneMode is Android-only in Maestro):
maestro test .maestro/flows/04-offline-clock-in.yaml
```

## CI (when accounts exist)

Maestro Cloud or a self-hosted emulator job can run these on every build:

```bash
maestro cloud --apiKey "$MAESTRO_CLOUD_API_KEY" \
  --app-file build.apk .maestro
```

Wire the role credentials in as CI secrets. The offline flow needs an Android
emulator (airplane-mode toggling); the rest run on iOS + Android.

## Notes / assumptions

- Selectors use stable `testID`s added for e2e (`login-email`, `login-password`,
  `login-submit`, `job-list-row`, `clock-in`, `clock-out`, `approve-job`) plus
  visible tab/label text; if a screen's copy changes, update the matching flow.
- The money-gating flow asserts the regex `.*\$[0-9].*` is **not** visible on any
  technician surface — the end-to-end complement to the `MoneyText`/route-gating
  unit tests.
- The offline flow relies on the durable-outbox replay (idempotent on the client
  UUID), so a reconnect can't duplicate or drop the clock-in.
