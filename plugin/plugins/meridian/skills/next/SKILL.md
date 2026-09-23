---
name: meridian:next
description: Use when the operator does not know which Meridian task to pick up next - selects the task closest to done and hands it to work. Invoked as `/meridian:next` or `meridian:next`.
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
one exists by READING it — `Read` the first candidate, and if that read fails,
read the second — then use the path that worked everywhere this file asks for
one. Do not probe with a shell command. A headless dispatch runs under a
permission allowlist that matches a command by its prefix, so `test -f`, and
above all the loop an agent naturally writes to try both candidates at once, is
refused before it runs; a failed `Read` is the same test and needs no
permission. The plugin's permission hook allows reading these files.

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
curl -sS -G "$BASE/api/status" \
  --data-urlencode "project=<absolute path of the current directory>" -d 'workable=1'
```

With `workable=1` the server returns **only the candidates, already in selection
order**. `done`, `nope` and `blocked` never come back — they are not candidates
at any priority — and what does come back is sorted by the rule below, so the
first task in the list is the pick. Do not fetch the board unlimited to select
from it (on a mature board most tasks are finished noise), and do not re-sort
what comes back: the ordering is the server's, and reimplementing it here is how
the two drift apart. The rule is still spelled out below because you must be
able to *explain* the pick, not because you apply it.

If `errors` is non-empty, show it before selecting. A malformed `tasks.jsonl`
means the board you are choosing from is not the whole board.

## 3. Select right-to-left along the pipeline

Consider the six runnable statuses in this order — closest to finished first:

```
qa_review → code_review → in_progress → ready_todo → spec_review → backlog
```

Take the first status in that sequence that has any task in it. That status is
the stage; everything after it is irrelevant this invocation.

`blocked`, `done` and `nope` are **skipped entirely**. They are not candidates
at any priority. A `blocked` task is waiting on something it cannot clear by
being picked, and `done` and `nope` are finished. Handing any of the three to
`meridian:work` produces no work: it refuses `done` and `nope` outright, and it
reports a `blocked` task's `justification` and `blockedBy` rather than starting
it. Selecting one would just spend an invocation to be told that.

Why right-to-left: a task in `qa_review` is one verdict away from being
committed and shipped. A task in `backlog` has not been specified yet. Starting
the `backlog` task leaves the `qa_review` task sitting in flight, half-paid-for,
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
**not** jump ahead of a `low` task in `qa_review`. That is not a bug in the
ordering — it is the whole point of it. Priority says which work matters most
to *start*; stage says which work is closest to *finishing*. Sorting by
priority first would start the urgent thing and abandon the nearly-finished
thing, which is how a board fills up with tasks stuck at 90%. The urgent
`backlog` task is next in line — it is chosen the moment the `qa_review` task
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
board: "`X` is `critical` in `backlog`, but `Y` in `qa_review` is closer to done,
so `Y` goes first." That sentence is the one that stops the choice from looking
like a mistake.

Two related things also worth saying out loud, both from
`pipeline.md`: the dashboard's kanban columns are ordered by task
**id number**, not by priority, so your pick is often not the top card in the
operator's column; and a task found with `running: true` was interrupted, not
active — no agent from a previous session is still alive. An interrupted task
is a normal candidate, selected by exactly the rules above.

Then hand the chosen id to `meridian:work` **immediately — do not ask for
confirmation first**. Being asked "shall I proceed?" after invoking a skill
whose whole job is to proceed is friction, not safety: the operator invoked
`next` precisely to have the choice made and acted on. The report above is what
keeps the choice inspectable; the operator can always interrupt.

`meridian:work` enters the task at the stage its status indicates and owns
everything from there — including the resumption briefing an `in_progress` task
needs.

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
  by reading that file first. That path is the only one `pm` is given, and an agent
  gets no base directory of its own to recover a bad one from.

If the only tasks left are `blocked`, list them with their `justification` and
`blockedBy`. A `blocked` task whose dependencies are now all `done` is stale and
should have been swept back to `backlog` — `meridian:status` reports that case.
