---
name: meridian:work
description: Use when the operator wants to start or resume work on a specific Meridian task - drives it through the pipeline until done or blocked. Invoked as `/meridian:work` or `meridian:work`.
---

# Meridian Work

Drives one task through the Meridian pipeline until it reaches `done` or
`blocked`. Invoked as `meridian:work <TASKID>`.

This skill is the orchestrator. It sets every status, it dispatches the
specialists, it reads their verdicts, and it makes every task write through the
API. The specialists never write task state.

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

If the preamble stops, stop. Driving a task is a long sequence of writes, and
there is no hand-edit fallback for it — the server owns the timestamps.

## 2. Load the pipeline

Read `pipeline.md` now, before doing anything else, and follow it for
everything this file does not spell out.

It is the procedure: the two flows and their steps, the `running` flag rules,
the 5-round iteration cap and the stagnation check, the specialist-failure rule,
the commit after QA approves, the unblocking sweep, and the context
discipline that says what to keep from a specialist's report. This file
tells you which task to enter and where; that file tells you what happens next.
Where the two seem to differ, `pipeline.md` wins.

`stages.md` is the per-stage procedure — which agent each status dispatches and
what happens on each verdict. Read it when you are about to run a stage, not
before: `pipeline.md` alone tells you where to enter and what to verify, and a
task you refuse or reroute never needs the stage detail at all.

`schema.md` is the field, status, priority and API contract. Read it
when you need a field definition.

## 3. Resolve the task

Take the task id from the invocation argument. Fetch the board and find it:

```bash
BASE="${MERIDIAN_URL:-http://localhost:3333}"
curl -sS -G "$BASE/api/status" --data-urlencode "project=<absolute path of the current directory>"
```

Do not pass `limit` here — you need the whole board, both to find a task of any
rank and to run the unblocking sweep later.

**Check the response before you read anything into it.** An empty `tasks` array
is not proof of an empty board, and this skill is the one that acts on that
belief:

- If `errors` is non-empty, **stop and show it**. A malformed `tasks.jsonl` does
  not fail this request — the server records the parse error in `errors` and
  hands back `tasks: []`. Treating that as "no tasks" would send
  `meridian:pm` to decompose a plan onto a board whose backlog is merely
  unreadable, on top of tasks nobody can currently see. Fix the file first.
- If `projects` is empty, this directory is not in the workspace registry. Say
  so and stop; do not fall through to the bullets below.

Only once both checks pass does an empty `tasks` array mean an empty board.

- **No id was given.** Follow **Choosing which task** in
  `pipeline.md`: it picks within a stage and tells you to ask rather
  than guess across stages. If you want the across-stage choice made for you,
  that is `meridian:next`.
- **The id is not on the board.** Say so and stop. Do not create it.
- **`tasks.jsonl` is empty** — no tasks at all. There is nothing to work.
  Dispatch `meridian:pm` to decompose `docs/plans/implementation-plan.md`, or a
  feature description the operator gives you, into tasks first. `pm` creates the
  tasks and stops; it never runs them. Come back and work one once it has.

## 4. Enter at the stage the status indicates

The task's `status` is the entry point. Nothing restarts from the beginning.

**But never trust the status alone.** A status can be set by hand — through the
API, or by editing `tasks.jsonl` — so a task can sit at a stage whose
prerequisites were never produced. `references/pipeline.md`'s entry table gives
the check each stage must run first and where to send the task when it fails.
Run that check before dispatching anything. A failed check reroutes the task to
the stage that should have produced the missing artefact; it does not refuse.
A check that **passes** is silent: dispatch and move on, without narrating that
the spec exists or that the flags are consistent. A reroute earns a sentence —
what was missing and where the task went; a pass earns nothing.

| Status | Action |
|---|---|
| `backlog` | dispatch `meridian:spec-generator` |
| `spec_review` | dispatch `meridian:spec-reviewer` |
| `spec_approval` | **Do not start.** Awaits human review & sign-off on Kanban card. Report that the task is waiting in `spec_approval`, and stop. |
| `ready_todo` | dispatch `meridian:developer` |
| `in_progress` | dispatch `meridian:developer` **with the resumption briefing** (section 6) |
| `code_review` | dispatch `meridian:code-reviewer` |
| `qa_review` | dispatch `meridian:qa` |
| `blocked` | **Do not start.** Report `justification` and `blockedBy`, and stop. |
| `done`, `nope` | **Refuse.** See section 7. |

`running: true` is not an entry point of its own — it is a flag, and a task
carrying it was interrupted. Say so, then enter at its `status` row above.

