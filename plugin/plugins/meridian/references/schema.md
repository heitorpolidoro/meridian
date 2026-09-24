# Meridian Task Schema

The canonical description of a Meridian task. Every skill and agent that reads
or writes task state uses this file as the single source of truth. If any other
prose disagrees with it, this file wins.

## Where tasks live

Tasks for a project live in `<project>/.meridian/tasks.jsonl`: one compact JSON
object per line, no indentation, no wrapping array or `tasks` key.

```
{"id":"MERID-1","title":"..."}
{"id":"MERID-2","title":"..."}
```

A blank line is skipped on read. Any line that fails to parse aborts the whole
read with an error naming the line number — never a partial list, which would
otherwise get written back over the unreadable line and lose it for good. A
0-byte file is an error too, not an empty board: `saveTasks` never produces
0 bytes (an empty list still serializes as a single trailing newline), so
0 bytes means truncation.

`expected_results` does not travel on the line. It lives in
`<project>/.meridian/tasks/<id>.json`, holding exactly
`{"expected_results": ["...", "..."]}`. That file exists only when the array
is non-empty — a task with no results has no detail file, and reads back as
`expected_results: []`.

`.meridian/` is gitignored, so a clobbered `tasks.jsonl` is unrecoverable. Never
truncate the file, and never write it from an empty in-memory list.

## Task fields

| Field | Type | Written by |
|---|---|---|
| `id` | string, `<KEY>-<N>` | **server only** — generated on create |
| `title` | string, short imperative | agent, on create and via update |
| `status` | string, one of the ten below | agent / human |
| `priority` | string, one of the four below | agent (defaults to `medium`) |
| `justification` | string — the task's context: why it exists, what was asked for, or why it is blocked. The board calls it *Context & Description* and the operator edits it there | agent / human |
| `expected_results` | array of strings — concrete, mechanically verifiable outcomes | agent — detail file, not present in `GET /api/status` |
| `questions` | array of objects — a thread of exchanges, one entry per exchange. See **The questions array** below | agent / human |
| `operator_feedback` | string — the text of the operator's most recent revision request, also recorded as a `questions` entry | board, on Request AI Revision |
| `skip_auto_dispatch` | boolean — exclude this task from `Dispatch all` and the auto loop. Absent means included. Does **not** block the card's own `Dispatch` | **operator only** — agents must not set or clear it |
| `blockedBy` | array of task ids that must reach `done` first | agent |
| `parent` | string, id of another task on the same board, optional | agent |
| `spec_path` | string, e.g. `docs/tasks/MERID-1-spec.md` | agent |
| `mock_path` | string, e.g. `docs/tasks/MERID-1-mock.html` (interactive UI prototype) | agent |
| `spec_iterations` | integer, spec revision rounds consumed | agent |
| `code_review_iterations` | integer, code review revision rounds consumed | agent |
| `qa_iterations` | integer, QA revision rounds consumed | agent |
| `last_review_findings` | array of strings — **only** the current round's blocking findings; cleared on pass | agent |
| `running` | boolean — `true` while an agent is actively working the task | agent |
| `running_session` | string — the id of the session that set `running: true`, so the board can tell an orphaned flag from a live one. Written and cleared with `running` by the plugin's hook; never set it by hand | hook |
| `running_agent` | string — which harness set `running: true` (`claude` or `agy`). The board can only enumerate Claude Code's sessions, so a flag owned by anything else is never judged stale. Written and cleared with `running_session` | hook |
| `resume_context` | string — a brief note left at interruption to ease resuming; **cleared by the server on any status change** | agent, and the plugin's stop hook |
| `created_at` | ISO-8601 UTC string | **server only** |
| `updated_at` | ISO-8601 UTC string | **server only** |
| `moved_at` | ISO-8601 UTC string | **server only** |
| `completed_at` | ISO-8601 UTC string or `null` | **server only** |

The four timestamps are stamped by the server and **must never be written by an
agent**. `created_at` is set once on creation. `updated_at` is set on every
write. `moved_at` is set on every status change. `completed_at` is set when the
status enters `done` and set back to `null` when it leaves `done`. Sending any
of them in a write is refused by the server with HTTP 400.

`skip_auto_dispatch` is operator-owned, like `priority`. An agent must never
set or clear it: it records a human decision that this task is not for the
automatic loop. It is deliberately not named `auto_dispatch` — the
project-level flag says whether the loop runs, this says whether a task is
eligible, and one name for two things is a trap for whoever reads this next.

An empty string is not a valid value for any string field. If a field has no
value, omit it (on create) or do not mention it in the update payload.

A newly created task has no `spec_path`, no `spec_iterations`, no
`code_review_iterations`, no `qa_iterations`, no `last_review_findings`, no
`parent`, no `resume_context` and `blockedBy: []`. If it was created in `backlog`,
it also has no `expected_results` — authoring them is the generator's job, not the
creator's. A task created straight into `ready_todo` without them is a broken
task; the `pipeline.md` stage check will send it back to `backlog` on sight.

A task retains its `spec_path` through every stage that follows `spec_review`.
Even when blocked, the spec stays: moving a task to `blocked` because a
dependency is unmet does not invalidate the work already done on it, and the
unblocking sweep returns it to `ready_todo`, spec intact. See
`references/pipeline.md`.

A task may be created in **any** of the ten statuses, and the create endpoint
honours it — work that was already finished is recorded as `done`, not walked
through the pipeline to get there. `backlog` is only the default. What a later
status does *not* do is conjure the artefacts that status implies: a task created
at `code_review` still has no spec and no `expected_results`, and the stage checks
in `pipeline.md` are what notice. Create where reality is; let the pipeline fill
the gaps.

