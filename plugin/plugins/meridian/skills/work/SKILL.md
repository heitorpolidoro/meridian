---
name: work
description: Use when the operator wants to start or resume work on a specific Meridian task - drives it through the pipeline until done or blocked.
---

# Meridian Work

Drives one task through the Meridian pipeline until it reaches `done` or
`blocked`. Invoked as `meridian:work <TASKID>`.

This skill is the orchestrator. It sets every status, it dispatches the
specialists, it reads their verdicts, and it makes every task write through the
API. The specialists never write task state.

## 1. Perform the shared preamble

Follow `references/preamble.md` in order, and stop where it says stop. It
resolves `$BASE`, resolves the project to the current working directory (never a
parent), and gets the server running. Do not repeat or shortcut any of its
steps here.

If the preamble stops, stop. Driving a task is a long sequence of writes, and
there is no hand-edit fallback for it — the server owns the timestamps.

## 2. Load the pipeline

Read `references/pipeline.md` now, before doing anything else, and follow it for
everything this file does not spell out.

It is the procedure: the two flows and their steps, the `running` flag rules,
the 5-round iteration cap and the stagnation check, the specialist-failure rule,
the commit at the end of Fluxo B, the unblocking sweep, and the context
discipline that says what to keep from a specialist's report. This file
tells you which task to enter and where; that file tells you what happens next.
Where the two seem to differ, `references/pipeline.md` wins.

`references/schema.md` is the field, status, priority and API contract. Read it
when you need a field definition.

## 3. Resolve the task

Take the task id from the invocation argument. Fetch the board and find it:

```bash
curl -sS -G "$BASE/api/status" --data-urlencode "project=<absolute path of the current directory>"
```

Do not pass `limit` here — you need the whole board, both to find a task of any
rank and to run the unblocking sweep later.

**Check the response before you read anything into it.** An empty `tasks` array
is not proof of an empty board, and this skill is the one that acts on that
belief:

- If `errors` is non-empty, **stop and show it**. A malformed `tasks.json` does
  not fail this request — the server records the parse error in `errors` and
  hands back `tasks: []`. Treating that as "no tasks" would send
  `meridian:pm` to decompose a plan onto a board whose backlog is merely
  unreadable, on top of tasks nobody can currently see. Fix the file first.
- If `projects` is empty, this directory is not in the workspace registry. Say
  so and stop; do not fall through to the bullets below.

Only once both checks pass does an empty `tasks` array mean an empty board.

- **No id was given.** Follow **Choosing which task** in
  `references/pipeline.md`: it picks within a stage and tells you to ask rather
  than guess across stages. If you want the across-stage choice made for you,
  that is `meridian:next`.
- **The id is not on the board.** Say so and stop. Do not create it.
- **`tasks.json` is empty** — no tasks at all. There is nothing to work.
  Dispatch `meridian:pm` to decompose `docs/plans/implementation-plan.md`, or a
  feature description the operator gives you, into tasks first. `pm` creates the
  tasks and stops; it never runs them. Come back and work one once it has.

## 4. Enter at the stage the status indicates

The task's `status` is the entry point. Nothing restarts from the beginning.

| Status | Action |
|---|---|
| `backlog` | Fluxo A step 1 — dispatch `meridian:spec-generator` |
| `specreview` | Fluxo A step 2 — dispatch `meridian:spec-reviewer` |
| `readytodo` | Fluxo B step 1 — dispatch `meridian:developer` |
| `inprogress` | Fluxo B step 1 — dispatch `meridian:developer` **with the resumption briefing** (section 6) |
| `codereview` | Fluxo B step 2 — dispatch `meridian:code-reviewer` |
| `qareview` | Fluxo B step 3 — dispatch `meridian:qa` |
| `blocked` | **Do not start.** Report `justification` and `blockedBy`, and stop. |
| `done`, `nope` | **Refuse.** See section 7. |

`running: true` is not an entry point of its own — it is a flag, and a task
carrying it was interrupted. Say so, then enter at its `status` row above.

## 5. One invocation carries the task as far as it goes

A task flows through **consecutive stages in a single invocation**. It does not
stop at a stage boundary waiting to be invoked again. A `backlog` task runs all
of Fluxo A and continues straight into Fluxo B without a second call to this
skill; a `readytodo` task runs implementation, code review and QA, is committed,
and lands in `done`.

