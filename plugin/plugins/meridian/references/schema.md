# Meridian Task Schema

The canonical description of a Meridian task. Every skill and agent that reads
or writes task state uses this file as the single source of truth. If any other
prose disagrees with it, this file wins.

## Where tasks live

Tasks for a project live in `<project>/.meridian/tasks.json`.

That file is a **bare JSON array** of task objects:

```json
[
  { "id": "MERID-1", "title": "..." },
  { "id": "MERID-2", "title": "..." }
]
```

It is **not** an object with a `tasks` key. `{"tasks": [...]}` is a legacy shape
the server still tolerates on read, but everything written today is a plain
array. Never write the wrapped form.

`.meridian/` is gitignored, so a clobbered `tasks.json` is unrecoverable. Never
truncate the file, and never write it from an empty in-memory list.

## Task fields

| Field | Type | Written by |
|---|---|---|
| `id` | string, `<KEY>-<N>` | **server only** — generated on create |
| `title` | string, short imperative | agent, on create and via update |
| `status` | string, one of the nine below | agent |
| `priority` | string, one of the four below | agent (defaults to `medium`) |
| `justification` | string — why the task is blocked, or why it exists | agent |
| `expected_results` | array of strings — concrete, mechanically verifiable outcomes | agent |
| `blockedBy` | array of task ids that must reach `done` first | agent |
| `spec_path` | string, e.g. `docs/tasks/MERID-1-spec.md` | agent |
| `spec_iterations` | integer, spec revision rounds consumed | agent |
| `code_review_iterations` | integer, code review revision rounds consumed | agent |
| `qa_iterations` | integer, QA revision rounds consumed | agent |
| `last_review_findings` | array of strings — **only** the current round's blocking findings; cleared on pass | agent |
| `running` | boolean — `true` while an agent is actively working the task | agent |
| `created_at` | ISO-8601 UTC string | **server only** |
| `updated_at` | ISO-8601 UTC string | **server only** |
| `moved_at` | ISO-8601 UTC string | **server only** |
| `completed_at` | ISO-8601 UTC string or `null` | **server only** |

The four timestamps are stamped by the server and **must never be written by an
agent**. `created_at` is set once on creation. `updated_at` is set on every
write. `moved_at` is set on every status change. `completed_at` is set when the
status enters `done` and set back to `null` when it leaves `done`. Sending any
of these four in a request body has no effect — the server overwrites them.

`blockedBy` is the primary reason a task is `blocked`; that dependency is
sufficient justification on its own (e.g. `justification: "Blocked on MERID-3"`).

Never delete a task. Move it to `nope` instead.

## The nine statuses

`status` must be **exactly** one of these nine lowercase strings. They carry no
spaces and no slashes. Do not invent new statuses or use synonyms like
`pending`, `todo`, `completed`, `in progress` or `qa/review`.

- `backlog`: Task is planned but not ready to be worked on yet.
- `specreview`: Task needs specification or design review.
- `readytodo`: Task is fully specified and ready to be picked up.
- `inprogress`: Task is currently being worked on by developer.
- `codereview`: Task code is being reviewed for architecture, security, and test quality.
- `qareview`: Task is being verified independently by QA against expected results.
- `blocked`: Task cannot proceed due to external dependencies.
- `done`: Task is fully completed.
- `nope`: Task was cancelled or won't be done.

The server rejects any other value with HTTP 400.

## The four priorities

`priority` must be **exactly** one of these four lowercase strings:

`critical`, `high`, `medium`, `low`

A task without a priority is read as `medium`, and the server writes `medium`
when a create request omits the field. The server rejects any other value with
HTTP 400.

## Task ids

Ids follow the format `<KEY>-<N>`, where `KEY` comes from the project's
`.meridian/project-info.json` (e.g. `PROJ-1`, `PE-4`, `MERID-12`) and `N` is
the next free integer for that key.

**The server generates the id.** Never compute one client-side, never guess the
next number, and never send an `id` in a create request — the server derives the
key from `project-info.json` and assigns `N` itself. Read the assigned id back
out of the create response.

## All writes go through the API

Every task write goes through the Meridian server. The server owns the
timestamps, so it is the only write path that keeps them consistent. Resolve the
base URL from `MERIDIAN_URL` (default `http://localhost:3333`) — see
`preamble.md`.

**Create** — `POST {MERIDIAN_URL}/api/projects/tasks`

```json
{
  "projectPath": "/absolute/path/to/project",
  "title": "Short imperative title",
  "priority": "medium",
  "justification": "",
  "expected_results": ["Concrete, mechanically verifiable outcome"],
  "blockedBy": []
}
```

`projectPath` and `title` are required. Create accepts only these fields. The
new task is always created with `status: "backlog"` and `running: false`; a
`status` sent to create is ignored. To land a new task in any other status — for
example `blocked` with `justification: "Blocked on MERID-3"` — create it first,
then immediately update it. The response is
`{ "success": true, "task": { ... } }`; take the server-assigned `id` from there.

**Update** — `PUT {MERIDIAN_URL}/api/projects/tasks/<task id>`

```json
{
  "projectPath": "/absolute/path/to/project",
  "status": "inprogress",
  "running": true
}
```

`projectPath` is required in the body — the task id goes in the URL path. Send
only the fields you are changing; omitted fields are left alone. Update accepts
`status`, `title`, `justification`, `priority`, `spec_path`, `spec_iterations`,
`code_review_iterations`, `qa_iterations`, `blockedBy`, `expected_results`,
`last_review_findings` and `running`. Fields only settable through update —
`spec_path`, the three iteration counters and `last_review_findings` — are
absent from a freshly created task until the first update sets them; treat an
absent counter as `0` and an absent `last_review_findings` as `[]`.

**Read** — `GET {MERIDIAN_URL}/api/status?project=<absolute project path>`

Reading `tasks.json` directly is fine when you only need to look.

**Hand-editing `tasks.json` is the fallback of last resort**, permitted only
when the server cannot be started at all, and only after telling the operator
the server is down. A hand-edit must reproduce the timestamp rules above
exactly.