Never delete a task. Move it to `nope` instead.

## The questions array

`questions` is a thread between the operator and the agents. Each entry is one
exchange:

```json
{
  "id": "q-1789355006724",
  "by": "Operator",
  "question": "Why does the header count say 7 when the list shows 3?",
  "answer": "The count was hardcoded in the mock; four rows were missing.",
  "created_at": "2026-09-15T16:42:00.000Z",
  "answered_at": "2026-09-15T17:04:00.000Z"
}
```

Two rules govern the pair, and the board's rendering depends on both:

- **`question` is always what the author wrote.** `by` names that author —
  `Operator` or `Agent`. Never put a label, a title or a summary there: the
  board prints it as the message itself.
- **`answer` is always the other side's reply**, and it starts empty. The
  board renders an unanswered operator entry as *Awaiting AI answer* and an
  unanswered agent entry as an input box for the operator.

**To answer, fill the `answer` of the entry being answered.** Do not append a
new entry for your reply. An agent that answers by creating its own
`by: "Agent"` entry makes the board treat the reply as a fresh question *to*
the operator, and the agent's own words land in the operator's input box.
Set `answered_at` when you fill an answer.

A revision request the operator sends from the board is an ordinary entry with
`by: "Operator"` and the feedback in `question`; the same text is also stored
in the task's `operator_feedback`.

## The ten statuses

`status` must be **exactly** one of these ten lowercase strings. They carry no
spaces and no slashes. Do not invent new statuses or use synonyms like
`pending`, `todo`, `completed`, `in progress` or `qa/review`.

- `backlog`: Task is planned but not ready to be worked on yet.
- `spec_review`: Task needs specification or design review.
- `spec_approval`: Spec and Q&A awaiting human validation and approval.
- `ready_todo`: Task is fully specified and ready to be picked up by developer.
- `in_progress`: Task is currently being worked on by developer.
- `code_review`: Task code is being reviewed for architecture, security, and test quality.
- `qa_review`: Task is being verified independently by QA against expected results.
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
`.meridian/project-info.json` (e.g. `PROJ-1`, `WEB-4`, `MERID-12`) and `N` is
the next free integer for that key.

**The server generates the id.** Never compute one client-side, never guess the
next number, and never send an `id` in a create request — the server derives the
key from `project-info.json` and assigns `N` itself. Read the assigned id back
out of the create response.

The key has two fallbacks, which matter when onboarding a project:

- No `project-info.json`, or one that cannot be parsed → the key is the literal
  `TASK`, so the first id comes back as `TASK-1`.
- A `project-info.json` with no `key` field → the key is derived from `name`
  (initials for a multi-word name, the first five letters uppercased for a
  single word).

If ids come back as `TASK-N`, the project was not registered properly. Say so
rather than working around it.

## All writes go through the API

Every task write goes through the Meridian server. The server owns the
timestamps, so it is the only write path that keeps them consistent.

`$BASE` below is the server's base URL. Use `$BASE` in every request and never
hardcode the literal address — but note it is **not** resolved once and reused:
shell state does not survive between Bash tool invocations, so every block that
uses `$BASE` must set it on its own first line:

```bash
BASE="${MERIDIAN_URL:-http://localhost:3333}"
```

See `preamble.md`.

**Create** — `POST $BASE/api/projects/tasks`

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

`projectPath` and `title` are required. Create accepts only these fields, plus
an optional `status`. `running` is always `false` on a new task.

`status` defaults to `backlog` when omitted, and is honoured when given — it must
be one of the nine, or the request is rejected with HTTP 400, as an invalid
`priority` is. Creating straight into `done` stamps `completed_at` alongside the
other timestamps, exactly as moving a task into `done` later would.

The response is `{ "success": true, "task": { ... } }`; take the server-assigned
`id` from there.

**Update** — `PUT $BASE/api/projects/tasks/<task id>`

```json
{
  "projectPath": "/absolute/path/to/project",
  "status": "in_progress",
  "running": true
}
```

`projectPath` is required in the body — the task id goes in the URL path. Send
only the fields you are changing; omitted fields are left alone. Update accepts
`status`, `title`, `justification`, `priority`, `spec_path`, `spec_iterations`,
`code_review_iterations`, `qa_iterations`, `blockedBy`, `expected_results`,
`last_review_findings`, `parent` and `running`. Fields only settable through update —
`spec_path`, the three iteration counters and `last_review_findings` — are
absent from a freshly created task until the first update sets them; treat an
absent counter as `0` and an absent `last_review_findings` as `[]`.

**Read (board)** — `GET $BASE/api/status?project=<absolute project path>`

Returns the board's tasks without `expected_results` — the field dominated
the board payload and no consumer of this route read it. Use it to see statuses,
priorities, dependencies and everything else on the line.

**Read (one task, hydrated)** — `GET $BASE/api/projects/tasks/:taskId?project=<absolute project path>`

Returns `{ "task": { ... } }` with `expected_results` hydrated from its detail
file. This is the route a developer or QA dispatch uses to get a task's
expected results — `/api/status` no longer carries them. `400` when `project`
is missing, `404` when the id doesn't exist on that board.

Reading `tasks.jsonl` directly is fine when you only need to look, and so is
reading `tasks/<id>.json` for a task's `expected_results`.

**Hand-editing `tasks.jsonl` (and, when it's the results you're after,
`tasks/<id>.json`) is the fallback of last resort**, permitted only when the
server cannot be started at all, and only after telling the operator the
server is down. A hand-edit must reproduce the timestamp rules above exactly,
and if it touches both files, write the detail file first and the line
second — the line is what makes a task exist, and a detail file that arrived
early is merely inert, while one left behind stale would not be.
