# MERID-6 — Pipeline NEEDS_SPLIT verdict and pm split procedure for sub-tasks

## Scope

Teaches the pipeline to split an oversized task using the `parent` field
MERID-5 already added. This is a **prose-only** task — no `server.js`,
`lib/`, `public/` or test-fixture code changes. The deliverables are edits to:

- `plugin/plugins/meridian/agents/spec-generator.md`
- `plugin/plugins/meridian/agents/spec-reviewer.md`
- `plugin/plugins/meridian/agents/developer.md`
- `plugin/plugins/meridian/agents/pm.md`
- `plugin/plugins/meridian/references/pipeline.md`
- `plugin/plugins/meridian/references/stages.md`

`plugin/plugins/meridian/agents/code-reviewer.md` and `.../agents/qa.md` are
**not** touched — `NEEDS_SPLIT` is available to exactly three specialists.
`plugin/plugins/meridian/references/schema.md` is not touched either: the
`parent` field and its one-level validation already exist (MERID-5); this
task adds no new field and no new server-side validation, so it needs no
schema change.

The stale, pre-plugin agent copies at the repo root — `agents/*.md`,
`.agents/agents/*.md`, `.claude/agents/*.md` — are out of scope. They already
describe a different, older status vocabulary (`specreview`, `readytodo`,
"Fluxo A/B") than the nine-status schema the plugin uses today, no test
enforces their parity with `plugin/plugins/meridian/agents/`, and MERID-5 set
the precedent of leaving them alone. Do not edit them.

## Approach

### 1. `NEEDS_SPLIT` in the three agent definitions

Add a `NEEDS_SPLIT` verdict to `spec-generator.md`, `spec-reviewer.md` and
`developer.md`. Each gets its own copy of the same guidance — these files are
never read by each other, only independently dispatched, so the criteria must
be self-contained in each rather than cross-referenced.

**Objective size criteria** (identical prose in all three, adapted to each
file's voice), stated explicitly as *guidance for judgement, not a mechanical
threshold*:

- `expected_results` (or, for the developer, the work actually surfacing)
  describing several independent deliverables that could each ship as their
  own PR;
- work spanning several unrelated subsystems or modules;
- a spec/task the specialist judges cannot be implemented and reviewed inside
  the 5-round iteration budget `pipeline.md` allows.

**Decomposition shape**: named parts, each with a one-line scope, ordered so
a part that depends on another is named after it (mirrors `blockedBy`
ordering, since `meridian:pm` will wire dependencies from this order later).

**Not available to a child.** Every one of the three files states, verbatim
in substance: *"Not available to a task with a `parent`. If the dispatch
prompt says this task has a `parent`, do not return `NEEDS_SPLIT` — a child
task is never split again."* — and gives the fallback: the spec-generator
writes the best spec it can and says why in the report if it can't; the
spec-reviewer reviews the spec as given and raises size as a `NEEDS_REVISION`
blocking finding instead; the developer finishes the smallest correct
increment and reports `BLOCKED` with what's missing.

#### `spec-generator.md`

- In "What Makes a Good Spec", change the existing bullet — `**One
  deliverable**: PR-sized unit. If asked to spec multiple independent
  deliverables, propose the split in the first line.` — to point at the new
  formal mechanism: `**One deliverable**: PR-sized unit. When it plainly is
  not, return `NEEDS_SPLIT` (see below) instead of writing a spec for several
  deliverables at once.` This retires the old ad hoc "propose the split in
  the first line" behavior in favor of the formal verdict — do not leave both
  mechanisms described.
- Add a new section, `## When the Task Needs Splitting Instead of a Spec`,
  placed after "You Author the Task's `expected_results`" and before
  "Pre-Requisites", containing: the judgement call (do not write a spec at
  all when the task is not one deliverable), the three criteria above, the
  "not available to a child" rule, and the decomposition shape.
- Update the final "Your Report Goes to a File" hand-off list to branch:
  ordinary run returns spec path + `EXPECTED_RESULTS:` block + report path,
  unchanged; on `NEEDS_SPLIT` it returns `VERDICT: NEEDS_SPLIT`, the proposed
  decomposition verbatim, and the report path — no spec path, no
  `EXPECTED_RESULTS:` block, because neither was produced.

#### `spec-reviewer.md`

- In "What to Check" item 4 ("Scope"), change it to say that a spec covering
  multiple independent modules is a `NEEDS_SPLIT` candidate, not a
  `NEEDS_REVISION` blocking finding.
- Add a new section, `## When to Return NEEDS_SPLIT Instead of NEEDS_REVISION`,
  placed after "What to Check" and before "The `expected_results` Gate",
  containing: why `NEEDS_REVISION` is the wrong verdict for an
  oversized-but-internally-consistent spec (asking the generator to "tighten
  scope" on something that is really two specs just produces another
  oversized spec), the three criteria (referencing that they are the same
  ones the generator uses), the decomposition shape, and the "not available
  to a child" rule with its fallback (review on the given scope; if still too
  large, that's a `NEEDS_REVISION` blocking finding, not `NEEDS_SPLIT`).
- Update "Output Format": `VERDICT: APPROVED | NEEDS_REVISION | NEEDS_SPLIT`;
  add a `## Proposed Decomposition` section (named parts + one-line scope,
  present only when the verdict is `NEEDS_SPLIT`) between `## Blocking
  Findings` and `## Suggestions`; note blocking findings is always "None."
  on a `NEEDS_SPLIT` verdict — the reasoning belongs in the decomposition
  section, not there.
- Update the final "Your Report Goes to a File" contract list to include
  `VERDICT: NEEDS_SPLIT` alongside the other two, and to say the proposed
  decomposition is returned verbatim when that's the verdict (same treatment
  as blocking findings on `NEEDS_REVISION`).

