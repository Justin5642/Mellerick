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

1. **Maestro CLI** — `curl -Ls "https://get.maestro.mobile.dev" | bash` (or see
   https://maestro.mobile.dev). Verify with `maestro --version`.
2. **A running app build on a device/emulator** with app id `au.com.mellerick.field`:
   - iOS Simulator or Android emulator, or a physical device.
   - Install a build: `eas build --profile preview --platform android` (APK) then
     install it, or run a local dev build. Expo Go will NOT work for the offline /
     background-location paths — use a dev/preview build.
3. **Seeded test accounts** in the target Supabase env, one per role, and at least
   one job assigned to the technician and one job awaiting approval. Never use real
   customer data.
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
