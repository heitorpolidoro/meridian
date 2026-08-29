---
name: next
description: Use when the operator does not know which Meridian task to pick up next - selects the task closest to done and hands it to work.
---

# Meridian Next

Picks the one task to work now — the one closest to finished — and hands it to
`meridian:work`. Invoked as `meridian:next`.

This skill selects and explains. It writes nothing. Every transition belongs to
`meridian:work`.

## 0. Resolve the shared references

`preamble.md`, `pipeline.md`, `stages.md` and `schema.md` are shared by all four
Meridian skills and live in the plugin's own `references/` directory — **not** inside
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

## 2. Read the whole board

```bash
BASE="${MERIDIAN_URL:-http://localhost:3333}"
curl -sS -G "$BASE/api/status" --data-urlencode "project=<absolute path of the current directory>"
```

No `limit`. The selection has to see every candidate: with `limit=5` the server
returns only the top five of each status, and the one task sitting in `qareview`
could be the sixth in a status you never looked past. The unlimited response
comes back in **file order, unranked** — the ordering below is yours to apply.

If `errors` is non-empty, show it before selecting. A malformed `tasks.json`
means the board you are choosing from is not the whole board.

## 3. Select right-to-left along the pipeline

Consider the six runnable statuses in this order — closest to finished first:

```
qareview → codereview → inprogress → readytodo → specreview → backlog
```

Take the first status in that sequence that has any task in it. That status is
the stage; everything after it is irrelevant this invocation.

`blocked`, `done` and `nope` are **skipped entirely**. They are not candidates
at any priority. A `blocked` task is waiting on something it cannot clear by
being picked, and `done` and `nope` are finished. Handing any of the three to
`meridian:work` produces no work: it refuses `done` and `nope` outright, and it
reports a `blocked` task's `justification` and `blockedBy` rather than starting
it. Selecting one would just spend an invocation to be told that.

Why right-to-left: a task in `qareview` is one verdict away from being
committed and shipped. A task in `backlog` has not been specified yet. Starting
the `backlog` task leaves the `qareview` task sitting in flight, half-paid-for,
with its working tree waiting on it — and work in flight that nobody finishes is
the expensive kind.

## 4. Then priority, then age — inside the stage only

The ordering is **three levels, in this order**:

1. **Stage**, per the sequence in section 3.
2. **Priority** — `critical`, then `high`, then `medium`, then `low`. A task
   with no priority counts as `medium`.
3. **Oldest `created_at`** first, breaking ties within a priority.

Levels 2 and 3 apply **only among the tasks already selected by level 1**.
Priority breaks ties *within* a stage and **never crosses stages**.

State this plainly, because it looks like an oversight and invites being
"simplified" into a flat sort by priority: a `critical` task in `backlog` must
**not** jump ahead of a `low` task in `qareview`. That is not a bug in the
ordering — it is the whole point of it. Priority says which work matters most
to *start*; stage says which work is closest to *finishing*. Sorting by
priority first would start the urgent thing and abandon the nearly-finished
thing, which is how a board fills up with tasks stuck at 90%. The urgent
`backlog` task is next in line — it is chosen the moment the `qareview` task
clears.

If the operator wants the `critical` task worked first anyway, that is a
legitimate override; they invoke `meridian:work <TASKID>` directly with the id.
This skill does not make that call for them.

## 5. Report the pick, then hand it over

Say which task you chose — `id`, `title`, `status`, `priority` — and **why**, in
those three levels: the stage it won on, the priority that won within that
stage, and the `created_at` tiebreak if one was needed. Name the runner-up when
there was one, so the operator can see the choice rather than trusting it.

Say so explicitly whenever the pick was not the highest-priority task on the
board: "`X` is `critical` in `backlog`, but `Y` in `qareview` is closer to done,
so `Y` goes first." That sentence is the one that stops the choice from looking
like a mistake.

Two related things also worth saying out loud, both from
`pipeline.md`: the dashboard's kanban columns are ordered by task
**id number**, not by priority, so your pick is often not the top card in the
operator's column; and a task found with `running: true` was interrupted, not
active — no agent from a previous session is still alive. An interrupted task
is a normal candidate, selected by exactly the rules above.

Then hand the chosen id to `meridian:work`, which enters it at the stage its
status indicates and owns everything from there — including the resumption
briefing an `inprogress` task needs.

## 6. When there is nothing to pick

If all six runnable statuses are empty, say so plainly, and say what the board
does hold — for example that everything is `done`, or that every remaining task
is `blocked`.

Then suggest the next move rather than stopping flat:

- `meridian:new "<title>"` — the skill that adds a single task, or
- the `meridian:pm` agent, to decompose a plan or a feature into a whole set of
  tasks. `pm` creates tasks and stops; it never runs them. If the operator asks
  you to dispatch it, put the **resolved absolute path** of `schema.md` in the
  prompt — resolve it with the two-path procedure of section 0 and confirm it
  with `test -f` first. That path is the only one `pm` is given, and an agent
  gets no base directory of its own to recover a bad one from.

If the only tasks left are `blocked`, list them with their `justification` and
`blockedBy`. A `blocked` task whose dependencies are now all `done` is stale and
should have been swept back to `backlog` — `meridian:status` reports that case.
