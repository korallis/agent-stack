# Project environments: keep agents on development data

Seats run unattended with permission checks off, so the only safe production credential is one they never have. Each
project gets a **development** environment of its own for the seats. Production and preview credentials stay with the
owner, outside the repo. The example below is Vercel + Neon Postgres + Vercel Blob (fortis-secure, 2026-09-30); other
hosts work the same way.

## The layout
| Environment | Database | Files | Env file | Who has it |
|---|---|---|---|---|
| Development | a Neon **dev** branch with its own role password | a dev Blob store | `<repo>/.env.local` | the owner and every seat (linked into each worktree) |
| Preview | a Neon branch per deployment (Vercel's Neon integration) | a preview Blob store | not on disk | Vercel only |
| Production | the Neon main branch | the production Blob store | an owner-only dir outside the repo, e.g. `~/.config/<project>/env/` (0700) | the owner only |

The 0700 dir keeps production values out of the repo and out of worktrees. It is a handling convention, not a wall:
seats run as the same user and could read it. What keeps them out is that they never look for it (the CULTURE rule
below), and that the dev credentials they do have open nothing else.

## Set it up (owner, once per project)
1. **Pull env per environment**, never one file for all: `vercel env pull .env.local --environment=development`.
   Pull production or preview only when you need them, into the owner-only dir, never into the repo or a worktree.
2. **Neon dev branch for Development and agents.** Create a `dev` branch from production (a point-in-time copy), and
   **reset the role password on the child branch**: a child branch inherits its parent's password, so without the
   reset the dev connection string also opens production. Put the dev connection string in the Development env.
3. **Previews:** turn on a Neon branch per preview deployment in the Vercel integration, so a PR never writes to the
   shared dev or production database.
4. **Blob stores per environment:** a separate store for development (and preview), connected only to that environment.
   Seats never touch production blobs.
5. **Links, not copies:** `agent-project-new` links `<repo>/.env.local` (ONLY that file) into every seat worktree, so a
   rotated value reaches every seat at once. It never links `.env.*.local` or `.env.production*`.
6. **Record it** in the rig CULTURE specifics: which branch and store the seats use, that production and preview env
   files are not in the repo, and that seats never look for, copy or request them.

## Verify without printing values
Compare values by hash, never by eye, and never echo them into a transcript or log. Compare the **password**, not
only the whole URL: a dev branch that kept its parent's password has a different host, so its URL differs, but the
same password still opens production.
```bash
# pwhash <env file>: a short hash of the password in its DATABASE_URL (percent-decoded). Fails, printing no value, when
# the file, the key, a postgres URL with host and database, or a password is missing.
pwhash() { python3 - "$1" <<'PY'
import hashlib, sys, urllib.parse
pw = None
try:
    lines = open(sys.argv[1]).read().splitlines()
    url = next(l.split("=", 1)[1].strip().strip("'\"") for l in lines if l.startswith("DATABASE_URL="))
    u = urllib.parse.urlsplit(url)
    if u.scheme in ("postgres", "postgresql") and u.hostname and u.path.strip("/") and u.password:
        pw = urllib.parse.unquote(u.password)
except Exception:
    pass
if not pw:
    sys.exit(f"{sys.argv[1]}: no valid DATABASE_URL with a password")
print(hashlib.sha256(pw.encode()).hexdigest()[:12])
PY
}
# pwcheck <dev env file> <production env file>: exit 0 only when both parse and the passwords differ.
pwcheck() {
  local dev prod
  dev=$(pwhash "$1") && prod=$(pwhash "$2") || { echo "FAIL: could not compare"; return 1; }
  [ "$dev" != "$prod" ] || { echo "FAIL: same password; reset it on the dev branch"; return 1; }
  echo "OK: the dev password differs"
}
pwcheck .env.local ~/.config/<project>/env/.env.production
```
Check hosts by name (for example `sed -n 's/^DATABASE_URL=.*@\([^/]*\)\/.*/\1/p'`), not whole URLs.

## Vercel side effects to expect
- **Saving a store connection** (Blob or Neon) in the Vercel dashboard re-issues the connected tokens as **Sensitive**
  variables. Re-pull `.env.local` afterwards, and check the first deploy still works: for example, prove an image
  upload works after a Blob token is re-issued.
- **`vercel blob create-store` rewrites `.env.local`** with the new store's token. Run it, then re-check that
  `.env.local` still points at the dev database and the dev store.

## For seats (in the rig CULTURE and QA guidance)
- Use only `.env.local`. Never look for, copy or request production or preview env files.
- **Never print a credential.** A command's output is the seat's transcript. Write connection strings, passwords and
  tokens to a 0600 file and use them by name: `neon cs <branch> --output-file <path>`. The seat guard in front of
  `neon`/`neonctl` and `vercel`/`vc` (`seat-bin/credguard`) refuses credential-printing commands without
  `--output-file` (a plain `> file` too: Claude Code captures a command's stdout in a file of its own), and refuses a
  `--no-secrets` that the installed version doesn't have. After the 2026-09-30 leak
  ([docs/incidents/2026-09-30-neon-cs-leak.md](incidents/2026-09-30-neon-cs-leak.md)).
- Browser logins go in `~/.config/agent-stack/secrets/playwright.env` and are typed BY NAME (the Playwright MCP's
  `--secrets`). Never inline an env or credential value into a tool input, because the MCP echoes tool input.