#### `developer.md`

- Add a new section, `## When Scope Splitting Reveals Itself
  Mid-Implementation`, placed after "Strict TDD Workflow" and before "Code
  Quality", containing: the trigger (implementation surfaces work that is
  really several deliverables, or spans unrelated subsystems, or is too large
  to finish and get through review), the three criteria (referencing they are
  the same ones used earlier in the pipeline), the decomposition shape, the
  "not available to a child" rule and its fallback (finish the smallest
  correct increment, report `BLOCKED`), and an explicit instruction not to
  commit and not to leave a half-implemented split — stage only what is done
  and passing.
- Update the final "Your Report Goes to a File" contract list: `DONE`,
  `BLOCKED` or `NEEDS_SPLIT` (bare token, matching the existing `DONE`/
  `BLOCKED` style — this file's contract was never `VERDICT:`-prefixed and
  gains no such prefix now); on `NEEDS_SPLIT`, the proposed decomposition
  verbatim, in place of expected-results-not-met and test evidence (neither
  applies — nothing was finished to test).

### 2. Orchestrator handling — `pipeline.md`

Add a new top-level section, `## A NEEDS_SPLIT verdict`, placed after
"## Specialist failure is not a revision round" and before "## Unblocking" —
it is a peer of both: like the iteration cap, it is a rule about how a
verdict is allowed to redirect a task; like specialist failure, it has a
"this should never have happened" branch.

Content, in order:

1. **Who can return it and why.** `meridian:spec-generator`,
   `meridian:spec-reviewer` and `meridian:developer` may return `NEEDS_SPLIT`
   when they judge the task is not one PR-sized deliverable — restate the
   three criteria briefly (source of truth is each agent's own file, since
   agents never read `pipeline.md`) — and that it carries a proposed
   decomposition (named parts, one-line scope each) to be treated like a
   blocking finding: verbatim, current round only.

2. **One level, split at most once — the guard.** Before honoring a
   `NEEDS_SPLIT` verdict, check the task itself against the board just
   fetched:
   - if it already has a `parent`, it is a child;
   - if some other task on the board already names it as `parent`, it has
     already been split once.

   Either condition means the specialist should never have returned this
   verdict for this task. Treat it exactly as **specialist failure** (the
   section immediately above): `blocked`, `justification` naming which agent
   returned `NEEDS_SPLIT` and why it wasn't eligible, `running: false`, no
   iteration increment, no retry, and — the one thing that differs from an
   ordinary specialist failure — **do not dispatch `meridian:pm`** either.

