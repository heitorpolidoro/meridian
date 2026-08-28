# Skill Preamble

Every Meridian skill performs these three steps before doing anything else.
Do them in order and stop at the first one that says stop.

## The server address

The server address comes from the `MERIDIAN_URL` environment variable, falling
back to `http://localhost:3333` when it is unset or empty.

**Every bash block that uses `$BASE` must set it itself, as that block's own
first line:**

```bash
BASE="${MERIDIAN_URL:-http://localhost:3333}"
curl -sS -f "$BASE/api/status" >/dev/null && echo up || echo down
```

Shell state does not survive between Bash tool invocations — only the working
directory does. Setting `BASE` in one block does **not** carry into the next: a
later block that uses `$BASE` without setting it runs with the variable empty,
so `"$BASE/api/status"` becomes the relative `/api/status`, and the request
fails for a reason that has nothing to do with the server being up or down.
Every block below repeats the line for exactly this reason; repeat it in your
own blocks too, including one-off `curl`s.

Never hardcode the literal `http://localhost:3333` inside a request. The rule is
two-sided: write `$BASE` in the request, **and** put the `BASE=...` line above it
in the same block. Together they are what lets `MERIDIAN_URL` point a skill at a
different Meridian instance — a second server on another port, backed by a
throwaway workspace — which is how the skills are exercised without touching the
operator's real project registry.

## 1. Resolve the project

The project is the **current working directory**, and only the current working
directory. Check for `./.meridian/`:

```bash
test -d ./.meridian && echo present || echo absent
```

**Do not walk up the directory tree.** The plugin is installed per user, so it
is visible in every directory on the machine, including the many that have
nothing to do with Meridian. Finding a parent's `.meridian/` and acting on it
would attach the wrong project. If `./.meridian/` is not here, this directory is
not a Meridian project yet.

When it is present, the project path is the absolute path of the current
directory; that is the `projectPath` every API call needs. The task key lives in
`./.meridian/project-info.json`. Go to step 2 — but note that a present
`.meridian/` is not proof the server knows about this directory. Step 3 checks
that, and offers registration if it does not.

When it is absent, **ask the operator now** whether to register this directory
with Meridian. Ask; do not assume.

- **On no:** stop here. Say nothing further about tasks, and do not create any
  files. Do not start a server.
- **On yes:** continue to step 2, then do the registration in step 3.

Asking before step 2 is deliberate: a "no" must not leave a server running that
was started only to onboard a directory the operator does not want onboarded.

## 2. Ensure the server is running

Probe it. Note the `BASE=` line — it belongs to this block, per **The server
address**:

```bash
BASE="${MERIDIAN_URL:-http://localhost:3333}"
curl -sS -f "$BASE/api/status" >/dev/null && echo up || echo down
```

**If it answers**, continue to step 3.

**If it does not**, do not reach for `cli.js start` yet. That command is
destructive in ways a failed probe does not distinguish:

- It **SIGTERMs whatever pid is recorded in `meridian-server.pid`** before
  starting anything. That PID file sits in the Meridian checkout — one file
  shared by every project on the machine — so the process it kills is whichever
  Meridian server the operator currently has running, very likely the live board
  on port `3333`, which has nothing to do with the directory you are in. This is
  the largest hazard of the three, and the reason for the guard below.
- It always listens on the port from `PORT` (default `3333`), so it can only
  ever produce the default instance. When `$BASE` is anything else, starting it
  cannot fix the probe — it would kill a server and still leave `$BASE`
  unreachable.
- It picks its registry by walking up from the directory it is launched in,
  looking for `.meridian/projects.json`, and falls back to the launch directory
  when it finds none. With no registry above it, it would create a new, empty
  one rather than use the operator's.

### 2a. Locate the checkout

`cli.js` lives in the Meridian checkout. That is neither this directory nor the
plugin's skill folder, and no step so far has named it. Derive a candidate from
the plugin root and **verify it**; never run a guessed path:

```bash
# The plugin ships inside the checkout at plugin/plugins/meridian,
# so the checkout is three levels above the plugin root.
CHECKOUT="$(cd "<resolved plugin root>/../../.." 2>/dev/null && pwd)"
if [ -n "$CHECKOUT" ] && [ -f "$CHECKOUT/cli.js" ]; then echo "$CHECKOUT"; else echo NONE; fi
```

`<resolved plugin root>` is the directory that *contains* `references/` — take
the path you resolved in the skill's **Resolve the shared references** section
and drop the trailing `/references/<file>.md` from it. On a checkout that is
`<checkout>/plugin/plugins/meridian`, so `../../..` is `<checkout>`.

If that prints `NONE`, the plugin was installed from a copy that does not carry
the checkout. **Ask the operator for the path to their Meridian checkout**, and
verify `cli.js` is in it before going on. If they do not give one, skip to *If
it still cannot start* below.

### 2b. Check which registry `cli.js` would pick

No `cd` — the current directory stays the project, as step 1 says. `cli.js`
walks up from wherever it is launched, so launching it here finds the workspace
registry above this project on its own. Confirm that it will:

