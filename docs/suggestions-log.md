
## [MERID-1] Revamp Project View UX (SPA transition & Kanban layout) — 2026-09-02

- **A2 placement of `#view-loading`.** The spec says the `<main>` area shows the placeholder, but `<main>` *is* `#dashboard-view`, which starts `hidden`; placed inside it the placeholder would never show. State explicitly that `#view-loading` is a sibling of the two views inside `.container` (or make `<main>` a neutral wrapper around both views).
- **B1 selector vs. prose.** The prose scopes the compact header and `overflow: hidden` to `data-view` = `project` or `global`, but the given selector is `body:not([data-view="dashboard"])`, which also matches the pre-route state when `body` has no `data-view` yet (compact header and hidden buttons during "Loading workspace…"). Either set an initial `data-view` on `<body>` in `index.html` or use `body[data-view="project"], body[data-view="global"]` so the two descriptions agree.
- **A1 drops the `relativePath || path.split('/').pop()` fallback** present in today's `handleUrlRouting` (line 673). `server.js` line 379 always sets `relativePath`, so this is safe, but the spec could say so in one sentence so the developer does not reintroduce the fallback "for safety" and diverge from the tested `resolveRoute`.
- **A7 `openDetails` keying in the global view.** `uid` is `j-<task.id>`; ids are per-project keys so collisions across projects are unlikely, but the capture could key on `#<uid>` plus `data-project` if the card exposes it. Non-blocking; worth a comment in `captureBoardState`.
- **B2 rail keyboard handling.** The spec says Enter/Space; B4 tests only Enter. Fine as is, but if Space is intended, add it to B4 so QA checks both.
- **Split note.** Keep it — it is useful for the developer — but if the work is cut into two PRs, the task's expected results should be re-tagged per PR at that time so QA does not check B-results against the A PR.

## [MERID-1] Revamp Project View UX (SPA transition & Kanban layout) — 2026-09-02

- **A2 placement of `#view-loading` (carried over from round 1, still open).** The spec says "the `<main>` area shows a single `#view-loading` element", but in `index.html` line 35 `<main>` *is* `#dashboard-view`, which starts `hidden`; a placeholder inside it would never render. The observable result (A2) forces the developer to put it elsewhere, so this is not ambiguous in outcome, but one sentence — "`#view-loading` is a sibling of the two views inside `.container`" — would prevent a wasted iteration.
- **B1 selector vs. prose (carried over).** Prose scopes the compact header and `overflow: hidden` to `data-view` = `project`/`global`; the given selector `body:not([data-view="dashboard"])` also matches the pre-route state when `body` has no `data-view` yet, so the "Loading workspace…" screen would show the compact header with `#open-add-modal-btn` hidden. This is consistent with A6 as written, so it is not blocking; if the full header is wanted during loading, set an initial `data-view` in `index.html` or use `body[data-view="project"], body[data-view="global"]`.
- **A7 `expandedRails` in the captured state.** B2 defines `expandedRails` as a module-level Set, so capturing it in `captureBoardState` is redundant (it survives the rebuild on its own). Either drop it from the capture shape or say the capture snapshots it for symmetry — either is fine, but the developer should not be left wondering whether the rendering reads the Set or the snapshot.
- **A1 drops the `relativePath || path.split('/').pop()` fallback (carried over).** `server.js` always sets `relativePath`, so this is safe; a one-line note would stop a "for safety" reintroduction that diverges from the tested `resolveRoute`.
- **B2 rail keyboard handling (carried over).** Spec says Enter/Space; B4 tests only Enter. If Space is intended, add it to B4.
- **B1 `.kanban-header` → `.kanban-toolbar` rename** is mentioned in passing inside the flex list; since B5 and the files table also rely on the new class name, a dedicated bullet ("rename `.kanban-header` to `.kanban-toolbar` in `index.html` and `styles.css`") would make it harder to miss.

## [MERID-1] Revamp Project View UX (SPA transition & Kanban layout) — 2026-09-02

- `public/styles.css` (board-view rules, roughly lines 640–710) and `public/index.html:11`:
  the compact-header / flex-container / hide-dashboard-actions rules are all keyed on
  `body:not([data-view="dashboard"])`. `<body>` carries no `data-view` until the first SSE
  message resolves a route, so a cold load of `/` briefly renders the compact header,
  hides the subtitle and `#open-add-modal-btn`, and sizes `.container` to `100vh`, then
  snaps to the full dashboard header. Not a view flash (A2 is satisfied), but it is a
  header flash on the most common entry URL. Either scope those rules to
  `body[data-view="project"], body[data-view="global"]`, or give `<body>` an initial
  `data-view` and key the rules on the two board values. QA may notice this under B2.
