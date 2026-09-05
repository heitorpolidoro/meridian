# MERID-3 — Capture task statistics: status/running events log and per-dispatch token usage

## Scope

This task captures **raw data only** — a durable, append-only event log of
task status/running transitions and of per-subagent-dispatch token usage.
Aggregation (durations per stage, totals per task, dashboards) is MERID-4 and
is explicitly out of scope here; nothing in this task reads `events.jsonl`
back, it only writes to it.

Three deliverables, all in one PR:

1. `lib/events.js` — a small append-only writer for `<project>/.meridian/events.jsonl`, used by the server.
2. `server.js` — the create/update task handlers log status/running changes; a new `POST /api/projects/events` endpoint accepts a `dispatch_tokens` event from the plugin hook.
3. `plugin/plugins/meridian/scripts/running-flag.sh` — `post` mode locates the subagent transcript that just finished and reports its token usage to the new endpoint, best-effort.

Does not cover: reading/aggregating `events.jsonl`, any UI, any change to the
`tasks.json` schema itself, or capturing tokens for anything other than a
Task-tool subagent dispatch (e.g. no token capture for the main session).

## Approach

### 1. `lib/events.js`

New module, same conventions as `lib/gitignore.js` / `lib/projects.js`
(`'use strict'`, `node:` prefixed requires, 4-space indent, CommonJS export).

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Appends one JSON line to <project>/.meridian/events.jsonl — the full,
// append-only history of every status/running change and dispatch-token
// event a project has ever had. Never trimmed, never rewritten: MERID-4
// (aggregation) depends on every line staying exactly as written.
//
// Best-effort by design: a task write (create/update) must succeed even when
// this fails (disk full, permissions, races), so this never throws. Returns
// true on success, false otherwise — callers may ignore the return value.
function appendEvent(projectPath, event) {
    try {
        const meridianDir = path.join(projectPath, '.meridian');
        if (!fs.existsSync(meridianDir)) fs.mkdirSync(meridianDir, { recursive: true });
        const target = path.join(meridianDir, 'events.jsonl');
        fs.appendFileSync(target, JSON.stringify(event) + '\n', 'utf8');
        return true;
    } catch (err) {
        return false;
    }
}