```bash
D="$PWD"
while [ "$D" != "/" ]; do
  [ -f "$D/.meridian/projects.json" ] && break
  D="$(dirname "$D")"
done
if [ "$D" = "/" ]; then echo "NO REGISTRY above $PWD"; else echo "registry: $D/.meridian/projects.json"; fi
```

On `NO REGISTRY`, do not start it: it would fall back to this directory and
create a second, empty `projects.json`. Report that and let the operator start
the server themselves.

### 2c. The guard — run this before `cli.js start`, every time

```bash
BASE="${MERIDIAN_URL:-http://localhost:3333}"
CHECKOUT="<the verified checkout path from 2a>"
PIDFILE="$CHECKOUT/meridian-server.pid"
if [ "$BASE" != "http://localhost:3333" ]; then
  echo "REFUSE: \$BASE is '$BASE' - cli.js start only ever produces the default instance"
elif curl -sS -f "$BASE/api/status" >/dev/null 2>&1; then
  echo "REFUSE: $BASE already answers - there is nothing to start"
elif [ ! -f "$CHECKOUT/cli.js" ]; then
  echo "REFUSE: no cli.js at '$CHECKOUT'"
elif [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  echo "REFUSE: $PIDFILE names a live process - starting would SIGTERM it"
else
  echo "SAFE TO START"
fi
```

Run `cli.js start` **only** when that block prints `SAFE TO START`. On any
`REFUSE`, do not start anything: report that the server at `$BASE` is
unreachable, say which line refused and why, and let the operator start or stop
their own server.

The first condition is also what makes an unset `$BASE` harmless. `BASE` can
only be empty in a block that forgot the `BASE=...` line — and an empty `$BASE`
is not `http://localhost:3333`, so it refuses on the first branch instead of
falling through into a command that would kill the operator's board. The guard
re-probes in the same block for the same reason: the decision to start is never
inherited from an earlier block's result.

```bash
BASE="${MERIDIAN_URL:-http://localhost:3333}"
CHECKOUT="<the verified checkout path from 2a>"
node "$CHECKOUT/cli.js" start
```

Then re-probe until it responds, for a few seconds, with the `BASE=` line in
each probing block.

**If it still cannot start**, say so plainly, then fall back to reading
`./.meridian/tasks.json` directly for anything read-only. Never *write* task
state by hand without first telling the operator the server is down — the server
owns the timestamps, and a hand-edit that skips them puts the board out of sync.
See `schema.md` for the timestamp rules a hand-edit would have to reproduce.

If registration is needed — the operator said yes in step 1, or step 3 case B
finds this directory unregistered — and the server could not be started,
**stop**: registration is a write, and there is no hand-edit fallback for it —
the server is what creates `.meridian/` and derives the task key.

## 3. Register the project

Two different situations reach this step. Work out which one you are in first.

**Case A — `./.meridian/` was absent** and the operator said yes in step 1.
Register, per **Registering** below.

**Case B — `./.meridian/` was present.** Its presence is not proof that the
server knows this directory. `.meridian/` is local to the project; the registry
is the workspace's `projects.json`, and a directory can easily have the first
without the second — a fresh clone, a copied tree, a rebuilt registry. Check:

```bash
BASE="${MERIDIAN_URL:-http://localhost:3333}"
curl -sS -G "$BASE/api/status" --data-urlencode "project=$PWD"
```

- **`projects` non-empty** — this directory is registered. Nothing to do here;
  go and do the skill's own job.
- **`projects` empty**, with `errors` reporting the path is not registered — the
  directory has a `.meridian/` the server has never heard of. Left alone, every
  skill reports `projects: []` plus an error and offers no way out. **Ask the
  operator now** whether to register it, exactly as step 1 asks in the absent
  case. On no, stop and say the directory is not on the board. On yes, register
  it, with the one extra rule in **Registering** below.

### Registering

Read the repository first and infer the three descriptive fields, so the project
is registered complete rather than as an empty entry:

- `name` — the project's real name (package manifest, README title, directory
  name as a last resort).
- `stack` — an array of the languages, frameworks and core tools actually in
  use, read from the manifests and lockfiles present.
- `description` — one sentence on what the project does.

**In case B, take `name` from the existing `./.meridian/project-info.json`
instead of inferring it**, and reuse its `stack` and `description` when it has
them. The server derives the task `key` from `name` and rewrites
`project-info.json`, so a different name yields a different key — and the ids
already in `./.meridian/tasks.json` would no longer match the key new tasks are
given.

Then register it:

```bash
BASE="${MERIDIAN_URL:-http://localhost:3333}"
curl -sS -X POST "$BASE/api/projects" \
  -H 'Content-Type: application/json' \
  -d '{"name":"...","path":"<absolute path of the current directory>","stack":["..."],"description":"..."}'
```

The server does the rest: it records the path in the workspace's
`projects.json`, creates `./.meridian/` if it is not already there, writes
`project-info.json`, adds `.meridian/` to the project's `.gitignore` (creating
that file if it has none), and derives the task `key` from `name`. Filling `name`, `stack` and `description` at
creation time is what keeps the project's dashboard card from appearing
immediately with three "missing" badges.

A `409` means the path is already registered — treat that as success and
continue.

Then **offer** — do not force — to generate an `AGENTS.md` if the repository
does not have one. If the operator declines, carry on without it.
