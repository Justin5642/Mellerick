# Shared by the rls and e2e CI jobs (it used to be pasted into both).
# Disables [db.migrations] in supabase/config.toml so `supabase start` boots an
# empty stack; scripts/ci-apply-migrations.sh then applies the history with
# production's grants. See that script's header for why.
from pathlib import Path
path = Path("supabase/config.toml")
lines = path.read_text().splitlines()
in_block = False
for i, line in enumerate(lines):
    stripped = line.strip()
    if stripped == "[db.migrations]":
        in_block = True
    elif in_block and stripped.startswith("["):
        in_block = False
    elif in_block and stripped == "enabled = true":
        lines[i] = line.replace("true", "false", 1)
        path.write_text("\n".join(lines) + "\n")
        break
else:
    raise SystemExit("Could not disable db.migrations.enabled in supabase/config.toml")