## 5. One invocation carries the task as far as it goes

A task flows through consecutive stages until it reaches a human gate or terminal state.
A `backlog` task runs spec generation and spec review, landing in `spec_approval` where
it pauses for the operator to review the spec and answer questions. Once approved by the
operator into `ready_todo`, an invocation runs implementation, code review and QA, is committed,
and lands in `done`.

Stop only where `pipeline.md` says to stop: the task lands in `spec_approval` (awaiting
human validation), reaches `done`, or lands in `blocked` — by the iteration cap, by the
stagnation check, or by a specialist failure. Report where it ended and why.

**One task at a time.** Never drive two tasks concurrently.

## 6. Resumption briefing — `in_progress` only

An `in_progress` task may have left partial work in the working tree: a
half-written module, a staged test, a change already made. So when, and only
when, the entry status is `in_progress`, the `meridian:developer` dispatch
carries a resumption briefing on top of its normal payload:

- **the stage it stopped at** — that it was mid-implementation, and whether it
  got there from `ready_todo` or was sent back by code review or QA;
- **the open round's `last_review_findings`** — the blocking findings it had not
  finished addressing, verbatim, and nothing else from that round;
- **the task's `resume_context`, verbatim, when it has one** — the note left at
  the moment of interruption. The server clears it automatically when the task
  moves on; do not clear it yourself.
- **an instruction to establish actual state with `git status` and `git diff`
  before writing anything.** Not after, not alongside — before. A developer that
  starts writing before it looks either redoes work that is already in the tree
  or overwrites it.

**No other status gets a briefing.** `code_review` and `qa_review` simply
dispatch their agent and run the stage from the top: a review is never
half-done. It either returned a verdict, in which case the task would not still
be sitting in that status, or it did not, in which case there is nothing
partial to resume — only a review to rerun. `backlog` and `spec_review` are the
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
`pipeline.md` — which runs when some *other* task reaches `done` —
moves a dependency-blocked task back to `backlog`, and nothing but a human
clears a task blocked by an iteration cap or a specialist failure.

## 8. Every transition goes through the API

Every status change, every `running` flip, every counter increment, every
`spec_path` and `last_review_findings` write is one request:

```bash
BASE="${MERIDIAN_URL:-http://localhost:3333}"
curl -sS -X PUT "$BASE/api/projects/tasks/<task id>" \
  -H 'Content-Type: application/json' \
  -d '{"projectPath":"<absolute path of the current directory>","status":"in_progress","running":true}'
```

`projectPath` goes in the body; the id goes in the URL. Send only the fields
you are changing. Never send `id`, `created_at`, `updated_at`, `moved_at` or
`completed_at` — the server owns all five. Never edit `.meridian/tasks.jsonl` or
`.meridian/tasks/<id>.json` by hand.

`running` is part of this, not an afterthought: `true` before every dispatch,
`false` when that specialist returns whatever its verdict, and `false` on
`done`, `blocked` and `nope`. The server does not touch `running` when it
stamps `completed_at`, so clearing it on the way into `done` is yours to do, in
the same request. Check the response of each write; a `400` means an invalid
status or priority, and guessing past it corrupts the board.

## 9. Dispatching a specialist

Follow **Dispatching a specialist** in `pipeline.md`, and pass each
step exactly what that step says to pass — the isolation rules there are the
reason the verdicts are worth anything.

One mechanical point that is easy to get wrong: a subagent inherits nothing
from you, **including this skill's base directory**. No base directory line is
injected into an agent, so an agent cannot recover from a bad path — it will
simply fail to find the file and carry on guessing at field names. A relative
path, or the literal text `${CLAUDE_PLUGIN_ROOT}`, is likewise unresolvable
inside an agent.

So resolve `schema.md` yourself, with the two-path procedure of section 0, and
put the **resolved absolute path** in every dispatch prompt — `meridian:pm`
included. The base directory the harness names is this skill's own folder, two
levels below the plugin's `references/`, so a path built from it directly lands
on `skills/work/references/schema.md`, which does not exist. Confirm the path
you are about to hand over first:

```bash
test -f "<resolved absolute path>" && echo ok || echo BAD
```

If it prints `BAD`, do not dispatch. Resolve the other candidate from section 0
and test again; if neither exists, say so and stop.

## 10. Report

Say where the task started, which stages it passed, how many revision rounds
each stage consumed, and where it ended — `done` with its commit, or `blocked`
with the `justification` you recorded. If it reached `done`, report what the
unblocking sweep freed. Keep the specialists' reports out of it: the verdict
and the blocking findings are all you retained.
