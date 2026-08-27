# Meridian Skills Plugin — Design

**Date:** 2026-08-27
**Status:** Approved for planning

## Goal

Give Meridian a set of project-scoped entry points — invoked from a Claude Code
session inside a tracked project — that drive the existing task pipeline without
the operator hand-editing `tasks.json`. Ship them as a Claude Code **plugin** so
the agents and skills live in one source instead of being copied into every
project.

A second, smaller goal rides along: stop the `done` column from drowning the
board, without deleting anything.

## Current State (measured 2026-08-27)

| Fact | Value |
|---|---|
| Registered projects | 6 (`project_a`, `project_b`, `project_c`, `project_d`, `meridian`, `project_e`) |
| Tasks across all projects | 92 |
| Tasks in `done` | 56 (61%) |
| `done` tasks carrying `updated_at` | 43 of 56 |
| Tasks with no `expected_results` | 28 of 92 (30%) |
| `blocked` tasks with a satisfied dependency | 0 |
| Tasks carrying a `priority` field | 0 of 92 |
| `meridian-*` agent files copied across projects | 36 (6 files × 6 projects) |

Two shape inconsistencies exist today: `project_e/.meridian/tasks.json` is
a bare JSON array while the other five are `{ "lastUpdated": ..., "tasks": [...] }`,
and two timestamp formats coexist (`...Z` and `...-03:00`).

## Architecture Decisions

### D1 — The skills are the front; Odin stays workspace-level

`agents/Odin.md` defines a Chief-of-Staff persona that operates **across**
projects (briefings, cross-project coordination). Every skill in this design is
scoped to a single project, so Odin does not front them. Putting a
cross-project persona in front of a project-scoped skill would erase the only
clean line separating the two altitudes.

### D2 — `pm.md` is dissolved into the skills

The `pm` agent's charter was "dispatch subagents", but
`.claude/agents/meridian-pm.md` grants `Read, Write, Edit, Bash, Grep, Glob` —
no subagent-dispatch tool. As an agent it cannot perform its only stated job.
Its value is the protocol text, not the persona.

The protocol is redistributed:

| `pm.md` content | New home |
|---|---|
| Fluxo A / Fluxo B, iteration cap, stagnation check | `work` → `references/pipeline.md` |
| Commit on QA pass | `work` → `references/pipeline.md` |
| Unblocking rule | `work` (on completion) and `status` (consistency line) |
| Task schema, status vocabulary | shared `references/schema.md` |
| Bootstrap / plan decomposition | the redefined `PM` agent (D3) |

The orchestration content of `agents/pm.md` is retired along with
`.claude/agents/meridian-pm.md`. A `pm` agent still ships in the plugin, but
carrying the charter defined in D3, not this one.

### D3 — `PM` is redefined as backlog planner and curator

The PM stops orchestrating and takes the one job nothing else covers:

- **Decomposition** — turn `docs/plans/implementation-plan.md` (or a feature
  description) into PR-sized tasks with `blockedBy` wired and `expected_results`
  written.
- **Curation** — sweep the board for tasks missing `expected_results`,
  mis-wired dependencies, and `blocked` entries with no `blockedBy`.

It never dispatches and never writes production code, which fits its existing
tool grant exactly. This addresses a measured gap: 28 of 92 tasks have no
`expected_results`, and the `qa` agent receives *only* `expected_results` — so
roughly a third of the backlog cannot be QA'd today.

Invoked directly as `meridian:pm`, and by `work` when `tasks.json` is empty.

### D4 — One write path

All task writes go through the server's REST API. The stamping rules
(`moved_at`, `completed_at`, `updated_at`) live in exactly one helper, shared by
`POST` and `PUT`, so the skills, the PM, and a card dragged on the dashboard all
produce identical results. Skills **ensure the server is running** before acting
(`cli.js start`) rather than falling back to hand-editing files — a fallback
would duplicate the stamping rules in agent prompts and drift, which is how
`lastUpdated` ended up present in only 2 of 5 files.

### D5 — CWD only, with onboarding

Skills look for `./.meridian/` in the current working directory. They do **not**
walk up the tree. This matters because a plugin installs per user and is
therefore visible in every directory, including the 20+ workspace projects that
do not use Meridian.

When `./.meridian/` is absent, the skill asks whether to register the project.
On yes it calls `POST /api/projects`, which already registers the path, creates
`.meridian/`, writes `project-info.json`, and derives the task `key`. Because the
skill is already inside the repository, it fills `name`, `stack`, and
`description` at creation time instead of creating an empty entry that
immediately shows three "missing" badges. It also offers — does not force — to
generate `AGENTS.md` when absent, reusing `prompts/agents.txt`.

## Schema Changes

