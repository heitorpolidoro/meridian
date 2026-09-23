# Project Context & Purpose

Meridian is a **board and dispatch server** for a workspace holding several
independent projects at once. It answers two questions its operator would
otherwise lose track of: what state is each project in, and what should be
worked on next.

It has two audiences:

1. **A human**, who gets a live web dashboard — one card per tracked project,
   with its stack, description, task board, and health warnings — plus a
   settings screen for the agent CLIs it drives.
2. **AI agents**, which read and write the same files through the server's
   REST API. The plugin in `plugin/` ships the skills, agents and hooks that
   let an agent drive a task from backlog to done.

Meridian implements none of the projects' own work. It is meta-tooling: a
registry, a board, and the machinery for handing a task to an agent.

# High-level Architecture

A single-process Node.js application. No database — the filesystem is the
data layer, and state is derived from it rather than stored a second time.

- **Backend (`server.js`, `lib/`)** — An Express 5 app that:
  - Aggregates the board by reading a global registry plus each tracked
    project's own metadata and tasks. `server.js` wires HTTP to the pure
    modules in `lib/`, where the decisions live.
  - Serves a REST API for the registry, the tasks, the dispatch queue and the
    CLI tooling state.
  - Pushes live updates over **Server-Sent Events** (`/api/stream`), driven by
    `fs.watch` on the registry and on every tracked project's `.meridian/`.
  - **Dispatches tasks to an agent**: spawns `claude -p` inside the target
    project, one run per repository at a time, reading the verdict from the
    CLI's structured result rather than its exit code. Each run leaves a log
    under the project's `.meridian/runs/`.
  - Reports and repairs the state of the agent CLIs themselves — whether each
    is installed, authenticated, and running the plugin this repository ships.
  - Migrates older on-disk formats forward on startup.

- **Frontend (`public/`)** — Static, dependency-free HTML/CSS/vanilla JS. No
  build step, no framework, no bundler, and **no module system**: shared logic
  that must exist on both sides is written once in `lib/` and copied inline
  into `app.js`, with a comment on both copies saying so.

- **Plugin (`plugin/plugins/meridian/`)** — What the agent actually runs:
  skills (`/meridian:work`, `:next`, `:status`, `:new`), specialist agent
  definitions, reference docs, and the hooks that keep a task's `running` flag
  honest. Installed into Claude Code from this directory as a local
  marketplace, and into Antigravity by copy. See **Repository Conventions**
  below — a change here is inert until its version is raised.

- **CLI (`cli.js`)** — `meridian start` / `restart` / `stop` run the server as
  a detached background process (logs to `meridian-out.log` and
  `meridian-err.log`); `meridian add <path>` registers a project directory
  without the UI.

- **Data layer** — Entirely file-based:
  - `<RUNNING_DIR>/.meridian/projects.json` — the global registry, one `path`
    per tracked project.
  - `<project>/.meridian/project-info.json` — `name`, `key`, `description`,
    `stack`.
  - `<project>/.meridian/tasks.jsonl` — the backlog, one compact JSON object
    per line.
  - `<project>/.meridian/tasks/<id>.json` — one task's `expected_results`,
    kept off the line so the board payload stays small.
  - `<project>/.meridian/runs/` — per-run dispatch logs, and the lock naming
    the run in flight.
  - `<project>/.meridian/events.jsonl` — the append-only history the stats
    view is computed from.
  - `<project>/AGENTS.md` — the project's own agent knowledge base; its
    presence is a tracked health signal.

# Key Technologies & Stack

- **Node.js** (CommonJS, `type: "commonjs"`) — server, CLI and scripts.
- **Express 5** — HTTP, static serving, JSON bodies, REST routes.
- **Server-Sent Events** (native `res.write`, no library) — live board updates
  and streamed command output.
- **Node `fs.watch`** — change detection driving the push model.
- **Node `child_process.spawn`** — every external CLI call: dispatch runs,
  tooling probes, plugin installs.
- **`node:test`** — the whole suite, run with `npm test`. No test framework
  and no assertion library beyond `node:assert/strict`.
- **Vanilla JavaScript, HTML, CSS** — the entire frontend.
- **Bash** — the plugin's hooks and the repository's own git hook.

# Directory Structure

