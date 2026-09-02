# The Meridian Pipeline

How a task travels from `backlog` to `done`. This file is the procedure; the
skill that reads it is the thing that executes it. Read `schema.md` for field
names, status values and the API contract — this file assumes them.

You drive the pipeline yourself: you set every status, you dispatch the
specialist subagents, you read their verdicts, and you make every task write
through the API. The specialists never write task state.

A task's status names the agent it needs. You read the status, verify what the
previous stage was supposed to leave behind, dispatch that one agent, and act on
its verdict. There is nothing else to track.

**One task at a time.** Never drive more than one task concurrently. Finish or
block the current one before picking up another.

All specs, commits and agent communications are in **English**.

## Where to enter

A task's current status tells you where to resume. Nothing needs to restart from
the beginning.

| Status | Dispatch | Verify before dispatching | If the check fails |
|---|---|---|---|
| `backlog` | `meridian:spec-generator` | title is non-empty | ask the operator for one |
| `spec_review` | `meridian:spec-reviewer` | `spec_path` is set **and the file exists** | the spec was never written — go back to `backlog` |
| `ready_todo` | `meridian:developer` | spec file exists; `expected_results` non-empty; every `blockedBy` id is `done` | missing spec or results → back to `backlog`. Unmet dependency → move to `blocked` |
| `in_progress` | `meridian:developer` (re-dispatch) | same as `ready_todo` | same as `ready_todo`, plus the resumption briefing |
| `code_review` | `meridian:code-reviewer` | there is something to review (`git diff --stat` against the task's base is non-empty) | the developer never ran — go back to `ready_todo` |
| `qa_review` | `meridian:qa` | `expected_results` non-empty | QA receives only these; go back to `backlog` |
| `blocked` | Not runnable. See **Unblocking**. | the `blockedBy` ids are genuinely still open | all `done` → unblock it instead of reporting |
| `done`, `nope` | Nothing to do. | — | refuse |

**Never trust the status alone.** A status can be set by hand — through the
API, or by editing `tasks.json` — so a task can arrive at any stage without the
previous stage ever having run. Each row's check is what the stage before it was
supposed to leave behind. Verify, do not assume.

**A failed check reroutes; it does not refuse.** Send the task to the stage that
should have produced the missing artefact and continue from there. That is what
repairs a task someone moved too far ahead.

**A reroute consumes an iteration.** If the `backlog` stage has just run and
the spec is still not on disk, that is a failure, not a detour — otherwise two stages push
the task back and forth forever. The cap of five below covers reroutes too.

A task found with `running: true` and no live agent behind it was interrupted.
Say so, and resume it from its status row above.

The `in_progress` row carries one thing this file does not define: an interrupted
`in_progress` task may have left partial work in the working tree, so its
`meridian:developer` dispatch also needs the **resumption briefing** — see
"Resumption briefing" in the `work` skill, which owns dispatch payloads and
holds that rule. No other status gets one.

## A board read expires on use

The board's only store is `tasks.json`, behind the API. What a fetch put into
your context is **history, not state**: another session — another harness,
even — may have moved tasks the moment after you read them, and a copy in
context never hears about it. Context is the one cache this system cannot
delete, so treat it as already stale.

Never decide over an earlier fetch. Re-fetch, scoped to the project, before
every decision that depends on board state:

- entering a task at a stage (the entry checks read the task as it is *now*);
- choosing a task when no id was given;
- the unblocking sweep — it must see the dependencies' current statuses, not
  the ones from before the task you just finished;
- reporting final state to the operator.

A fetch consumed by one decision is spent. The scoped `GET` is small and the
server reads the disk fresh on every request — re-fetching costs little, and
acting on a stale copy costs a wrong write.

## Choosing which task

Normally you are given an explicit task id and this question does not arise —
work that task. The rule below is the fallback for when you are not.

Within a single stage — several tasks sitting in `backlog`, or several in
`ready_todo` — pick in this order:

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
`ready_todo` one — is not decided here. That is the `next` skill's job. If you
have no id and tasks are waiting in more than one stage, say which candidates
you found and ask, rather than guessing.

## Dispatching a specialist

Every dispatch prompt carries what the specialist needs, because a subagent
inherits nothing from you — no working directory context, no skill base
directory, no conversation.

In particular, an agent cannot resolve a path to this plugin's own files on its
own, and no base directory is injected into it, so it cannot recover from a bad
one. When you dispatch **any** agent — the five specialists and `meridian:pm`
alike — **pass the absolute path of `schema.md`** in the prompt, the same way
you pass a spec path. Without it, an agent that needs a field definition has
nowhere to look.

Resolve that path the way the invoking skill's **Resolve the shared references**
section says: try `${CLAUDE_PLUGIN_ROOT}/references/schema.md` first, then
`../../references/schema.md` relative to the "Base directory for this skill"
line, and use whichever exists. Do **not** build it from the base directory
alone — that directory is the skill's own folder, two levels below the plugin's
`references/`, so the result would be `skills/<skill>/references/schema.md`,
which does not exist.

Verify the resolved path exists before it goes into a prompt:

```bash
test -f "<resolved absolute path>" && echo ok || echo BAD
```

On `BAD`, do not dispatch — an agent handed a broken path cannot recover.

**Every dispatch prompt opens with a marker line:**

```
MERIDIAN_TASK: <task id>
```

Verbatim, first line, exactly that shape. The plugin ships a hook that watches
Task dispatches for this marker and maintains the `running` flag mechanically —
including clearing it when a session dies mid-dispatch, the one case the rules
above can never cover. You still set `running` through the API as those rules
say: the hook is a janitor, not the owner, and both writing the same value is
harmless. A dispatch without the marker is invisible to the janitor.

**Every dispatch also names a report path.** Build it as
`.meridian/reports/<task id>-<stage>-<round>.md`, create the directory if
needed, and tell the specialist to write its full report there and return only
its short contract. See **Specialist reports stay out of your context** below
for why, and for what each contract contains.

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

## The stages

The per-stage procedure lives in `stages.md`, resolved the same way as this
file. Read it when you are about to run a stage — not before. Everything in
*this* file applies to every stage and is needed whichever one you enter.

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

`blockedBy` gates **implementation, not specification.** A task whose
dependencies are still open may be specced and reach `ready_todo` — writing its
spec needs the *specs* of the tasks it depends on, not their finished code,
which is exactly why the `backlog` stage passes the `spec_path` of every
`blockedBy` task to the generator. Only dispatching the developer requires those
dependencies to be `done`. This lets several specs be ready while one thing is being built,
instead of serialising the whole pipeline.

The one thing specifying does need is that each `blockedBy` task already has a
`spec_path`. If one does not, this task waits — but it waits for a spec, which
is a far shorter wait than waiting for `done`.

Whenever a task reaches `done`, sweep the board:

1. Read every task with status `blocked`.
2. For each, check its `blockedBy` ids. If **all** of them are now `done`, move
   that task to `ready_todo` when it already has an approved spec (`spec_path`
   set and the file present), and to `backlog` when it does not. Clear the
   dependency justification either way. Never send a task with an approved spec
   back to `backlog` — that discards the spec work and specs it a second time.
3. A `blocked` task whose `blockedBy` is empty is not waiting on anything the
   board knows about — it was blocked by an iteration cap or a failure. Leave it
   blocked and surface it to the operator; only a human clears those.

Report what the sweep unblocked.

## Specialist reports stay out of your context

A specialist's full report — its reasoning, its file walkthrough, the outputs it
observed — is worth keeping and not worth reading. Once it is in your context it
is there for the rest of the run, and a task that goes through five stages with
revision rounds accumulates every one of them.

So the report goes to a file, and only a short contract comes back.

**Every dispatch prompt names a report path.** Build it as
`.meridian/reports/<task id>-<stage>-<round>.md` — for example
`.meridian/reports/MERID-7-code_review-2.md`. `.meridian/` is gitignored, so
these are runtime state, not repository content. Create the directory if it is
not there.

**What the specialist returns to you** is at most:

- its **verdict**, where it has one (`APPROVED` / `NEEDS_REVISION`);
- its **blocking findings**, verbatim — these go into `last_review_findings`;
- one line of evidence that it actually ran (a test count, a file count);
- the **report path** it wrote.

Nothing else. A specialist that returns its whole report anyway has ignored its
instructions — take the verdict and findings from it, and say so in your final
report to the operator rather than treating it as normal.

**What you retain** is narrower still: the verdict and the blocking findings.
`last_review_findings` holds only the **current** round's findings and is cleared
on a pass. Do not accumulate findings across rounds, do not forward one
specialist's report to another, and do not carry anything into the next task.

**When you need the detail**, read the report file — deliberately, for a specific
question, at the moment you have it. That is the whole point of writing it down
instead of holding it.

Trim `.meridian/reports/` to its 50 most recent files after each write, so it
cannot grow without bound.