`tasks.json` becomes a **bare JSON array**. `lastUpdated` is dropped: nothing
branches on it (`server.js:282` only passes it through; `public/app.js` never
reads it). The instruction to maintain it by hand is removed from `Odin.md`
(lines 30 and 52). Versioning is explicitly out of scope.

New per-task fields:

| Field | Written when | Cleared when |
|---|---|---|
| `moved_at` | any status change, including into `done` | never |
| `completed_at` | status enters `done` | status leaves `done` |
| `priority` | on create; `critical \| high \| medium \| low`, default `medium` | never |

`updated_at` is kept and stamped on every write. Existing tasks without
`priority` are read as `medium`.

### Migration: no script

`getTasks` (`server.js:433`) already accepts a bare array, so the tolerance for
both shapes exists. `saveTasks` (`server.js:449`) starts writing an array and
stops stamping `lastUpdated`; each file converts on its first write.

Backfill rides the same path: `getTasks` fills `completed_at` from `updated_at`
in memory for `done` tasks that lack it, and the next write persists it. This
covers 43 of 56; the remaining 13 stay `null`. A `null` `completed_at` counts as
old and is hidden by the board filter — the desired outcome for tasks whose
completion date is unknown.

`getTasks` and `saveTasks` are the single read/write funnel, so no file can
escape the conversion. This is why no migration script is needed.

## Server Changes

### `GET /api/status`

Gains `?project=<path>` and `?limit=<n>`. With no parameters the current
behavior is unchanged (all projects, unlimited) so the dashboard keeps working.
With `project`, the response covers that project only. With `limit`, it returns
the first N per status, ordered the way the board orders: `done` by most
recently completed, every other status by `priority` then age.

### `POST /api/projects/tasks`

Today accepts `projectPath`, `title`, `blockedBy`. Extended to accept
`expected_results`, `priority`, and `justification`, and to stamp `created_at`
and `moved_at`. Task id generation stays server-side via the existing
`nextTaskId(tasks, key)`.

### `PUT /api/projects/tasks/:taskId`

Today accepts `status`, `justification`, `title`, `blockedBy`, `running`.
Extended to the full schema: `spec_path`, `spec_iterations`,
`code_review_iterations`, `qa_iterations`, `last_review_findings`,
`expected_results`, `priority`.

Stamping rules, applied by the shared helper:

- any write → `updated_at = now`
- status changed → `moved_at = now`
- status entered `done` → `completed_at = now`
- status left `done` → `completed_at = null`

## Plugin Structure

```
meridian/plugin/
  .claude-plugin/marketplace.json
  plugins/meridian/
    .claude-plugin/plugin.json
    agents/
      pm.md  developer.md  qa.md
      code-reviewer.md  spec-generator.md  spec-reviewer.md
    references/
      schema.md          # task schema + the 9-status vocabulary
      pipeline.md        # Fluxo A/B, iteration cap, stagnation, commit, unblock
    skills/
      status/SKILL.md
      work/SKILL.md
      new/SKILL.md
      next/SKILL.md
```

Shared references sit at the plugin root rather than inside one skill, because
`schema.md` is needed by `status`, `work`, and `new`. Skills reach them through
`${CLAUDE_PLUGIN_ROOT}`, the same variable the plugin manifest already uses to
resolve its own paths.

Installed once via `claude plugin marketplace add` + `claude plugin install`, it
is available in every directory. Agents become `meridian:developer`,
`meridian:qa`, and so on. The 36 copied `meridian-*` agent files in the six
projects are deleted after the plugin is verified working.

Every skill shares a preamble: validate `./.meridian/` (D5), ensure the server
is up (D4), then act.

## Skills

### `meridian:status`

Calls `GET /api/status?project=<cwd>&limit=5`, formats the JSON, and reports:

1. The top 5 tasks per status.
2. A consistency line: `blocked` tasks whose `blockedBy` entries are all `done`.
   (Zero such tasks exist today; the PM's unblocking rule is holding. The line
   is a cheap invariant check, not a workflow.)
3. **Interrupted tasks** — any task with status `inprogress` **or**
   `running: true`. The skill runs in a fresh session, so no agent from a prior
   session is alive; the presence of either flag *is* the interruption signal.
   Both are checked independently because `running: true` legitimately occurs in
   `backlog`, `specreview`, `codereview`, and `qareview` during a live run.

When an interrupted task is found the skill asks the operator whether to resume.
On yes it enters the `work` flow, and the dispatched `developer` receives an
explicit resumption briefing: which stage it stopped at, the open round's
`last_review_findings`, and an instruction to establish actual state
(`git status`, `git diff`) **before** writing anything, because the working tree
may hold partial work.

