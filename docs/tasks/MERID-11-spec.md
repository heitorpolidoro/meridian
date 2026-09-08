# MERID-11 — Stats: stop measuring time in backlog, done and nope

`lib/stats.js` defines a constant list of "untimed" statuses —
`backlog`, `done`, `nope` — exported alongside the module's existing
functions. In `aggregateTaskStats`, when shaping a task's per-stage
intervals into its `stages` map, an interval whose stage is untimed
still registers that the task visited the stage but contributes no
`totalMs` and is never marked `ongoing` (skip the duration/ongoing
accumulation for it entirely, regardless of whether it's the task's
last, still-open interval); a timed stage's math is byte-for-byte
unchanged. Untimed stages contribute no entries to `stageTimeEntries`
(so `shapeStages` never computes `avgMs`/`maxMs`/`topByTime` for them —
those three keys must be **absent** from an untimed stage's aggregate
object, not zero or empty-array), but a duration-independent
task-visited signal must still be threaded through for them, because
`shapeStages` currently derives both `allStageNames` (which stages
appear in the output at all) and `taskCount` from the entry maps —
and `done`/`nope` routinely carry zero `dispatch_tokens` entries too.
Without that signal, a stage with no timed entries *and* no token/agent
entries would vanish from `stages` entirely instead of appearing with
`taskCount` present and only the duration fields absent. So: `backlog`,
`done` and `nope` must appear in `stages` (via `allStageNames` or
equivalent) and carry a correct `taskCount` — the number of distinct
tasks that ever visited the stage, its existing, API-stable meaning
per MERID-9 — purely from having been visited, with zero dependency on
whether any duration or token entry exists for that stage.
`avgTokens`/`maxTokens`/`topByTokens`/`agents` are
untouched for every stage: dispatch/token attribution is computed from
the same interval list regardless of a stage's timed/untimed status,
so a spec-generator dispatch while a task sits in `backlog` still
attributes its tokens and agent to the `backlog` row exactly as today.
This applies identically to `aggregateStats` (single project) and
`aggregateWorkspaceStats` (workspace-wide), since both already share
`aggregateTaskStats`/`shapeStages`.

In `public/app.js`, `renderStatsPanel` must not call `formatDuration`
on an absent duration. In the per-stage table (`stats-stage-tbody`),
when a stage's `avgMs`/`maxMs` are absent, render the neutral `—`
placeholder (matching the existing agent-cell placeholder style,
`.stats-agent-placeholder` or equivalent) in the Avg time and Max time
cells instead. In the per-task table's row-building loop, when a
task's stage entry has no `totalMs` (i.e. the task visited an untimed
stage), render `—` in the "Time in stage" cell and never render the
"ongoing" badge for that row (already implied since `ongoing` is never
set, but the row template must not crash on the missing `ms` either).
Detect "untimed" from the data (an absent duration value) rather than
re-hardcoding the three status names in `app.js` — the frontend has no
access to the backend's constant and duplicating the list risks drift.
Existing column-sort behavior on the "Time in stage" header must keep
working without throwing when some rows have no `ms`: treat an absent
duration as the lowest value for sort-ordering purposes. This is one
render path shared by both the per-project and workspace ("All
Tickets") Stats tabs, so no separate workspace-view change is needed.

Files touched: `lib/stats.js` (untimed-stage constant + aggregation/shaping changes described above), `public/app.js` (`renderStatsPanel` stage-table and task-row rendering), `test/stats.test.js` and `test/api-stats.test.js` (update assertions that currently expect `totalMs`/`ongoing`/duration-derived `avgMs`/`maxMs`/`topByTime` for `backlog`, `done` or `nope` — e.g. `stats.test.js` lines asserting `tasks['X'].stages.backlog` deep-equals an object with `totalMs`, and the `stages.backlog.taskCount`/`avgMs`/`maxMs`/`topByTime` assertions built from all-`backlog`-duration fixtures at lines ~85–105 and ~420–430; `api-stats.test.js`'s `stats.stages.backlog.totalMs >= 0` assertion — plus new tests: a per-task stage entry for each of the three untimed statuses carries no `totalMs` and is never `ongoing`; a per-stage aggregate for each carries no `avgMs`/`maxMs`/`topByTime` but does carry a correct `taskCount` and correct token/agent attribution from a dispatch that occurred while the task sat in that stage; a work stage (e.g. `in_progress`) is unaffected, keeping its existing open-interval/ongoing behavior).

## Expected Results
- [ ] A task's per-task stage entry for `backlog`, `done` or `nope` has no `totalMs` field and `ongoing` is never `true` for it, while a work stage (e.g. `in_progress`) keeps producing `totalMs`/`ongoing` exactly as before
- [ ] `GET /api/stats` (and the workspace-wide equivalent) always includes `stages.backlog`, `stages.done` and `stages.nope` entries — even when a `done`/`nope` stage has zero `dispatch_tokens` events attributed to it — with no `avgMs`, `maxMs` or `topByTime` keys, while `taskCount`, `avgTokens`, `maxTokens`, `topByTokens` and `agents` are still present and correct, including correct token/agent attribution for a dispatch made while a task was in one of those stages
- [ ] In the rendered Stats stage table (both per-project and workspace/"All Tickets" views), the Avg time and Max time cells for `backlog`, `done` and `nope` rows show `—`; the per-task table's "Time in stage" cell shows `—` with no "ongoing" badge for those stages' rows
- [ ] The backlog row's Agent cell and the corresponding per-task dispatch/token totals for a spec-generator dispatch made while a task is in `backlog` are unchanged from current behavior
- [ ] `npm test` (i.e. `node --test test/*.test.js`) passes