```
meridian/
├── server.js               # Express app: REST API, SSE, aggregation, dispatch orchestration
├── cli.js                  # `meridian` entrypoint: start / restart / stop / add
├── lib/                    # The decisions, as pure testable modules
│   ├── tasks.js            #   read/write tasks.jsonl and the detail files
│   ├── board.js            #   board shaping and the workable-task view
│   ├── projects.js         #   the global registry
│   ├── events.js           #   the append-only event log
│   ├── stats.js            #   metrics derived from events
│   ├── dispatch-*.js       #   queue, eligibility, command, lock, sessions, outcome
│   ├── stale-running.js    #   whether a `running: true` flag is orphaned
│   ├── run-log.js          #   per-run log files
│   ├── tooling.js          #   CLI probes, states and the command each one implies
│   ├── plugin-sync.js      #   is the installed plugin still this repository's
│   ├── allowlist-template.js, gitignore.js, routes.js
│   └── command-highlight.js, inline-markdown.js   # also copied inline into public/app.js
├── public/                 # Frontend, served statically
│   ├── index.html          #   dashboard, project view, settings, modals
│   ├── app.js              #   SSE client, rendering, dispatch controls, settings
│   ├── styles.css
│   └── icons/, favicon.svg
├── plugin/plugins/meridian/   # The plugin agents run (see Repository Conventions)
│   ├── .claude-plugin/plugin.json   #   its manifest — the version that gates updates
│   ├── skills/             #   /meridian:work, :next, :status, :new
│   ├── agents/             #   pm, spec-generator, spec-reviewer, developer, code-reviewer, qa
│   ├── references/         #   schema.md is the single source of truth for the task schema
│   ├── hooks/, hooks.json  #   the running-flag and permission hooks
│   └── scripts/            #   running-flag.sh, allow-meridian.sh
├── .claude-plugin/marketplace.json   # makes this repo a local plugin marketplace
├── .githooks/pre-commit    # refuses a plugin change that forgets its version bump
├── scripts/                # one-shot migrations and maintenance, each guarded by require.main
├── prompts/                # prompt templates for the "Fix with AI" metadata repair
├── test/                   # node:test suite, one file per module or endpoint group
├── docs/                   # specs, plans and operational notes
└── .meridian/              # Meridian's own board, tracked like any other project
```

# Domain Concepts

- **Project (registry entry)** — A workspace subdirectory registered with
  Meridian. The registry stores only its `path`; every descriptive field lives
  inside the project.
- **Decentralized metadata** — Each project owns its `project-info.json`. The
  legacy shape, where the global registry embedded each project's name and
  stack, is migrated away on startup.
- **`tasks.jsonl`** — One compact JSON object per line; no wrapping array and
  no `tasks` key. The canonical field list, the nine statuses and the
  timestamp rules live in `plugin/plugins/meridian/references/schema.md`,
  which is the single source of truth.
- **Dispatch** — Handing a task to an agent from the board. The server spawns
  `claude -p` in the project directory with a permission allowlist, holds a
  one-run-per-repository lock, and records the outcome. A refusal is kept and
  shown rather than discarded, so a run that never started says why.
- **Derived over stored** — The recurring rule behind the dispatch design. A
  lock is a pid that either answers or does not; a session list is whatever
  the CLI reports right now. Stored flags go stale and need a janitor, which
  is the lesson the `running` flag taught twice.
- **`running` / `running_session`** — `running` marks a task an agent is
  working; `running_session` records which session set it, so an orphaned flag
  can be told from a live one without guessing.
- **Health signals** — Missing `AGENTS.md`, `stack` or `description`, computed
  on every aggregation pass and shown as badges.
- **Fix with AI** — A dashboard action that runs an agent CLI inside a project
  with a template from `prompts/` to repair one of those missing fields,
  streaming its output back over SSE.
- **`RUNNING_DIR`** — The directory treated as the workspace root when
  locating the global registry. Defaults to the working directory, overridable
  with `MERIDIAN_RUNNING_DIR`.

# Repository Conventions

## Bump the plugin version in the same commit that changes the plugin

Any commit that touches `plugin/plugins/meridian/**` MUST also raise
`version` in `plugin/plugins/meridian/.claude-plugin/plugin.json`.