module.exports = { appendEvent };
```

Two event shapes will land in the same file, distinguished by which
discriminator key is present — `field` for status/running transitions,
`type` for dispatch-token reports. MERID-4 branches on that; this task does
not need to reconcile them into one shape.

```json
{"task":"MERID-3","field":"status","from":"ready_todo","to":"in_progress","at":"2026-09-05T12:00:00.000Z"}
{"task":"MERID-3","field":"running","from":false,"to":true,"at":"2026-09-05T12:00:00.500Z"}
{"task":"MERID-3","type":"dispatch_tokens","agent":"developer","output_tokens":1234,"context_tokens":58000,"at":"2026-09-05T12:10:00.000Z"}
```

### 2. `server.js` — logging status/running changes

`require('./lib/events')` alongside the existing `lib/tasks`/`lib/gitignore`/`lib/projects` requires.

**Create handler (`POST /api/projects/tasks`)** — after `saveTasks(projectPath, tasksData)` succeeds, append one event recording the task's starting status. There is no previous status to compare against, so `from` is `null`:

```js
appendEvent(projectPath, { task: newTask.id, field: 'status', from: null, to: newTask.status, at: newTask.created_at });
```

`running` is always `false` on a new task (per `schema.md`) — there is no
transition to record, so creation never logs a `running` event.

**Update handler (`PUT /api/projects/tasks/:taskId`)** — capture the
pre-update `running` value alongside the existing `prevStatus`, right where
`prevStatus` is already captured:

```js
const task = tasksData.tasks[taskIndex];
const prevStatus = task.status;
const prevRunning = task.running === true;
```

...leave the existing field-assignment loop and `stampTaskUpdate` call
unchanged. After `saveTasks(projectPath, tasksData)` succeeds, compare
before/after and log only what actually changed:

```js
if (task.status !== prevStatus) {
    appendEvent(projectPath, { task: task.id, field: 'status', from: prevStatus, to: task.status, at: task.moved_at });
}
const newRunning = task.running === true;
if (newRunning !== prevRunning) {
    appendEvent(projectPath, { task: task.id, field: 'running', from: prevRunning, to: newRunning, at: task.updated_at });
}
```

A `PUT` that only changes e.g. `title` or `priority` appends nothing. Reuse
`task.moved_at`/`task.updated_at` (already stamped by `stampTaskUpdate`) as
the event's `at`, so the event log timestamp always matches the task's own
record exactly — no separate `new Date()` call needed here.

Both call sites are naturally best-effort: `appendEvent` cannot throw, and it
is called strictly after `saveTasks` has already succeeded, so a broken
`events.jsonl` write can never turn a 200/201 response into a 500 or roll
back the task write.

### 3. `server.js` — `POST /api/projects/events`

New route, placed near the other `/api/projects/tasks*` routes. Body:

```json
{
  "projectPath": "/absolute/path/to/project",
  "task": "MERID-3",
  "type": "dispatch_tokens",
  "agent": "developer",
  "output_tokens": 1234,
  "context_tokens": 58000
}
```

`agent` is optional. Validate in this order, returning `400` with
`{ "error": "..." }` on the first failure (matching the style of the existing
task routes):

1. `projectPath` is a non-empty string.
2. `projectPath` resolves (via `path.resolve`, same comparison
   `getStatusData` already uses for `options.project`) to an entry in
   `PROJECTS_JSON_PATH`'s `projects` list — i.e. a *registered* project. This
   endpoint, unlike the task CRUD routes, must reject unregistered paths
   outright, since it has no other integrity check on what it appends.
3. `task` is a non-empty string. (No check that the id exists in that
   project's `tasks.json` — the event log tolerates references to tasks that
   have since moved to `nope` or been read past; this is a log, not a foreign
   key.)
4. `type === 'dispatch_tokens'` exactly. Any other value (or a missing
   `type`) is rejected — this task defines no other event type for the
   endpoint to accept.
5. `output_tokens` is a `number` and `Number.isFinite(output_tokens)`.
6. `context_tokens` is a `number` and `Number.isFinite(context_tokens)`.
7. If `agent` is present, it must be a `string`.

On success, append and respond `201`:

```js
const event = {
    task,
    type: 'dispatch_tokens',
    output_tokens,
    context_tokens,
    at: new Date().toISOString()
};
if (typeof agent === 'string') event.agent = agent;
appendEvent(projectPath, event);
res.status(201).json({ success: true });
```

Use the `projectPath` exactly as given in the body for the `appendEvent`
call (same convention the existing task routes already use for `getTasks`/
`saveTasks`) — the registration check above only needs `path.resolve` for
the *comparison*, not to rewrite the path that gets used.

### 4. `plugin/plugins/meridian/scripts/running-flag.sh` — token capture in `post` mode

This is the one best-effort, silent-on-miss piece. It runs inside the
existing `post)` branch, after the marker/`ID`/`CWD` fast-path checks already
guarding that branch (so it only ever runs for an actual Meridian dispatch).

The hook payload (`$INPUT`) carries `transcript_path` for Claude Code
sessions (absent under Antigravity, which is the primary "skip silently"
case). Subagent transcripts for a session live at:

```
<dirname of transcript_path>/<session id>/subagents/agent-*.jsonl
```

Add a `mtime_of` helper (mirrors the existing dual-tool pattern used
elsewhere for portability — BSD `stat` on macOS, GNU `stat` on Linux CI):

```sh
mtime_of() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null; }
```

Add a `transcript_path` extractor next to `session_id`/`cwd_json`:

```sh
transcript_path() {
  printf '%s' "$INPUT" | grep -o '"transcript_path"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -1 | sed 's/^"transcript_path"[[:space:]]*:[[:space:]]*"//; s/"$//'
}
```

Best-effort extractor for the agent name, so the posted event can carry it
(optional field on the endpoint, but valuable for MERID-4's "per pipeline
stage" aggregation — the whole reason this task exists):

```sh
agent_type() {
  printf '%s' "$INPUT" | grep -o '"subagent_type"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -1 | sed 's/.*"\([^"]*\)"$/\1/'
}
```

New function, called once from the `post` branch:

```sh
capture_tokens() { # $1=task id  $2=cwd JSON string  $3=ledger mtime (epoch secs, may be empty)
  local id="$1" cwdj="$2" since="$3"
  local tpath sid tdir subdir
  tpath="$(transcript_path)"; [ -n "$tpath" ] || return 0
  sid="$(session_id)"; [ -n "$sid" ] || return 0
  tdir="$(dirname "$tpath")"
  subdir="$tdir/$sid/subagents"
  [ -d "$subdir" ] || return 0

  # Newest agent-*.jsonl modified after the pre-dispatch ledger timestamp is
  # the transcript for the dispatch that just returned. `since` empty (no
  # ledger mtime available) degrades to "newest file, unconditionally" —
  # acceptable for this best-effort path.
  local newest="" newest_mtime=0 f mtime
  for f in "$subdir"/agent-*.jsonl; do
    [ -e "$f" ] || continue
    mtime="$(mtime_of "$f")"; [ -n "$mtime" ] || continue
    if [ -n "$since" ] && [ "$mtime" -le "$since" ]; then continue; fi
    if [ "$mtime" -gt "$newest_mtime" ]; then newest_mtime="$mtime"; newest="$f"; fi
  done
  [ -n "$newest" ] || return 0

  local tokens out_tokens ctx_tokens
  tokens="$(python3 - "$newest" <<'PYEOF'
import json, sys

path = sys.argv[1]
output_tokens = 0
last_usage = None
try:
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            usage = entry.get('usage')
            if not isinstance(usage, dict):
                msg = entry.get('message')
                usage = msg.get('usage') if isinstance(msg, dict) else None
            if isinstance(usage, dict):
                output_tokens += usage.get('output_tokens', 0) or 0
                last_usage = usage
except OSError:
    pass

if last_usage is None:
    print('0 0')
else:
    ctx = (last_usage.get('input_tokens', 0) or 0) \
        + (last_usage.get('cache_read_input_tokens', 0) or 0) \
        + (last_usage.get('cache_creation_input_tokens', 0) or 0)
    print(f'{output_tokens} {ctx}')
PYEOF
)"
  out_tokens="${tokens%% *}"
  ctx_tokens="${tokens##* }"
  [ -n "$out_tokens" ] || return 0

  local agent agent_json payload
  agent="$(agent_type)"
  agent_json=""
  [ -n "$agent" ] && agent_json="\"agent\":\"$agent\","
  payload=$(printf '{"projectPath":%s,"task":"%s","type":"dispatch_tokens",%s"output_tokens":%s,"context_tokens":%s}' \
    "$cwdj" "$id" "$agent_json" "$out_tokens" "$ctx_tokens")
  curl -sS -m 2 -X POST "$BASE/api/projects/events" \
    -H 'Content-Type: application/json' \
    -d "$payload" >/dev/null 2>&1 || true
}
```

Wire it into the existing `post` branch of the `pre|post)` case, capturing
the ledger's mtime *before* the existing rewrite (`grep -v ... | mv`) touches
it, and calling `capture_tokens` after:

```sh
    else
      LEDGER_MTIME=""
      [ -f "$LEDGER" ] && LEDGER_MTIME="$(mtime_of "$LEDGER")"
      put_running "$ID" "$CWD" false
      if [ -f "$LEDGER" ]; then
        grep -v "^$ID	" "$LEDGER" > "$LEDGER.new" 2>/dev/null || true
        mv "$LEDGER.new" "$LEDGER" 2>/dev/null || true
      fi
      capture_tokens "$ID" "$CWD" "$LEDGER_MTIME"
    fi