3. **The happy path**, when the guard clears:
   - Set `running: false`. **Do not increment** `spec_iterations`,
     `code_review_iterations` or `qa_iterations` — a split replaces the round
     rather than spending one.
   - Dispatch `meridian:pm` with: the task id, its title, its
     `expected_results`, its `spec_path` if it has one, and the specialist's
     proposed decomposition verbatim. Pass the resolved `schema.md` path,
     exactly as any other dispatch in "Dispatching a specialist" above
     requires.
   - `meridian:pm` creates the children and reconfigures this task through
     the API itself — see its split procedure in `agents/pm.md`. This file
     only says what happens around that dispatch, not what `pm` does inside
     it.
   - When `meridian:pm` returns, re-fetch the task before reporting on it —
     the same "a board read expires on use" rule as anywhere else in this
     file applies to a write another agent just made.
   - Stop driving this task; move to another one or report and stop.

4. **Return to the flow.** State explicitly: the task returns to the
   pipeline through the **existing** unblocking sweep, unmodified — once
   every id in its `blockedBy` (the children) reaches `done`, the sweep moves
   it to `backlog` (its `spec_path` was cleared as part of the split, so the
   "has an approved spec" branch never applies to it) for a fresh,
   reduced-scope spec describing only the integration/verification work that
   remains. No new sweep logic is added or needed.

Also add one sentence to the existing `## Unblocking` section cross-referencing
this: after the numbered sweep steps, note that this is also the mechanism
that returns a split task's parent to the flow once its children finish, and
that no separate mechanism exists for that case.

### 3. Stage dispatch updates — `stages.md`