`AEQUI-29` ("Question lock/version lifecycle", `inprogress`, `running: true`)
is the live case this will pick up on first run.

### `meridian:work <TASKID>`

Enters the pipeline at the stage the task's status indicates:

| Status | Action |
|---|---|
| `backlog` | Fluxo A step 1 — dispatch `spec-generator` |
| `specreview` | Fluxo A step 2 — dispatch `spec-reviewer` |
| `readytodo` | Fluxo B step 1 — dispatch `developer` |
| `inprogress` | dispatch `developer` **with the resumption briefing** |
| `codereview` | dispatch `code-reviewer` |
| `qareview` | dispatch `qa` |
| `blocked` | do not start; report why |
| `done`, `nope` | refuse; reopening is an explicit action and clears `completed_at` |

Resumption context matters only for `inprogress`. A review is never half-done —
it either ran or it did not — so `codereview` and `qareview` simply run their
agent.

Runs until `done`, or until `blocked` by the 5-iteration cap or the stagnation
check. Every transition goes through `PUT`.

A task moves through consecutive stages in one invocation: a `backlog` task runs
Fluxo A and continues into Fluxo B without a second call. If a dispatched
specialist fails outright — as opposed to returning `NEEDS_REVISION` — the task
is set to `blocked` with the failure recorded in `justification`, and the run
stops. A failure is not a revision round and must not consume an iteration.

**Context discipline:** `work` retains only each specialist's verdict and
blocking findings, discarding the full report once acted upon. A full pipeline
run dispatches four or five subagents in sequence, and the main session would
otherwise accumulate every report.

### `meridian:new "<title>"`

Reads `key` from `project-info.json`, creates the task in `backlog` via `POST`.
Requires `expected_results` and prompts for them when absent — the `qa` agent
receives only `expected_results`, so a task without them produces a weak spec
and a blind QA. Accepts an optional `priority`, defaulting to `medium`. Task id
generation is the server's job.

### `meridian:next`

Selects the next task right-to-left along the pipeline — closest to finished
first:

```
qareview → codereview → inprogress → readytodo → specreview → backlog
```

`blocked`, `done`, and `nope` are skipped. Ordering is three-level: **stage
first, then priority, then oldest `created_at`**. Priority breaks ties *within* a
stage and never crosses stages, so a `critical` in `backlog` does not jump ahead
of a `high` in `qareview` — that would defeat the point of finishing work
already in flight. The selected task is handed to `work`.

## Board: hiding old `done` tasks

Tasks are hidden, never deleted. The filter is a view concern; the server keeps
returning everything, including in the aggregated global view.

- Default window: **7 days**, with a `24h · 7d · 30d · all` selector persisted in
  `localStorage` under `meridian_done_window`, mirroring the existing
  `hideEmptyColumns` pattern (checkbox → `localStorage` → `refreshProjectView()`).
- `completed_at == null` counts as old and is hidden.
- The column never disappears. The header shows the visible count, and a
  `+N concluídas` chip expands the rest for the current session without changing
  the stored preference.
- `sortColumnTasks(tasks, isDoneColumn)` currently sorts `done` by descending task
  id number (`app.js:777`) as a recency proxy. With `completed_at` present it
  sorts by actual completion date.

Effect on today's data: `project_a` drops from 31 visible `done` cards to only
those completed in the last week.

## Implementation Order

The work splits into two phases with a hard dependency between them — the skills
cannot be exercised until the endpoints they call exist.

1. **Server and schema** — bare-array `saveTasks`, backfill in `getTasks`, the
   shared stamping helper, `POST`/`PUT` extensions, `GET /api/status` parameters,
   `Odin.md` cleanup. Verifiable on its own against the six live projects.
2. **Plugin, skills, and board filter** — plugin scaffold, the four skills, the
   redefined PM, the `done` window in `app.js`. Ends with deleting the 36 copied
   agent files once the plugin is confirmed working.

## Out of Scope

- `tasks.json` schema versioning.
- claude-code-kanban integration. The board is installed and running on port
  8080 for evaluation; nothing in this design depends on it. The interrupted-task
  detection deliberately uses the fresh-session argument instead of live session
  data, so no dependency is created.
- A `meridian:plan` skill fronting the PM. The PM is reachable directly and via
  `work`'s empty-backlog path; a dedicated skill can be added later.
- Retiring or rewriting Odin beyond removing the `lastUpdated` instruction.
- Normalizing the two timestamp formats already in the data.

## Assumptions

- The Meridian server's default port stays `3333` (`server.js:6`).
- Skills starting the server use the existing detached `cli.js start`.
- `priority` values reuse the four levels already documented in Meridian's
  `AGENTS.md` (`critical`, `high`, `medium`, `low`).
