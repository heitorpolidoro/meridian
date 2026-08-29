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

**If it does not**, you may start it — `meridian start` is safe to call. It
probes the port first, reports and exits when something already answers, and
never kills a running process. Killing is `meridian restart`, which you should
not run: replacing a server the operator is using is their decision, not yours.

Two conditions still make starting the wrong move, and both are worth checking
before you run anything:

- **`$BASE` is not the default instance.** `cli.js` can only ever listen on
  `PORT` (default `3333`), so starting it cannot make a different address
  answer. If `MERIDIAN_URL` points elsewhere, say the address is unreachable
  and hand back to the operator.
- **`cli.js` would pick the wrong registry.** It walks up from the directory it
  is launched in looking for `.meridian/projects.json`, and creates a new empty
  one if it finds none. Launch it from the project directory — the current one,
  no `cd` — and it finds the workspace registry above the project on its own.
  Confirm that first:

```bash
D="$PWD"; while [ "$D" != "/" ]; do
  [ -f "$D/.meridian/projects.json" ] && { echo "$D"; break; }
  D="$(dirname "$D")"
done; [ "$D" = "/" ] && echo "NO REGISTRY"
```

  On `NO REGISTRY`, do not start — say so, since the server would come up backed
  by an empty registry that is not the operator's.

### Locate the checkout

`cli.js` lives in the Meridian checkout, which is neither this directory nor the
plugin's skill folder. Derive it from the plugin root and **verify it**; never
run a guessed path:

```bash
# The plugin ships inside the checkout at plugin/plugins/meridian,
# so the checkout is three levels above the plugin root.
CHECKOUT="$(cd "<resolved plugin root>/../../.." 2>/dev/null && pwd)"
if [ -n "$CHECKOUT" ] && [ -f "$CHECKOUT/cli.js" ]; then echo "$CHECKOUT"; else echo NONE; fi
```

`<resolved plugin root>` is the directory that *contains* `references/` — take
the path you resolved in the skill's **Resolve the shared references** section
and drop the trailing `/references/<file>.md`.

On `NONE`, the plugin was installed from a copy that does not carry the
checkout. Ask the operator for the path and verify `cli.js` is in it before
going on.

Then start it, from the project directory, and wait for it to answer:

```bash
BASE="${MERIDIAN_URL:-http://localhost:3333}"
node "$CHECKOUT/cli.js" start
for i in $(seq 1 20); do curl -sS -f "$BASE/api/status" >/dev/null && break; sleep 0.5; done
curl -sS -f "$BASE/api/status" >/dev/null && echo up || echo "still down"
```

**If it still cannot start**, say so and fall back to reading
`./.meridian/tasks.json` directly for anything read-only. Never *write* by hand
without telling the operator the server is down — the server owns the
timestamps, and a hand-written task loses them.

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
that file if it has none), and derives the task `key` from `name`. Filling
`name`, `stack` and `description` at creation time is what keeps the project's
dashboard card from appearing immediately with three "missing" badges.

A `409` means the path is already registered — treat that as success and
continue.

Then **offer** — do not force — to generate an `AGENTS.md` if the repository
does not have one. If the operator declines, carry on without it.
