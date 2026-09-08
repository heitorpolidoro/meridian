# MERID-10 — Spec diet: behavior-only specs, findings-only re-review, and a short path for small tasks

## Scope

Three prose edits to the spec-review corner of the plugin, elaborating the
operator-approved design in the task description exactly — no redesign:

1. `plugin/plugins/meridian/agents/spec-generator.md` — spec content
   contract (behavior/files/test-criteria, no ready-made code) plus size
   discipline, plus the short-path allowance for small tasks.
2. `plugin/plugins/meridian/agents/spec-reviewer.md` — round-2+ re-review
   becomes findings-only.
3. `plugin/plugins/meridian/references/stages.md` — the redispatch that
   sends a round-2+ spec back to the reviewer now carries the previous
   round's findings and names the review as findings-only; the short-form
   spec is acknowledged as valid.

Out of scope: `agents/code-reviewer.md`, `agents/qa.md`,
`references/pipeline.md`, `references/schema.md`, `references/preamble.md`,
`agents/developer.md`, `agents/pm.md` — none of these are touched. No new
automated tests are added; this is a documentation-only change and the
existing guard suite (`npm test`) must stay green because it is unaffected
by markdown prose, not because new tests were written for it.

This is one deliverable, not three: all three edits live in the same
pipeline stage (spec generation and review), are two small sections and one
redispatch clause, and were scoped together by the operator as a single
task title.

## Approach

### 1. `agents/spec-generator.md` — content contract, size discipline, short path

Add a new section, placed after "What Makes a Good Spec" and before
"## Format", stating the spec's content contract: a spec describes only
BEHAVIOR (what must be true once the task is done), FILES TOUCHED (the
changed paths, one line each naming what changes in that file), and TEST
CRITERIA (what proves the behavior). It never contains ready-made code,
diffs, or full function bodies — writing those is the developer's job; the
`expected_results` are the contract, the spec is the map.

Add one bullet to the existing "What Makes a Good Spec" list stating the
size discipline as a quality criterion: a spec whose prose exceeds roughly
one page per subsystem touched is a smell that belongs in `NEEDS_SPLIT`
territory — cross-reference the existing "When the Task Needs Splitting
Instead of a Spec" section rather than restating its three criteria.

Add a second new section, parallel in placement and tone to "When the Task
Needs Splitting Instead of a Spec," naming the short-path allowance: when a
task arrives with (a) concrete, mechanically verifiable `expected_results`
and (b) a diagnosed root cause or equivalently complete justification
already on the task, the generator may write a one-paragraph spec —
behavior, files touched and test criteria condensed into a few sentences —
in place of the full `## Scope`/`## Approach`/`## Expected Results`
template, still saved to the same `spec_path`. State that this does not
relax the duty to author and return `expected_results` in the report.

Update the "## Format" section's description of `## Approach` so it points
at the new content contract (behavior/files/test-criteria) instead of
inviting "modules, schemas, functions, endpoints" phrasing that reads as
permission to write code.

### 2. `agents/spec-reviewer.md` — findings-only re-review

Add a new section, placed after "What to Check" and before "When to Return
NEEDS_SPLIT Instead of NEEDS_REVISION," describing two review modes keyed
off what the dispatch prompt contains:

- **Round 1** (no previous round's blocking findings in the dispatch): run
  the full review described in "What to Check," unchanged.
- **Round 2+** (the dispatch includes the previous round's blocking
  findings, per `stages.md`'s redispatch): the review is findings-only.
  Verify only that (a) each previously listed blocking finding is now
  resolved in the spec, and (b) a brief consistency pass limited to the
  sections the generator changed to fix them turns up no new contradiction.
  Do not re-apply the full "What to Check" list against untouched sections,
  and do not raise a blocking finding outside the previous round's list
  unless the fix itself introduced one.

State that the verdict and report format are unchanged either way
(`APPROVED`/`NEEDS_REVISION`, same Blocking Findings/Suggestions shape) —
only how much of the spec gets re-examined changes.

### 3. `references/stages.md` — wiring the redispatch, acknowledging the short form

In the `backlog`/`spec_review` stage's step 4 ("On `NEEDS_REVISION`"), after
the existing instruction to redispatch `meridian:spec-generator` with the
findings only and then "review the spec again," add the corresponding
reviewer redispatch instruction: dispatch `meridian:spec-reviewer` with the
same payload step 2 already sends (spec path, `expected_results`, `parent`
flag) plus the previous round's blocking findings verbatim, and state
explicitly that this dispatch is a findings-only re-review — mirroring the
findings-only discipline step 4 already applies to the generator's own
redispatch.

In step 1 or step 2 (whichever reads more naturally with the surrounding
prose), add one sentence acknowledging the short path: a one-paragraph spec
returned under `spec-generator.md`'s short-path criterion is a complete
spec, not a shortcut to flag — record its `spec_path` and
`expected_results` exactly as any other, and step 2's reviewer judges it by
completeness relative to the task, not by length.

## Expected Results

- [ ] `agents/spec-generator.md` contains a section stating a spec describes
      only behavior, files touched, and test criteria, and never contains
      ready-made code, diffs, or full function bodies.
- [ ] `agents/spec-generator.md`'s "What Makes a Good Spec" list contains a
      size-discipline bullet naming both a page-per-subsystem-ish threshold
      and `NEEDS_SPLIT` as where an oversized spec belongs.
- [ ] `agents/spec-generator.md` contains a short-path section stating the
      two-part objective criterion (concrete, mechanically verifiable
      `expected_results` AND a diagnosed root cause or equivalently complete
      justification) and that, when both hold, the generator may return a
      one-paragraph spec.
- [ ] `agents/spec-reviewer.md` contains a section distinguishing a full
      round-1 review from a findings-only round-2+ re-review, stating that
      round 2+ verifies only that the previous round's blocking findings are
      resolved plus a brief consistency pass of the changed sections.
- [ ] `references/stages.md`'s spec `NEEDS_REVISION` handling (step 4)
      instructs redispatching `meridian:spec-reviewer` with the previous
      round's blocking findings and names that dispatch a findings-only
      re-review.
- [ ] `references/stages.md` contains a sentence acknowledging that a
      one-paragraph spec produced under the short-path criterion is valid
      and judged by completeness relative to the task, not by length.
- [ ] `git diff --stat -- plugin/plugins/meridian/agents/code-reviewer.md plugin/plugins/meridian/agents/qa.md` reports no changes to either file.
- [ ] `npm test` (`node --test test/*.test.js`) passes, including
      `test/plugin.test.js`.

## Out of Scope

- Any change to `agents/code-reviewer.md`, `agents/qa.md`,
  `references/pipeline.md`, `references/schema.md`,
  `references/preamble.md`, `agents/developer.md`, or `agents/pm.md`.
- Any change to the dispatch marker line format, the report-path
  convention, or the iteration-cap/stagnation-check logic in `pipeline.md`.
- Any new automated test — this task changes agent/reference prose only;
  verification is via `npm test` staying green (unaffected) and the
  grep-able assertions above.
- Redesigning the three mechanisms beyond what the operator already
  approved in the task description.
