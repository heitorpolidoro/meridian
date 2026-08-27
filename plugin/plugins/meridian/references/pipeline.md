# The Meridian Pipeline

How a task travels from `backlog` to `done`. This file is the procedure; the
skill that reads it is the thing that executes it. Read `schema.md` for field
names, status values and the API contract — this file assumes them.

You drive the pipeline yourself: you set every status, you dispatch the
specialist subagents, you read their verdicts, and you make every task write
through the API. The specialists never write task state.

Two flows, run in order:

- **Fluxo A — spec.** Turn a `backlog` task into an approved spec, ending at
  `readytodo`.
- **Fluxo B — build.** Turn a `readytodo` task into committed, reviewed,
  QA-verified work, ending at `done`.

**One task at a time.** Never run Fluxo A or Fluxo B on more than one task
concurrently. Finish or block the current task before picking up another.

All specs, commits and agent communications are in **English**.

## Where to enter

A task's current status tells you where to resume. Nothing needs to restart from
the beginning.

| Status | Enter at |
|---|---|
| `backlog` | Fluxo A, step 1 |
| `specreview` | Fluxo A, step 2 |
| `readytodo` | Fluxo B, step 1 |
| `inprogress` | Fluxo B, step 1 (re-dispatch the developer) |
| `codereview` | Fluxo B, step 2 |
| `qareview` | Fluxo B, step 3 |
| `blocked` | Not runnable. See **Unblocking**. |
| `done`, `nope` | Nothing to do. |

A task found with `running: true` and no live agent behind it was interrupted.
Say so, and resume it from its status row above.

## Choosing which task

Normally you are given an explicit task id and this question does not arise —
work that task. The rule below is the fallback for when you are not.

Within a single stage — several tasks sitting in `backlog`, or several in
`readytodo` — pick in this order:

1. **Priority**, `critical` before `high` before `medium` before `low`. A task
   with no priority counts as `medium`.
2. **Oldest `created_at`** first, breaking ties within a priority.

This is the ordering the server itself applies when it ranks tasks within a
status. Use it; do not invent a different one.

One caveat worth stating out loud when you report your pick: the dashboard's
kanban columns are ordered by task **id number**, not by priority. So the task
you choose is not always the top card in the operator's column — a `critical`
task created late outranks a `low` one created first, while the board shows the
`low` one higher. When your pick is not the visible top card, say which task you
picked and why.

Choosing *across* stages — whether to spec a `backlog` item or build a
`readytodo` one — is not decided here. That is the `next` skill's job. If you
have no id and tasks are waiting in more than one stage, say which candidates
you found and ask, rather than guessing.

## Dispatching a specialist

Every dispatch prompt carries what the specialist needs, because a subagent
inherits nothing from you — no working directory context, no skill base
directory, no conversation.

In particular, an agent cannot resolve a path to this plugin's own files on its
own. When you dispatch any of the five specialists, **pass the absolute path of
`references/schema.md`** in the prompt, the same way you pass a spec path. Build
it from the base directory the harness gives you when this skill is invoked
("Base directory for this skill: ..."). Without it, a specialist that needs a
field definition has nowhere to look.

Beyond that, pass only what each step below says to pass — the isolation rules
there are deliberate.

## The `running` flag

`running` marks a task that an agent is actively working right now. Maintain it
on **every** transition, through the API, never by hand:

- Set `running: true` **before** dispatching a specialist.
- Set `running: false` **when that specialist returns**, whatever its verdict.
- Set `running: false` when the task lands in `done`, `blocked` or `nope`.

Do not leave a task `running: true` across a stop, a block, or the end of a
session. A stale `true` is what makes the board look like work is in flight when
nothing is.

## Fluxo A — spec

For a task in `backlog`:

1. **Generate the spec.** Set `running: true`. Dispatch `meridian:spec-generator`
   with the task title, its `expected_results`, the `spec_path` of every task in
   `blockedBy`, and a pointer to `AGENTS.md`. It writes
   `docs/tasks/<id>-spec.md`. When it returns, set `running: false` and record
   `spec_path`.

2. **Review the spec.** Move the task to `specreview`. Set `running: true`.
   Dispatch `meridian:spec-reviewer` with **only** the spec path and the task's
   `expected_results` — nothing about how the spec was produced. When it
   returns, set `running: false`.

3. **On `APPROVED`:** move the task to `readytodo` and clear
   `last_review_findings` to `[]` in the same update. The task is now ready for
   Fluxo B. (No unblocking sweep here — dependents wait for `done`, not for an
   approved spec.)

4. **On `NEEDS_REVISION`:** run the **stagnation check** below. If it clears,
   increment `spec_iterations`, store the reviewer's blocking findings in
   `last_review_findings`, set `running: true`, and redispatch
   `meridian:spec-generator` with **the findings only** — not the whole review,
   not the previous conversation. When it returns, set `running: false` and go
   back to step 2.

5. **Suggestions.** Append the reviewer's non-blocking suggestions to
   `docs/suggestions-log.md` under a heading `## [<id>] <title> — <date>`, then
   trim that file to its last 30 entries so it cannot grow without bound.

