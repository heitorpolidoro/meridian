# Skill Preamble

Every Meridian skill performs these three steps before doing anything else.
Do them in order and stop at the first one that says stop.

## The server address

Resolve the Meridian server from the `MERIDIAN_URL` environment variable,
falling back to `http://localhost:3333` when it is unset or empty:

```bash
BASE="${MERIDIAN_URL:-http://localhost:3333}"
```

Use `$BASE` for every request in every skill. Never hardcode
`http://localhost:3333` in a request. Setting `MERIDIAN_URL` points a skill at a
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
not a Meridian project — go to step 2.

When it is present, the project path is the absolute path of the current
directory; that is the `projectPath` every API call needs. The task key lives in
`./.meridian/project-info.json`.

## 2. If `.meridian/` is absent — offer to register

Ask the operator whether to register this directory with Meridian. Ask; do not
assume.

**On no:** stop. Say nothing further about tasks, and do not create any files.

**On yes:** read the repository first and infer the three descriptive fields, so
the project is registered complete rather than as an empty entry:

- `name` — the project's real name (package manifest, README title, directory
  name as a last resort).
- `stack` — an array of the languages, frameworks and core tools actually in
  use, read from the manifests and lockfiles present.
- `description` — one sentence on what the project does.

Then register it:

```bash
curl -sS -X POST "$BASE/api/projects" \
  -H 'Content-Type: application/json' \
  -d '{"name":"...","path":"<absolute path of the current directory>","stack":["..."],"description":"..."}'
```

The server does the rest: it records the path in the workspace's
`projects.json`, creates `./.meridian/`, writes `project-info.json`, and derives
the task `key` from `name`. Filling `name`, `stack` and `description` at
creation time is what keeps the project's dashboard card from appearing
immediately with three "missing" badges.

A `409` means the path is already registered — treat that as success and
continue.

Then **offer** — do not force — to generate an `AGENTS.md` if the repository
does not have one. If the operator declines, carry on without it.

## 3. Ensure the server is running

Probe it:

```bash
curl -sS -f "$BASE/api/status" >/dev/null && echo up || echo down
```

**If it answers**, continue with the skill.

**If it does not**, start it and wait for it to answer:

```bash
node <path to the meridian checkout>/cli.js start
```

Then re-probe until it responds, for a few seconds. Note that `cli.js start`
stops any server recorded in its PID file before starting a new one, and it
always listens on the port from `PORT` (default `3333`) — so it is the right
move only when `MERIDIAN_URL` points at that default instance. When
`MERIDIAN_URL` points elsewhere, do not run `cli.js start`; report that the
server at `$BASE` is unreachable and let the operator start it.

**If it still cannot start**, say so plainly, then fall back to reading
`./.meridian/tasks.json` directly for anything read-only. Never *write* task
state by hand without first telling the operator the server is down — the server
owns the timestamps, and a hand-edit that skips them puts the board out of sync.
See `schema.md` for the timestamp rules a hand-edit would have to reproduce.