- `public/app.js:1001`: `captureBoardState` copies `expandedRails` into the state object,
  but `restoreBoardState` never reads it — `collapsedColumns` consumes the module-level
  Set directly. The field is dead; drop it (and the matching line in the doc comment).
- `public/styles.css:372` (`#error-container:empty { display: none; }`): not in the spec.
  Harmless in the flex column, but it is unrelated to this task and could be mentioned in
  the commit message or dropped.
- `public/app.js:159-204`: the `renderProjects` re-indent is correct but doubles the
  visual size of the diff. If a second round is needed anyway, a reviewer-friendlier
  shape is to keep the early-return structure and hoist the `fixAllBtn` / `refreshProjectView`
  tail into a tiny helper called from both paths. Purely cosmetic; fine to leave.
- Commit message: note the `--border-color` → `--card-border` correction on the toolbar
  control, since it changes the rendered border colour of the done-window control.

## [MERID-1] Revamp Project View UX (SPA transition & Kanban layout) — 2026-09-02
- `/project_b` at 1440×900 renders four full columns at their 260 px minimum plus five rails and overflows the board by 12 px (scrollWidth 1388 vs clientWidth 1376), which yields a barely-there horizontal scrollbar. Letting columns shrink a little below 260 px before overflowing, or trimming the 1 rem gap when rails are present, would avoid the sliver scroll on common laptop widths.
- `index.html` loads the Google Fonts stylesheet before the end-of-body `<script>`, so when `fonts.googleapis.com` is slow or unreachable the script (and therefore the first route/`#view-loading` removal) waits for that request to fail. Loading the font non-render-blocking (`media="print" onload="this.media='all'"`, or a `<link rel="preload">` with `font-display: swap`) would keep the SPA boot independent of third-party latency.
- The breadcrumb's `textContent` is `Meridian›Project D` (spacing comes from CSS `gap`), so text copied or read by assistive tech runs the words together; adding whitespace around the separator span, or an `aria-label` on the nav items, would read more naturally.

## [MERID-3] Capture task statistics: events log and per-dispatch token usage — 2026-09-05

- Consider noting in the spec (or accepting as implementation detail) that
  `python3` is a new runtime dependency for this shell script, distinct from
  the "no jq" design constraint already documented in the script's header —
  worth a one-line comment in the implementation calling out why Python was
  chosen over pure shell for this one multi-line JSON aggregation, so a future
  reader doesn't mistake it for a lapse in the "no external tools" convention.
- The spec does not pin down the exact `{"error": "..."}` message text for each
  of the 7 validation steps in §3; harmless since expected_results only checks
  status codes, but worth deciding once during implementation so error
  messages read consistently with the existing task routes' style.

## [MERID-3] Capture task statistics: events log and per-dispatch token usage (code review) — 2026-09-05

- `lib/events.js`'s catch block binds `err` but never uses it (`} catch (err) { return false; }`). Harmless (no lint configured), but could be `catch { return false; }` for a marginally cleaner read if a future lint pass is added.
- `test/api-events.test.js`'s "rejects a type other than dispatch_tokens" test iterates 3 variants (`undefined`, `'status'`, `'something_else'`) which is fine, but the file's own comment style elsewhere sometimes documents *why* a given negative case matters — not necessary here, just noting for consistency across the test suite as it grows.

## [MERID-3] Capture task statistics: events log and per-dispatch token usage (QA) — 2026-09-05
- `isRegisteredProject` in server.js re-reads and re-parses `projects.json` from disk on every `/api/projects/events` call; fine at current scale, but if this endpoint becomes hot (e.g. one call per subagent dispatch across many concurrent sessions) it may be worth caching or reusing whatever in-memory registry `getStatusData` already uses.
- The `capture_tokens` "since empty" fallback (degrades to "newest file, unconditionally" when no ledger mtime is available) is explicitly flagged in the script's own comment as a known best-effort compromise; no test exercises this fallback path specifically (only the "ledger present with old mtime" happy path and the "no subagents dir/file" negative paths are covered). Not blocking since it's documented as an accepted degradation, but a follow-up test for that branch would close the coverage gap.

## [MERID-5] Sub-tasks: parent field, board badge and progress chip — 2026-09-06