## Fluxo B — build

For a task in `readytodo`:

1. **Implement.** Move the task to `inprogress`. Set `running: true`. Dispatch
   `meridian:developer` with the `spec_path` and the task's `expected_results`.
   It works TDD and stages its changes with `git add` without committing. When it
   returns, set `running: false`.

2. **Code review.** Move the task to `codereview`. Set `running: true`. Dispatch
   `meridian:code-reviewer` with the `spec_path`; it scopes its own review with
   `git diff --stat`. When it returns, set `running: false`.
   - **`APPROVED`** → continue to step 3.
   - **`NEEDS_REVISION`** → run the **stagnation check**. If it clears, increment
     `code_review_iterations`, store the blocking findings in
     `last_review_findings`, move the task back to `inprogress`, set
     `running: true`, and redispatch `meridian:developer` with the findings only.
     When it returns, set `running: false` and repeat step 2.

3. **QA.** Move the task to `qareview`. Set `running: true`. Dispatch
   `meridian:qa` with **only** the task's `expected_results` plus pointers to the
   running system. Never pass it the developer's reasoning, the developer's
   report, or the code reviewer's verdict — its independence is the point. When
   it returns, set `running: false`.
   - **`APPROVED`** → commit the staged work. The developer already staged its
     implementation with `git add`, so the index is the change; add only the
     pipeline's own artifacts on top of it, by explicit path:

     ```bash
     git add -- "<spec_path>" docs/suggestions-log.md
     git commit -m "<id>: <title>"
     ```

     Never `git add -A` or `git add .` here — those sweep every unrelated change
     in the working tree into the task's commit. Check `git status` first; if
     something unexpected is already staged, stop and ask rather than committing
     it.

     Then update the task to `status: "done"` with `running: false` in the same
     request — the server stamps `completed_at` on the transition but does not
     touch `running`, so you must clear it yourself. Then run the **Unblocking**
     sweep.
   - **`NEEDS_REVISION`** → run the **stagnation check**. If it clears, increment
     `qa_iterations`, store the blocking findings in `last_review_findings`, move
     the task back to `inprogress`, set `running: true`, and redispatch
     `meridian:developer` with the findings only. When it returns, set
     `running: false` and repeat from step 2.

The commit happens **only** after both code review and QA approve. The
specialists never commit; the developer stages and stops.

## Iteration cap and stagnation

The cap is **5 revision rounds** per review stage, counted in `spec_iterations`,
`code_review_iterations` and `qa_iterations` independently.

The check runs **before** the increment, so read it against the rounds already
spent. Before **any** redispatch, check both conditions:

- the relevant iteration counter has **already reached 5** — five rounds are
  spent and this redispatch would start a sixth, **or**
- the blocking findings are substantively identical to the previous round —
  the same defect described again, not merely similar wording.

If either holds, do not redispatch. Instead update the task to:

- `status: "blocked"`
- `justification: "Blocked after N iterations — see last_review_findings. Needs human input."`
  where `N` is the counter's current value, which is the number of rounds
  actually spent — never a round that did not happen
- `running: false`
- `last_review_findings` holding the current round's blocking findings

So a stage runs at most five revision rounds, and a task blocked by the count
reads `Blocked after 5 iterations`.

Then move on to another task, or stop and report.

The second condition matters as much as the first: two agents can trade the same
finding back and forth for five rounds without converging. Identical findings
mean the loop is not making progress, and four more rounds will not change that.

## Specialist failure is not a revision round

A specialist that **fails outright** — errors, cannot run, returns nothing, or
returns something that is not a `VERDICT:` line — is not the same as one that
returned `NEEDS_REVISION`.

When that happens:

- Set the task to `blocked`.
- Record what failed in `justification` — which agent, at which step, and the
  error.
- Set `running: false`.
- **Do not increment any iteration counter.** The round was never spent.
- Stop. Do not retry the specialist, and do not fall back to doing its job
  yourself.

Burning an iteration on an infrastructure failure spends the operator's budget
for genuine disagreement on something the agents never disagreed about.

## Unblocking

Whenever a task reaches `done`, sweep the board:

1. Read every task with status `blocked`.
2. For each, check its `blockedBy` ids. If **all** of them are now `done`, move
   that task to `backlog` and clear the dependency justification.
3. A `blocked` task whose `blockedBy` is empty is not waiting on anything the
   board knows about — it was blocked by an iteration cap or a failure. Leave it
   blocked and surface it to the operator; only a human clears those.

Report what the sweep unblocked.

## Context discipline

Specialists return full reports. You do not keep them.

From each specialist, retain exactly two things:

- the **verdict** (`APPROVED` or `NEEDS_REVISION`), and
- the **blocking findings**, which go into `last_review_findings`.

Discard the rest of the report once you have acted on it — the reasoning, the
file walkthrough, the observed outputs. `last_review_findings` holds only the
**current** round's blocking findings, and is cleared on a pass. Do not
accumulate findings across rounds, do not forward one specialist's report to
another, and do not carry a report into the next task.