No renumbering: entry points ("Enter at step 1 from `backlog`...", "Enter at
step 1 from `ready_todo` or `in_progress`...") reference steps 1/2 and 1/2/3
by number, so new branches are added as sub-bullets inside the existing
numbered steps, not as new top-level numbered steps.

- **Step 1 ("Generate the spec")**: extend the dispatch line to also tell
  `meridian:spec-generator` whether the task carries a `parent` (so it knows
  `NEEDS_SPLIT` isn't open to it). Add a sub-bullet: on `VERDICT:
  NEEDS_SPLIT`, no spec was written — follow "A NEEDS_SPLIT verdict" in
  `pipeline.md` instead of recording a `spec_path`.
- **Step 2 ("Review the spec")**: extend the dispatch line the same way
  (tell the reviewer whether the task has a `parent`). Add a sub-bullet: on
  `VERDICT: NEEDS_SPLIT`, follow "A NEEDS_SPLIT verdict" in `pipeline.md`.
- **Building section, step 1 ("Implement")**: extend the dispatch line the
  same way (tell the developer whether the task has a `parent`). Add a
  sub-bullet: on `NEEDS_SPLIT`, do not continue to step 2 (code review) —
  follow "A NEEDS_SPLIT verdict" in `pipeline.md` instead.

Steps 3, 4, 5 of the spec section and steps 2, 3 of the build section are
otherwise unchanged — `NEEDS_SPLIT` is not available to `meridian:code-reviewer`
or `meridian:qa`, so nothing in those two steps changes.

### 4. `pm` split procedure — `agents/pm.md`

First, fix the framing sentence this job would otherwise contradict.
`pm.md` opens with "You have exactly two jobs: **decomposition** and
**curation**. Nothing else." Adding a third job without touching that
sentence leaves the file asserting "two jobs" one line above a "Job 3"
heading. Rewrite it unambiguously to admit the third job — e.g. "You have
exactly three jobs: **decomposition**, **curation**, and **splitting** an
oversized task the pipeline flagged. Nothing else." — updating the two
bullets immediately below it (which currently restate "never dispatch
subagents" / "never write production code" against the two-job framing) only
as needed so they still read correctly against three jobs.

Then add a new job, `## Job 3 — Splitting a Task the Pipeline Flagged
NEEDS_SPLIT`, after "Job 2 — Curation". `pm` still never dispatches agents and
never writes production code — this job only creates and updates *tasks*,
exactly like Jobs 1 and 2.

**Input:** the original task's id, title, `expected_results`, `spec_path` (if
any), and the specialist's proposed decomposition (named parts + one-line
scope each). The `work` skill dispatches `pm` here — `pm` does not decide on
its own that a task needs splitting.

**Output:** the children created on the board; the original task reconfigured
into the final integration/verification step.

Procedure:

1. **Create the children**, in the decomposition's stated order (a part is
   created before anything that depends on it — same id-ordering reason as
   Job 1's dependency order), each via `POST /api/projects/tasks` carrying:
   `title`, `justification`, `expected_results` (all as well-formed as Job 1
   requires — never an empty `expected_results`), `parent: <original task
   id>`, and `blockedBy` wired between children only where the proposal
   states an order (never invented). Keep a map of proposed part → returned
   id as Job 1 does.

   Note for `pm`'s own understanding (not new server behavior — this is the
   MERID-5 validation already in place): the first child's create is what
   gives the original task its first "has children" state; every later
   child names the same original id as `parent`, which by then already has
   no `parent` of its own (true by construction, since it is the root being
   split) and is not yet anyone's child.

2. **Reconfigure the original**, once every child exists, in **one**
   `PUT /api/projects/tasks/<original id>`:
   - `blockedBy`: every child's id;
   - `status`: `"blocked"`;
   - `justification`: `"Split into <id 1>, <id 2>, ..."` — every child's id,
     not just one;
   - `spec_path`: `""` — clears the field using the existing generic
     string-field update path (no new server semantics; `spec_path` is
     already a plain string field per `schema.md`, and clearing it is what
     makes the unblocking sweep's "already has an approved spec" check false,
     routing the reintegrated task through `backlog` for a fresh spec instead
     of straight to `ready_todo` with a spec that still describes the
     pre-split scope). Do this even when the original never had a
     `spec_path` in the first place (the `NEEDS_SPLIT` came from the
     generator itself) — sending `""` over an already-absent field is a
     harmless no-op.

   Leave `title` and `expected_results` alone — the task keeps its identity,
   the split only narrows what it still has to do. Do not write `spec_path`
   to anything but `""` here; the new, reduced-scope spec is authored later,
   through the normal `backlog`/`spec_review` flow, once the unblocking sweep
   returns this task there.

3. **Report**: the created children as a table (same shape as Job 1), plus a
   line stating the original task's id, its new `blockedBy` list, and its
   `status: blocked`.

Note in Job 2 ("Curation")'s third defect check ("`blocked` tasks with an
empty `blockedBy`") that a split parent is never flagged by it: its
`blockedBy` is non-empty and its `justification` explains the block, exactly
like an ordinary dependency block.

## Testing

No test files are added or changed by this task — nothing mechanically
checkable was introduced (no new field, no new validation, no new script, no
new JSON manifest). `npm test` (`node --test test/*.test.js`) must still pass
unmodified, in particular `test/plugin.test.js` (the `plugin.json` /
`hooks.json` cross-harness guards), since no code, JSON, or hook file is
touched by this task — confirm by running the suite after the prose edits and
by `git diff --stat` showing exactly seven markdown files: the six listed
under Scope plus `docs/tasks/MERID-6-spec.md` itself.

## Expected Results

- [ ] `plugin/plugins/meridian/references/pipeline.md` contains a
      `## A NEEDS_SPLIT verdict` section stating: (a) only
      `meridian:spec-generator`, `meridian:spec-reviewer` and
      `meridian:developer` may return it; (b) it consumes no iteration
      counter (`spec_iterations`/`code_review_iterations`/`qa_iterations` are
      not incremented); (c) the orchestrator sets `running: false` and
      dispatches `meridian:pm` with the proposed decomposition; (d) a task
      with a `parent`, or a task that already has children on the board, must
      never emit or receive `NEEDS_SPLIT` — this is treated as specialist
      failure (`blocked`, no retry, no `meridian:pm` dispatch).
- [ ] `plugin/plugins/meridian/references/pipeline.md`'s `## Unblocking`
      section (or the new `NEEDS_SPLIT` section) states in prose that the
      existing sweep — unmodified — is what returns a split task's parent to
      `backlog`/`ready_todo` once every id in its `blockedBy` is `done`, and
      that no new sweep logic exists for this case.
- [ ] `plugin/plugins/meridian/references/stages.md` documents the
      `NEEDS_SPLIT` branch at all three eligible dispatch points (spec
      generation step 1, spec review step 2, implementation step 1 of the
      build section), each instructing the dispatch to state whether the
      task carries a `parent`, without renumbering any existing step.
- [ ] `plugin/plugins/meridian/agents/spec-generator.md`,
      `plugin/plugins/meridian/agents/spec-reviewer.md` and
      `plugin/plugins/meridian/agents/developer.md` each define the
      `NEEDS_SPLIT` verdict, state the same three objective (non-mechanical)
      size criteria, define the named-parts-with-one-line-scope decomposition
      format, and state the verdict is unavailable to a task with a `parent`
      together with that specialist's fallback behavior.
- [ ] `plugin/plugins/meridian/agents/code-reviewer.md` and
      `plugin/plugins/meridian/agents/qa.md` are unchanged — `grep -L
      NEEDS_SPLIT` over both files matches both, confirming the verdict was
      not added to either.
- [ ] `plugin/plugins/meridian/agents/pm.md` contains a `## Job 3` (or
      equivalently named) section documenting the split procedure: create
      each child via `POST /api/projects/tasks` with `parent: <original
      id>` and well-formed `title`/`justification`/`expected_results`,
      `blockedBy` wired between children per the proposal's stated order;
      then reconfigure the original in one `PUT` setting `blockedBy` to the
      full list of children ids, `status: "blocked"`, `justification:
      "Split into <ids>"` (listing every child), and `spec_path: ""`.
- [ ] `plugin/plugins/meridian/agents/pm.md` still states, unchanged, that
      `pm` never dispatches subagents and never writes production code.
- [ ] `plugin/plugins/meridian/agents/pm.md`'s opening framing sentence no
      longer says "exactly two jobs" — it names all three (decomposition,
      curation, splitting) so the file does not contradict its own `## Job 3`
      heading.
- [ ] `git diff --stat` against this task's base shows changes in exactly
      seven files: the six listed under Scope (four agent files —
      `spec-generator.md`, `spec-reviewer.md`, `developer.md`, `pm.md` — and
      two reference files — `pipeline.md`, `stages.md`) plus
      `docs/tasks/MERID-6-spec.md` itself — no `server.js`, `lib/`,
      `public/`, `test/`, or `schema.md` change.
- [ ] `npm test` (`node --test test/*.test.js`) passes, including
      `test/plugin.test.js`.

## Out of Scope

- Any change to `server.js`, `lib/tasks.js`, `lib/board.js`, `public/app.js`,
  or `schema.md` — the `parent` field and its one-level validation already
  exist (MERID-5); this task adds no field and no server-side rule.
- `plugin/plugins/meridian/agents/code-reviewer.md` and `.../agents/qa.md` —
  `NEEDS_SPLIT` is not available to either.
- The stale, pre-plugin agent copies at `agents/*.md`, `.agents/agents/*.md`
  and `.claude/agents/*.md` — unmaintained, already inconsistent with the
  current nine-status schema, and untested for parity.
- What happens to a developer's already-staged, uncommitted changes when a
  mid-implementation `NEEDS_SPLIT` is returned. The developer is instructed
  not to commit; reconciling or discarding partial staged work when a task
  splits is left for a future task if it proves to matter in practice.
- Resetting `spec_iterations`/`code_review_iterations`/`qa_iterations` on the
  reconfigured parent — the existing pipeline never resets these on an
  ordinary reroute to `backlog` either, so a split does not invent new
  behavior here.