- schema.md's "Update" section currently enumerates the exact fields a PUT
  accepts ("Update accepts `status`, `title`, `justification`, `priority`,
  `spec_path`, ... `last_review_findings` and `running`.") and the "Create"
  section similarly says "Create accepts only these fields, plus an optional
  `status`." The spec's plan for schema.md only adds a field-table row and a
  validation-rule paragraph — it does not touch either enumeration sentence,
  so once `parent` is implemented, those two sentences will read as
  understating what the endpoints actually accept. This isn't required by the
  literal `expected_results` wording (which only asks for the field table and
  the validation rule in prose), so it isn't a blocking gap, but it's worth
  fixing in the same PR to keep schema.md internally consistent with itself,
  since schema.md declares itself the single source of truth other prose must
  agree with.
- Consider explicitly noting in the spec (or leaving to the implementer's
  judgment, as now) whether a PUT that sets `parent` to the value it already
  has should short-circuit without re-validating — current logic re-validates
  and would pass harmlessly, so this is cosmetic, not a bug.

## [MERID-5] Sub-tasks: parent field, board badge and progress chip (QA) — 2026-09-06

- The two-of-three flaky `npm test` runs (random port collision in `withServer`, unrelated to this change) suggest widening the port range or adding a retry/uniqueness guard in `test/api-tasks.test.js`'s port selection, to reduce sporadic CI noise. Not blocking for this task since it is pre-existing and unrelated to the `parent` feature.

## [MERID-6] Pipeline NEEDS_SPLIT verdict and pm split procedure — 2026-09-06

- `spec-reviewer.md`'s Approach subsection (lines 98-103 of the spec) says to
  "Update 'Output Format'," but the actual section in
  `agents/spec-reviewer.md` is titled `## Report Format` — there is no section
  literally named "Output Format." The intended target is unambiguous (it's
  the only section with the `VERDICT:` / `## Blocking Findings` /
  `## Suggestions` shape the spec describes), so this doesn't rise to a
  blocking ambiguity, but the spec should use the file's actual heading name.
- `pm.md`'s Job 3 procedure directs creating each child via `POST
  /api/projects/tasks` carrying `parent: <original task id>` directly at
  create time. I confirmed in `server.js` (around line 560-586) that the
  create endpoint does in fact accept and validate `parent` on `POST`, so this
  is correct against real server behavior. However, `schema.md`'s own Create
  section text ("Create accepts only these fields, plus an optional status")
  enumerates `projectPath, title, priority, justification, expected_results,
  blockedBy` and does not mention `parent` as accepted on create — a
  pre-existing gap in `schema.md` (not introduced by this task, and out of
  this task's declared scope). Since `schema.md` states elsewhere "if any
  other prose disagrees with it, this file wins," a future reader taking that
  literally could conclude `pm.md`'s Job 3 is wrong when it is not. Worth a
  follow-up task to add `parent` to schema.md's list of create-accepted
  fields; not blocking for MERID-6 since it doesn't touch schema.md by design
  and the procedure as written matches actual server behavior.
- The instruction to add a cross-reference sentence to the existing `##
  Unblocking` section ("after the numbered sweep steps") doesn't say whether
  it goes before or after the existing "Report what the sweep unblocked."
  trailing sentence. Low-stakes phrasing/placement ambiguity, not something
  `meridian:qa` could ever check either way.
- `pm.md`'s YAML frontmatter `description` ("Plans and curates a Meridian
  backlog...") and its "Never dispatches agents and never writes production
  code" framing are otherwise still accurate after adding Job 3, but doesn't
  mention splitting; consider having the same edit that fixes the "exactly two
  jobs" sentence also touch the frontmatter description for consistency.


## [MERID-6] Pipeline NEEDS_SPLIT verdict and pm split procedure (code review) — 2026-09-06
- `docs/suggestions-log.md` already has an unstaged entry from a prior round
  (MERID-6, 2026-09-06) noting that the spec's Approach text says "Update
  'Output Format'" when the actual section in `spec-reviewer.md` is titled
  `## Report Format`. The implementation used the file's real heading name
  (correct behavior), so this is purely a spec-wording nit, not a defect in
  the staged changes — no action needed here, just confirming it doesn't
  point at anything wrong in the diff under review.
- `pm.md`'s YAML frontmatter `description` ("Plans and curates a Meridian
  backlog... Never dispatches agents and never writes production code.")
  still doesn't mention the new splitting job. Not required by the spec and
  not blocking, but a one-line addition there would keep the summary in sync
  with the file's own three-job framing.


## [MERID-4] Stats panel fed by GET /api/stats — 2026-09-07
- The `stages['unknown']` bucket (dispatch_tokens events with no matching status interval) never contributes to `stageTimeEntries`, so its `avgMs`/`maxMs`/`topByTime` will always be `0`/`0`/`[]` even though `avgTokens`/`maxTokens`/`topByTokens` are populated. This is intentional and internally consistent, and none of the `expected_results` require otherwise, but a one-line comment in the eventual `lib/stats.js` (not just the spec prose) would save a future reader from mistaking it for a bug.
- `renderStatsPanel`'s per-(task, stage) row flattening duplicates `dispatches`/`outputTokens`/`maxContextTokens` onto every stage row for a multi-stage task (those numbers are task-level totals, not stage-level). Harmless for the table view described, but if a later task tries to sum the `outputTokens` column for a per-stage total, it will double count. Worth a short note in the board copy ("Dispatches" column is per-task, not per-stage) so this doesn't get miscopied later — not blocking since the spec doesn't claim the column is stage-scoped.


## [MERID-4] Stats panel fed by GET /api/stats (code review) — 2026-09-07

- `public/app.js`'s `renderStatsPanel` interpolates `r.task`, `name` (stage name), and other server-supplied strings directly into `innerHTML` template literals without escaping (e.g. `public/app.js` in the `renderStatsPanel` function, both the stage table and task table row builders). Today this is safe: task ids come from the server's own key-generation scheme and stage names are constrained to the fixed `VALID_STATUSES` whitelist enforced in `server.js` (`VALID_STATUSES` check at the task PUT/POST validation), so no attacker-controlled string can reach this template. It's also consistent with the codebase's pre-existing convention — `renderKanbanBoard`/`task.title`/`running-ticket-title` etc. in the same file already interpolate task titles into `innerHTML` unescaped with no `escapeHtml` helper anywhere in the file. Not a regression introduced by this diff and not blocking, but if an `escapeHtml` helper is ever added for the board view, the stats view should adopt it too for defense-in-depth (e.g. if `events.jsonl` is ever hand-edited or a future event producer stops going through the validated API).

- Minor duplication: the "sum output_tokens / max context_tokens across a list of dispatches" loop in `lib/stats.js` is written three times (once for the per-task-with-status-events branch, once for the per-task-without-status-events branch, and implicitly again as `stageTokenAcc` bookkeeping in the first branch). A small local helper (`function summarizeDispatches(dispatches)`) would remove the duplication between the two `for (const [taskId, dispatches] of dispatchByTask)`-adjacent blocks. Purely cosmetic — the current code is correct, readable, and thoroughly tested, and the task's own spec explicitly hands over this exact implementation, so this is not something to block on.


## [MERID-7] Workspace stats: card shortcut and All Tickets aggregation (code review) — 2026-09-07

- `public/app.js` `renderStatsPanel` interpolates `r.project` (sourced from
  `project.name`/`project.path`, ultimately from a project's own
  `project-info.json` or its directory path) directly into an `innerHTML`
  template string with no escaping, so a project name containing HTML/JS
  (e.g. `<img src=x onerror=...>`) would execute in the stats table. This is
  not a regression introduced by this diff specifically — the exact same
  unescaped-interpolation pattern already exists for `proj.name` in
  `renderProjects` (`public/app.js:202`) and elsewhere in this file (e.g.
  line 1325), so this diff is consistent with the codebase's existing
  (pre-existing, not previously fixed) security posture rather than
  introducing a new class of risk. Worth a follow-up task to introduce a
  shared `escapeHtml` helper and apply it wherever project/task-derived
  strings are interpolated into markup, including this new Project column,
  but not something to block this task on given the precedent.


## [MERID-7] Workspace stats: card shortcut and All Tickets aggregation (QA) — 2026-09-07

- `public/app.js`'s `renderStatsPanel` interpolates the workspace aggregate's `project` label (from `project.name`/`project.path`) directly into an `innerHTML` template string with no HTML-escaping, so a project name containing `<script>`/event-handler markup would execute in the stats table. This is not a regression introduced by this task — the same unescaped-interpolation pattern already exists for `proj.name` in `renderProjects` (`public/app.js:202`) and elsewhere in the file — and the developer's own `docs/suggestions-log.md` entry for this task already flags it as a pre-existing, non-blocking issue worth a follow-up `escapeHtml` helper task. I agree it is not blocking for MERID-7 given the precedent, but it is worth tracking as a separate hardening task.
