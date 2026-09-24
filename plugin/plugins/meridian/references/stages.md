# The Meridian Stages

The procedure for each stage: which agent it dispatches, what that agent gets,
and what happens to the task on each verdict.

The rules that apply to *every* stage — where to enter and what to verify first,
the `running` flag, how to build a dispatch, the iteration cap, what to do when a
specialist fails, the unblocking sweep, and where specialist reports go — are in
`pipeline.md`. Read that first; this file assumes it.

There is no separate "spec phase" and "build phase" to keep track of. A task
sits at a status, that status names one agent, and you dispatch it. What follows
is that list, in the order a task normally passes through it — but the order is
descriptive, not a script: you enter wherever the task already is.

### `backlog` and `spec_review` — specifying

Enter at step 1 from `backlog`, at step 2 from `spec_review`.

1. **Generate the spec.** Set `running: true`. Fetch the task's `expected_results`
   from `GET /api/projects/tasks/:taskId` — `GET /api/status` no longer carries
   them — and dispatch `meridian:spec-generator` with the task title, those
   `expected_results`, the `spec_path` of every task in `blockedBy`, a pointer
   to `AGENTS.md`, and whether this task carries a `parent` (so it knows
   `NEEDS_SPLIT` isn't open to it). It writes
   `docs/tasks/<id>-spec.md` (and `docs/tasks/<id>-mock.html` if the task touches UI) and returns an `EXPECTED_RESULTS:` block. All specs and expected results must be authored in English (communication with the user can be in the detected language). When it
   returns, set `running: false` and record `spec_path`, `expected_results`, and `mock_path` (if produced), in one `PUT`.
   - On `VERDICT: NEEDS_SPLIT`, no spec was written — follow "A NEEDS_SPLIT
     verdict" in `pipeline.md` instead of recording a `spec_path`.

   A one-paragraph spec returned under `spec-generator.md`'s short-path
   criterion is a complete spec, not a shortcut to flag — record its
   `spec_path` and `expected_results` exactly as any other, and step 2's
   reviewer judges it by completeness relative to the task, not by length.

   A task created by `meridian:new` usually arrives with `expected_results`
   empty — that skill captures ideas and does not demand acceptance criteria.
   Authoring them is the generator's job; persisting them is yours. Agents never
   write task state.

2. **Review the spec.** Move the task to `spec_review`. Set `running: true`.
   Fetch the task's `expected_results` from `GET /api/projects/tasks/:taskId`
   and dispatch `meridian:spec-reviewer` with **only** the spec path, those
   `expected_results`, and whether this task carries a `parent` — nothing
   about how the spec was produced. When it returns, set `running: false`.
   - On `VERDICT: NEEDS_SPLIT`, follow "A NEEDS_SPLIT verdict" in
     `pipeline.md`.

3. **On `APPROVED`:** move the task to `spec_approval` and clear
   `last_review_findings` to `[]` in the same update. If either the generator or reviewer
   formulated questions for the operator, ensure they are recorded in the `questions` array.
   A question about how something LOOKS should arrive with the options rendered
   in the task's mock — both agents are instructed to do that, and a question
   that names only tokens or spec clauses is one the operator cannot answer.
   The task now awaits human approval:
   - The operator opens the card in the centered modal on the Kanban board, reads the spec,
     answers any open questions, and clicks **Aprovar Spec** (moving it to `ready_todo`) or
     **Pedir Ajuste à IA** (moving it back to `spec_review`).
   - The automated pipeline stops here and does not auto-advance to implementation.
   (No unblocking sweep here — dependents wait for `done`, not for an approved
   spec.)

4. **On `NEEDS_REVISION`:** run the **stagnation check** below. If it clears,
   increment `spec_iterations`, store the reviewer's blocking findings in
   `last_review_findings`, set `running: true`, and redispatch
   `meridian:spec-generator` with **the findings only** — not the whole review,
   not the previous conversation. When it returns, set `running: false` and
   review the spec again: set `running: true` and redispatch
   `meridian:spec-reviewer` with the same payload step 2 sends (spec path,
   `expected_results`, `parent` flag) plus the previous round's blocking
   findings verbatim. This dispatch is a **findings-only re-review** —
   mirroring the findings-only discipline this step already applies to the
   generator's own redispatch. When it returns, set `running: false`.

5. **Suggestions.** Append the reviewer's non-blocking suggestions to
   `docs/suggestions-log.md` under a heading `## [<id>] <title> — <date>`.

   **Never trim, truncate or rewrite this file — append only.** It is the one
   durable, versioned record of every suggestion the pipeline ever produced;
   the report files also hold them, but those are gitignored and pruned. The
   operator mines this log periodically, turning entries into tasks or
   discarding them — a suggestion silently dropped here is gone for good.

   Extract the suggestions **mechanically from the report file**, without
   reading the report into your context:

   ```bash
   printf '\n## [%s] %s — %s\n' "<id>" "<title>" "$(date +%F)" >> docs/suggestions-log.md
   awk '/^## Suggestions/{f=1;next} /^## /{f=0} f' "<report path>" >> docs/suggestions-log.md
   ```

   Skip the append only when the report's Suggestions section says `None.`

### `ready_todo`, `in_progress`, `code_review` and `qa_review` — building

Enter at step 1 from `ready_todo` or `in_progress`, at step 2 from `code_review`,
at step 3 from `qa_review`.

1. **Implement.** Move the task to `in_progress`. Set `running: true`. Fetch the
   task's `expected_results` from `GET /api/projects/tasks/:taskId` — again,
   `GET /api/status` doesn't have them — and dispatch `meridian:developer` with
   the `spec_path`, those `expected_results`, and whether this task carries a
   `parent`. It works TDD and stages its
   changes with `git add` without committing. When it returns, set
   `running: false`.
   - On `NEEDS_SPLIT`, do not continue to step 2 (code review) — follow "A
     NEEDS_SPLIT verdict" in `pipeline.md` instead.

2. **Code review.** Move the task to `code_review`. Set `running: true`. Dispatch
   `meridian:code-reviewer` with the `spec_path`; it scopes its own review with
   `git diff --stat`. When it returns, set `running: false`.
   Whatever the verdict, append the reviewer's suggestions to
   `docs/suggestions-log.md` exactly as the spec stage's step 5 does — same
   heading, same mechanical extraction, never trimming. Code-review suggestions
   are produced every round and would otherwise survive only in a gitignored,
   pruned report file.
   - **`APPROVED`** → continue to step 3.
   - **`NEEDS_REVISION`** → run the **stagnation check**. If it clears, increment
     `code_review_iterations`, store the blocking findings in
     `last_review_findings`, move the task back to `in_progress`, set
     `running: true`, and redispatch `meridian:developer` with the findings only.
     When it returns, set `running: false` and repeat step 2.

3. **QA.** Move the task to `qa_review`. Set `running: true`. Fetch the task's
   `expected_results` from `GET /api/projects/tasks/:taskId` and dispatch
   `meridian:qa` with **only** those `expected_results` plus pointers to the
   running system. Never pass it the developer's reasoning, the developer's
   report, or the code reviewer's verdict — its independence is the point. When
   it returns, set `running: false`.
   Whatever the verdict, append QA's suggestions to `docs/suggestions-log.md`
   the same way — QA is the third and last reviewer whose suggestions must not
   be lost.
   - **`APPROVED`** → commit the staged work. The developer already staged its
     implementation with `git add`, so the index is the change; add only the
     pipeline's own artifacts on top of it, by explicit path, and **guard each
     path with an existence test**:

     ```bash
     if [ -n "<spec_path>" ] && [ -f "<spec_path>" ]; then git add -- "<spec_path>"; fi
     if [ -f docs/suggestions-log.md ]; then git add -- docs/suggestions-log.md; fi
     git commit -m "<type>(<id>): <summary>"
     ```

     The message is a **Conventional Commit with the task id as the scope** —
     for example `feat(PROJ-34): add the asset registry`. Pick the
     type from what the change *is*, not from the pipeline stage that produced
     it: `feat` for new capability, `fix` for a corrected defect, `refactor`,
     `test`, `docs`, `chore` for the rest — lowercase, exactly one. The summary
     is imperative and short enough to keep the whole first line under ~72
     characters; derive it from the task title rather than pasting a long title
     verbatim. The id in the scope is what ties the commit to the board —
     `git log --grep '<id>'` must find it.

     Both artifacts are optional and routinely absent: `docs/suggestions-log.md`
     does not exist until the `spec_review` stage first writes it, and a task
     created straight into a later status has no `spec_path` at all. The guards
     matter because `git add` fails **closed** on a missing pathspec — one
     absent file aborts the whole command and stages *nothing*, not even the
     paths that do exist. Unguarded, that would block the commit on exactly the
     early-project cases the scoping is meant to make safe. Never collapse these
     back into a single multi-path `git add`.

     Never `git add -A` or `git add .` here either — those sweep every unrelated
     change in the working tree into the task's commit. Check `git status`
     first; if something unexpected is already staged, stop and ask rather than
     committing it.

     Then update the task to `status: "done"` with `running: false` in the same
     request — the server stamps `completed_at` on the transition but does not
     touch `running`, so you must clear it yourself. Then run the **Unblocking**
     sweep.
   - **`NEEDS_REVISION`** → run the **stagnation check**. If it clears, increment
     `qa_iterations`, store the blocking findings in `last_review_findings`, move
     the task back to `in_progress`, set `running: true`, and redispatch
     `meridian:developer` with the findings only. When it returns, set
     `running: false` and repeat from step 2.

The commit happens **only** after both code review and QA approve. The
specialists never commit; the developer stages and stops.

