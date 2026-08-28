---
name: status
description: Use when the operator asks for the Meridian board state of the current project - lists the top tasks per status and surfaces interrupted work.
---

# Meridian Status

Reports the current project's board: the top tasks in each status, any
dependency inconsistency, and any work that was left running when a previous
session ended. Invoked as `meridian:status`.

This skill is **read-only**. It issues `GET` requests and nothing else. It never
creates, updates or deletes a task, and it never edits `.meridian/` by hand.
Field names, statuses and priorities follow `schema.md`; if anything
here disagrees with that file, that file wins.

## 0. Resolve the shared references

`preamble.md`, `pipeline.md` and `schema.md` are shared by all four Meridian
skills and live in the plugin's own `references/` directory — **not** inside
this skill's own folder. Wherever this file names one of them, resolve it by
trying these two paths in order and using the first that exists:

1. `${CLAUDE_PLUGIN_ROOT}/references/<file>.md`
2. `../../references/<file>.md`, relative to the `Base directory for this
   skill: <absolute path>` line the harness states at invocation — use this
   when the first path does not exist, or when `${CLAUDE_PLUGIN_ROOT}` arrives
   unexpanded, as that literal text.

Both are given because only one of them is directly observed: the base
directory line appears on every invocation, while the expansion of
`${CLAUDE_PLUGIN_ROOT}` inside skill prose is unverified either way. Test which
one exists — `test -f <candidate>` — before reading it, and use that resolved
absolute path everywhere this file asks for one.

Never read a bare `references/<file>.md`. Relative to this skill's own folder
that path does not exist, and the read fails.

## 1. Perform the shared preamble

Follow `preamble.md` in order, and stop where it says stop. It
resolves `$BASE`, resolves the project to the current working directory (never a
parent), and gets the server running. Do not repeat or shortcut any of its
steps here.

`$BASE` does not survive between bash calls: shell state is not shared across
Bash tool invocations, only the working directory is. Every block below sets
`BASE` again on its own first line, and so must every block you write. A block
that inherits nothing runs with `BASE` empty and requests a relative URL.

If the operator declines registration, stop — there is no board to report.

If the server cannot be started, the preamble's read-only fallback applies:
read `./.meridian/tasks.json` directly. It is a bare JSON array in file order,
so you must apply the ordering of section 2 yourself in that case, and say that
you are reporting from the file because the server is down.

## 2. Fetch the board — twice, for two different jobs

```bash
BASE="${MERIDIAN_URL:-http://localhost:3333}"
PROJECT="<absolute path of the current directory>"

# a) the display table: server-ordered, capped at five per status
curl -sS -G "$BASE/api/status" --data-urlencode "project=$PROJECT" -d 'limit=5'

# b) the analysis set: every task, for sections 4 and 5
curl -sS -G "$BASE/api/status" --data-urlencode "project=$PROJECT"
```

Two calls, because the two jobs need different things:

- **With `limit=5`** the server ranks each status and returns only the top five
  of each. It ranks the eight unfinished statuses by priority — `critical`
  before `high` before `medium` before `low`, with an absent priority read as
  `medium` — and then by oldest `created_at` first. **`done` is ranked
  differently**: by `completed_at` **descending**, so the five you get back are
  the five most recently finished, which is the useful five. Priority and
  `created_at` do not enter into it.
  That ranking and that default are exactly what the table should show, so take
  the table from this response. While the server is answering, do not re-sort it
  and do not build the table from `tasks.json` instead: the ordering and the
  `medium` default are the server's, and reimplementing them here is how the two
  drift apart. (Reading the file is the section 1 fallback for a server that
  will not start, and only then.)
- **Without `limit`** the server returns every task, unranked, in file order.
  Sections 4 and 5 must see the whole board — a `blocked` task or an
  interrupted task ranked sixth in its status is exactly the one worth
  surfacing — so they read this response. Do not read any ranking into its
  order; there is none.

The response shape is `{ "projects": [ ... ], "errors": [ ... ] }`. With
`project=` set, `projects` holds at most one entry, and its `tasks` array is
what you want. If `projects` is empty, this directory is not in the workspace
registry — say so rather than reporting an empty board. If `errors` is
non-empty, show it: a malformed `tasks.json` or a missing project path is
reported there, and a silent empty board would otherwise look like a clean one.

## 3. Show the board

Print one compact table grouped by status, in pipeline order:

`backlog`, `specreview`, `readytodo`, `inprogress`, `codereview`, `qareview`,
`blocked`, `done`, `nope`.

One row per task: `id`, `title`, `priority`, and `running` when it is `true`.
Skip a status with no tasks rather than printing an empty group.

Each group shows at most five tasks. Take the per-status totals from the
unlimited response and say when a group is truncated — `blocked (7, showing 5)`
— so the operator can tell a five-task status from a fifty-task one.

## 4. Consistency line

Report every task with status `blocked` whose `blockedBy` ids are **all**
`done`. Evaluate this against the unlimited response, so that both the blocked
tasks and the `done` tasks they point at are complete: with `limit=5` only five
`done` tasks come back, and a dependency ranked sixth would read as not-done
and hide a real finding.

A `blocked` task with an **empty** `blockedBy` is not a finding here. It was
blocked by an iteration cap or a specialist failure, not by a dependency, and
only a human clears it. Report those separately, with their `justification`, so
they are visible without being mistaken for stale dependency blocks.

If a `blockedBy` id matches no task on the board, say so — a dangling
dependency can never reach `done`, so the task it blocks is stuck permanently.

State the consistency line plainly either way. When nothing is stale, say
"No blocked task has all its dependencies done." Silence reads as "not
checked".

Do not unblock anything. Moving those tasks back to `backlog` is the unblocking
sweep in `pipeline.md`, which runs inside `work`; this skill only
reports.

## 5. Interrupted tasks

Report every task where **either**:

- `status` is `inprogress`, **or**
- `running` is `true`.

Check the two conditions **independently** and take the union. They are not the
same set. `running: true` is set around every specialist dispatch, so during a
live run it legitimately appears on a task in `backlog` (spec generation),
`specreview` (spec review), `codereview` and `qareview` as well as
`inprogress`. Testing only `status == "inprogress"`, or only
`running == true`, misses half the cases.

Why both flags mean abandoned work: this skill runs in a **fresh session**. No
agent dispatched by a previous session is still alive — when that session
ended, its subagents ended with it. So a task that says an agent is working it,
or that sits in the status the developer occupies while working, is describing
work that stopped mid-flight. Neither flag can be true and honest at the moment
this skill reads the board.

For each interrupted task report `id`, `title`, `status`, `running`, and the
open round's `last_review_findings` if it has any.

## 6. Offer to resume

If section 5 found nothing, say so and stop.

If it found anything, **ask the operator** whether to resume one, and which.
Ask; do not pick one and start it. If they decline, stop — leave the task
exactly as it is, including its `running` flag. Clearing a stale `running` is a
write, and this skill does not write.

On a yes, hand the chosen id to `meridian:work`, which owns every transition
from here. `work` re-enters the task at the stage its status indicates and is
the only thing that writes task state.

When the chosen task's status is `inprogress`, say so explicitly in the
hand-off: an interrupted `inprogress` task may have left partial work in the
working tree, so `work` owes its `meridian:developer` dispatch the **resumption
briefing** defined in `meridian:work`. Do not restate the briefing's contents
here — `work` assembles dispatch payloads and holds those rules; the status is
the fact you are handing over.

A task interrupted in any other status needs no briefing. Those stages produce
a spec or a verdict, not a working tree.
