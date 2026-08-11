# PowerSync replication recovery — when the slot is INACTIVE

`npm run check:sync` says `INACTIVE` / `password authentication failed for user
"powersync_role"`. The database role's password and the password stored in the
PowerSync dashboard no longer match, so PowerSync cannot connect. Devices keep
showing their last snapshot and nothing on the client reports a problem.

This is the exact state left on 2026-08-12: an audit subagent rotated the
`powersync_role` password, and a first recovery attempt pasted the wrong value
because the clipboard had been overwritten during dashboard sign-in. The password
the DB was set to is not recoverable (it was only ever on the clipboard), so
recovery = set a fresh one on BOTH sides.

## Why the last step cannot be automated here

- PowerSync exposes no Management API to update *only* a connection's password;
  the CLI `powersync deploy` path also redeploys sync rules, which is not worth
  the risk of disturbing the live streams for a password change.
- So the dashboard is the reliable path, and entering the password there is a
  human step by policy (an agent does not type credentials into fields).

## Recovery — about 90 seconds

1. **Set a fresh password and get it reliably.** In your own terminal (pwsh, not
   powershell.exe):

   ```
   pwsh -File scripts\set-powersync-password.ps1
   ```

   It sets a new password on `powersync_role`, copies it to the clipboard, AND
   writes it to `POWERSYNC_NEW_PASSWORD.local.txt` (gitignored). The file exists
   because the clipboard is fragile — if anything overwrites it before you paste,
   open the file and copy from there instead.

2. **Put it in the dashboard.** PowerSync dashboard → project `mellerick` →
   instance **Development** → **Database Connections** → **Edit** (host, port,
   `powersync_role`, SSL `verify-full` are already correct — only the password is
   wrong):
   - Password field → **clear it first**, then paste the new password.
     (The field pre-fills the old value; pasting without clearing appends, and
     the combined string fails auth. Verify the dot-count looks like one password,
     not two.)
   - **Test Connection** → wait for green. If it fails *instantly*, wait ~60s and
     retry — Supabase's auth cache lags about a minute after a password change.
   - **Update Connection**.

3. **Confirm.** Back in the terminal:

   ```
   npm run check:sync
   ```

   Expect `HEALTHY`, slot `active`. Then **delete
   `POWERSYNC_NEW_PASSWORD.local.txt`**.

## If `wal_status` shows `lost` rather than `reserved`

If replication was down long enough for the backlog to pass
`max_slot_wal_keep_size` (512 MB), Postgres invalidates the slot to protect the
primary — this is expected and not data loss. Recovery is the same three steps;
after step 2, PowerSync re-snapshots from Postgres automatically (a couple of
minutes here) instead of resuming. Postgres is the source of truth; devices
re-sync from it.

See [[powersync-cloud-setup]] and the incident record for background.