Stop only where `references/pipeline.md` says to stop: the task reaches `done`,
or it lands in `blocked` — by the iteration cap, by the stagnation check, or by
a specialist failure. Report where it ended and why.

**One task at a time.** Never drive two tasks concurrently.

## 6. Resumption briefing — `inprogress` only

An `inprogress` task may have left partial work in the working tree: a
half-written module, a staged test, a change already made. So when, and only
when, the entry status is `inprogress`, the `meridian:developer` dispatch
carries a resumption briefing on top of its normal payload:

- **the stage it stopped at** — that it was mid-implementation, and whether it
  got there from `readytodo` or was sent back by code review or QA;
- **the open round's `last_review_findings`** — the blocking findings it had not
  finished addressing, verbatim, and nothing else from that round;
- **an instruction to establish actual state with `git status` and `git diff`
  before writing anything.** Not after, not alongside — before. A developer that
  starts writing before it looks either redoes work that is already in the tree
  or overwrites it.

**No other status gets a briefing.** `codereview` and `qareview` simply
dispatch their agent and run the stage from the top: a review is never
half-done. It either returned a verdict, in which case the task would not still
be sitting in that status, or it did not, in which case there is nothing
partial to resume — only a review to rerun. `backlog` and `specreview` are the
same, against the spec instead of the tree. Inventing a briefing for those
stages feeds a reviewer context it is meant not to have.

## 7. Refusing `done` and `nope`

A task in `done` or `nope` is finished. **Refuse to work it**, and do not
"try anyway" by moving it back into the pipeline yourself.

Reopening is an explicit operator action, because it is not free: the server
clears `completed_at` back to `null` the moment the status leaves `done`, and
the record of when the work finished is gone. Tell the operator that, name the
task and its current status, and let them decide. If they say to reopen it,
they are choosing the new status — move it there and work it from that row of
the table in section 4.

`blocked` is a report, not a refusal. Print the task's `justification` and its
`blockedBy` ids with each one's current status, so the operator can see what it
is waiting on, and stop. Only the unblocking sweep in
`references/pipeline.md` — which runs when some *other* task reaches `done` —
moves a dependency-blocked task back to `backlog`, and nothing but a human
clears a task blocked by an iteration cap or a specialist failure.

## 8. Every transition goes through the API

Every status change, every `running` flip, every counter increment, every
`spec_path` and `last_review_findings` write is one request:

```bash
curl -sS -X PUT "$BASE/api/projects/tasks/<task id>" \
  -H 'Content-Type: application/json' \
  -d '{"projectPath":"<absolute path of the current directory>","status":"inprogress","running":true}'
```

`projectPath` goes in the body; the id goes in the URL. Send only the fields
you are changing. Never send `id`, `created_at`, `updated_at`, `moved_at` or
`completed_at` — the server owns all five. Never edit `.meridian/tasks.json` by
hand.

`running` is part of this, not an afterthought: `true` before every dispatch,
`false` when that specialist returns whatever its verdict, and `false` on
`done`, `blocked` and `nope`. The server does not touch `running` when it
stamps `completed_at`, so clearing it on the way into `done` is yours to do, in
the same request. Check the response of each write; a `400` means an invalid
status or priority, and guessing past it corrupts the board.

## 9. Dispatching a specialist

Follow **Dispatching a specialist** in `references/pipeline.md`, and pass each
step exactly what that step says to pass — the isolation rules there are the
reason the verdicts are worth anything.

One mechanical point that is easy to get wrong: a subagent inherits nothing
from you, **including this skill's base directory**. When this skill is
invoked the harness gives you a line reading `Base directory for this skill:
<absolute path>`. Build the absolute path of `references/schema.md` from that
line and put it in every dispatch prompt. A relative path, or the literal text
`${CLAUDE_PLUGIN_ROOT}`, is unresolvable inside an agent — it will simply fail
to find the file and carry on guessing at field names.

## 10. Report

Say where the task started, which stages it passed, how many revision rounds
each stage consumed, and where it ended — `done` with its commit, or `blocked`
with the `justification` you recorded. If it reached `done`, report what the
unblocking sweep freed. Keep the specialists' reports out of it: the verdict
and the blocking findings are all you retained.