This is not bookkeeping. `claude plugin update` compares the declared
version, not file content: when the version has not moved it reports the
plugin already current and copies nothing, so the edit never reaches the
installed copy the agent actually executes. `npm run plugin:reload` runs that
same command and is equally inert. The settings screen compares content and
will correctly report the drift, but the action it offers cannot clear it —
the only way out is a version that moved.

Left unbumped this fails silently and accumulates: twelve days of plugin
edits once sat unshipped while the board read "Outdated" and every update
reported success.

- Patch (`0.2.0` → `0.2.1`) for a fix to an existing skill, agent, hook or
  reference.
- Minor (`0.2.0` → `0.3.0`) for a new skill or agent, or any change to the
  task schema in `references/schema.md`.
- After bumping, `npm run plugin:reload` actually installs it. Claude Code
  applies a new hook only on restart, so a session open at that moment keeps
  running the old one.

Commits that leave the plugin directory untouched do not bump anything.

<!-- MERIDIAN_INSTRUCTIONS_START -->
# Meridian Instructions

> **AI Task Management**: If an AI agent needs to create, update, or read project tasks, it MUST go through the Meridian server first — the server owns the timestamps, so it is the only write path that keeps them consistent. Read the board with `GET http://localhost:3333/api/status?project=<absolute project path>` — this no longer carries `expected_results`. Read one task's `expected_results` with `GET http://localhost:3333/api/projects/tasks/<task id>?project=<absolute project path>`. Create with `POST http://localhost:3333/api/projects/tasks`, update with `PUT http://localhost:3333/api/projects/tasks/<task id>` (both writes take `projectPath` in the JSON body, and both accept `expected_results`). Only when the server is not running — the request fails to connect and `node cli.js start` is not an option — may an agent fall back to hand-editing `.meridian/tasks.jsonl` (and `.meridian/tasks/<task id>.json` for `expected_results`) directly, writing the detail file before the line and applying the timestamp rules below by hand.
> **File Shape**: `.meridian/tasks.jsonl` is one compact JSON object per line, one task per line — NOT an array and NOT an object with a `tasks` key. `expected_results` does not travel on the line: it lives in `.meridian/tasks/<task id>.json` as `{"expected_results": [...]}`, present only when the array is non-empty. A task's line carries `id`, `title`, `status`, `priority`, `justification`, `blockedBy`, `running`, `created_at`, `updated_at`, `moved_at` and `completed_at`. Never delete a task — move it to `nope` instead.
> **Timestamps**: ISO-8601 UTC strings. `created_at` is set once, on creation. `updated_at` is set on every write. `moved_at` is set on every status change. `completed_at` is set when the status enters `done` and set back to `null` when it leaves `done`. The server stamps all four; a hand-edit must reproduce them exactly.
> **Priority (`priority`)**: EXACTLY one of `critical`, `high`, `medium`, `low`. A task without one is read as `medium`.
> **Active Execution (`running`)**: boolean flag (`true`/`false`). Set to `true` when an agent starts actively working on a task, and set to `false` when finished or handed off.
> **Dependencies (`blockedBy`)**: optional array of task IDs that must reach `done` before this task can proceed. A task with a non-empty `blockedBy` whose dependencies aren't all `done` yet should have status `blocked` — that dependency is sufficient justification on its own (e.g. `justification: "Blocked on <task-id>"`). When every task in `blockedBy` reaches `done`, move this task back to `backlog`.
> **Allowed Statuses**: When assigning a status to a task, you MUST use EXACTLY one of the following lowercase strings. They carry no spaces and no slashes. DO NOT invent new statuses or use synonyms like 'pending', 'todo', 'completed', 'in progress' or 'qa/review'.
  - `backlog`: Task is planned but not ready to be worked on yet.
  - `spec_review`: Task needs specification or design review.
  - `ready_todo`: Task is fully specified and ready to be picked up.
  - `in_progress`: Task is currently being worked on by developer.
  - `code_review`: Task code is being reviewed for architecture, security, and test quality.
  - `qa_review`: Task is being verified independently by QA against expected results.
  - `blocked`: Task cannot proceed due to external dependencies.
  - `done`: Task is fully completed.
  - `nope`: Task was cancelled or won't be done.
> **Implementation Rule**: Before starting any implementation work, ask the user if they want to create a task for it in the Meridian system.
<!-- MERIDIAN_INSTRUCTIONS_END -->