```

Each subagent transcript line is a JSON object; a `usage` object may sit
either at the top level or nested under `message.usage` (the format actually
emitted by Claude Code transcripts) — the Python snippet above checks both,
so it works whichever shape the running deployment produces. Verify this
against a real `agent-*.jsonl` file during implementation if one is
available in the dev environment, and adjust the single `usage = ...`
extraction block if the real shape differs; nothing else in this design
depends on the exact nesting.

Known, accepted limitation (do not attempt to fix in this task): two
subagents dispatched in parallel within the same session share one `$LEDGER`
and one `subagents/` directory, so `capture_tokens` can occasionally attribute
tokens to the wrong one of two subagents that finish close together. The
task's own description calls this path best-effort; MERID-4 consumes noisy
data, not none.

## Testing

Follow `test/api-tasks.test.js`'s `workspaceWith`/`withServer` fixtures — a
temp workspace, temp project, spawned `server.js` pointed at it via
`MERIDIAN_RUNNING_DIR`. Never touch the real board or the checkout's own
`.meridian/`.

New/extended test files (`node --test test/*.test.js` picks up anything
matching `test/*.test.js`):

- **`test/events.test.js`** (new) — unit tests for `lib/events.js` in
  isolation (a plain `fs.mkdtempSync` fixture, no server): appends create the
  file and `.meridian/` dir; two calls produce two lines, each valid JSON via
  `JSON.parse`, in call order; a projectPath where `.meridian` cannot be
  created (e.g. a *file* sitting where `.meridian` would go) makes
  `appendEvent` return `false` without throwing.
- **`test/events.test.js`** or a new `test/api-events.test.js` — server
  integration, reusing `workspaceWith`/`withServer`:
  - creating a task appends exactly one `{field:"status", from:null, to:<initial status>}` line to `<dir>/.meridian/events.jsonl`.
  - `PUT` changing only `status` appends one `field:"status"` line with the correct `from`/`to`; changing only `running` appends one `field:"running"` line; changing both appends two lines; changing neither (e.g. only `title`) appends zero new lines.
  - repeated writes accumulate lines without truncating earlier ones (read the file, count lines, assert monotonically increasing across several writes).
  - `POST /api/projects/events` with a well-formed `dispatch_tokens` body (including one variant with `agent`, one without) returns `201` and appends the expected line.
  - `POST /api/projects/events` returns `400` for: unregistered `projectPath`, missing/blank `task`, `type` other than `dispatch_tokens`, non-numeric `output_tokens`, non-numeric `context_tokens`.
- **Extend `test/plugin.test.js`** or add **`test/running-flag-tokens.test.js`** — exercises `running-flag.sh post` directly via `child_process.spawnSync`, with a stub HTTP server (plain `node:http`, no Express needed) standing in for `MERIDIAN_URL` to capture what gets POSTed:
  - no `transcript_path` in the payload → script exits `0`, stub server receives no request.
  - `transcript_path` present but the derived `subagents/` directory doesn't exist → exits `0`, no request.
  - a `subagents/agent-*.jsonl` fixture file with a couple of `usage`-bearing lines, mtime newer than a fixture `$LEDGER` file's mtime → stub server receives exactly one `POST /api/projects/events` whose body's `output_tokens` equals the summed `usage.output_tokens` and `context_tokens` equals the last line's `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.

## Expected Results

- [ ] `lib/events.js` exists, exports `appendEvent(projectPath, event)`, and two calls append two well-formed JSON lines (each parseable with `JSON.parse`) to `<projectPath>/.meridian/events.jsonl`, creating the file and `.meridian/` if missing.
- [ ] `appendEvent` never throws: a call that cannot create `.meridian` (e.g. a file occupying that path) returns `false` instead of raising.
- [ ] `POST /api/projects/tasks` appends one `{task, field:"status", from:null, to:<initial status>, at}` line to the project's `events.jsonl` for every created task.
- [ ] `PUT /api/projects/tasks/:taskId` appends a `{field:"status", from, to, at}` line only when `status` changes, and a `{field:"running", from, to, at}` line only when `running` changes; a `PUT` touching neither field appends no new line.
- [ ] `POST /api/projects/events` with a registered `projectPath`, non-empty `task`, `type:"dispatch_tokens"`, and numeric `output_tokens`/`context_tokens` returns HTTP 201 and appends one matching line to `events.jsonl` (with `agent` included when supplied).
- [ ] `POST /api/projects/events` returns HTTP 400 for an unregistered `projectPath`, a missing/blank `task`, a `type` other than `dispatch_tokens`, and non-numeric `output_tokens` or `context_tokens`.
- [ ] `running-flag.sh post` exits 0 and posts nothing when the hook payload lacks `transcript_path`, or when the derived `subagents/` directory or any `agent-*.jsonl` file inside it doesn't exist.
- [ ] `running-flag.sh post`, given a subagent transcript modified after the pre-dispatch ledger timestamp, POSTs one `dispatch_tokens` event to `/api/projects/events` whose `output_tokens` equals the sum of `usage.output_tokens` across that transcript's lines and whose `context_tokens` equals the last line's `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.
- [ ] `events.jsonl` is append-only: across repeated writes through any of the three paths above, the file's line count only grows and no earlier line's content changes.
- [ ] `npm test` (`node --test test/*.test.js`) passes, including the new/extended test files above.

## Out of Scope

- Reading, aggregating, or displaying anything from `events.jsonl` (MERID-4).
- A `running` event at task creation (creation's `running` is always `false`; there is no transition to record).
- Verifying that a `task` id referenced by `POST /api/projects/events` actually exists in that project's `tasks.json`.
- Correctly attributing tokens when two subagents are dispatched concurrently within one session (see the accepted limitation noted under Approach §4).
- Any event type for `POST /api/projects/events` other than `dispatch_tokens`.
- Token capture for the main session or for non-Task-tool activity.
