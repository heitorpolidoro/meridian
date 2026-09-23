# Project Context & Purpose

Meridian is a **workspace status dashboard** for a developer (referred to internally as "the CTO") who manages multiple independent software projects at once. It solves the problem of losing visibility into the state of many concurrent projects — what's in progress, what's blocked, which projects are missing basic documentation (like an `AGENTS.md`), and what an AI orchestrator agent should work on next.

It has two audiences:
1. **The human user**, who gets a live, auto-refreshing web dashboard listing every tracked project, its declared tech stack, description, and task backlog.
2. **AI agents**, specifically an orchestrator persona named **Odin** ("Chief of Staff"), who reads the same underlying data files (`.meridian/projects.json`, per-project `.meridian/project-info.json`, and per-project `.meridian/tasks.jsonl`) to coordinate work, delegate to specialist subagents, and produce executive briefings across all managed projects.

Meridian itself does not implement project work — it is meta-tooling: a registry, dashboard, and light automation layer sitting above a workspace of unrelated projects.

# High-level Architecture

Meridian is a small single-process Node.js application with three cooperating parts:

- **Backend (`server.js`)** — An Express app that:
  - Aggregates status data by reading a global project registry plus each tracked project's local metadata and task files (no database; the filesystem is the data layer).
  - Serves a REST API for managing the project registry (add/edit projects, list candidate directories).
  - Pushes live updates to the browser over **Server-Sent Events** (`/api/stream`), triggered by `fs.watch` watchers on `projects.json` and every tracked project's `.meridian/` directory.
  - Implements a "Fix with AI" feature: on request, it spawns an external AI CLI (`claude` or `agy`) as a child process inside the target project's directory, feeding it a canned prompt (from `prompts/`) to auto-generate a missing `AGENTS.md`, infer the tech `stack`, or write a `description`. Progress/log output is streamed back to the browser via the same SSE channel.
  - Performs a one-time startup migration from an older centralized `projects.json` schema (which embedded `name`/`stack`/`purpose` per entry) to the current **decentralized** schema, where the global file only stores project `path`s and each project owns its own metadata in `.meridian/project-info.json`.

- **Frontend (`public/`)** — Static, dependency-free HTML/CSS/vanilla JS (`index.html`, `app.js`, `styles.css`). It connects to the SSE stream on load, renders a card per project (name, description, stack badges, task list, warning badges for missing metadata), and provides modals for adding/editing a project and for launching "Fix with AI" runs.

- **CLI (`cli.js`, `meridian_sync`)**:
  - `cli.js` is the `meridian` command-line entrypoint. `meridian start` launches `server.js` as a detached background process (logs to `meridian-out.log` / `meridian-err.log`); `meridian add <path>` registers a new project directory in the global registry without going through the UI.
  - `meridian_sync` is a standalone bash script (independent of the Node app) that copies the Odin agent persona definition (`agents/Odin.md`) into the parent workspace's shared agent directory (`../.agents/orchestrator/AGENT.md`), so other tooling in the workspace can load Odin as the active orchestrator agent.

- **Data layer** — Entirely file-based, no database:
  - `<RUNNING_DIR>/.meridian/projects.json` — global registry, one entry per tracked project (`{ path }`).
  - `<project>/.meridian/project-info.json` — per-project metadata: `name`, `description`, `stack` (array of technologies).
  - `<project>/.meridian/tasks.jsonl` — per-project task backlog, one compact JSON object per line (see Domain Concepts).
  - `<project>/.meridian/tasks/<id>.json` — the `expected_results` of one task, kept out of the line so the board payload stays small.
  - `<project>/AGENTS.md` — per-project knowledge base for AI agents; its mere presence/absence is tracked and surfaced as a dashboard warning.

- **Agent layer (`agents/`, `prompts/`)** — Not executable code, but consumed by AI coding tools:
  - `agents/Odin.md` defines the Odin orchestrator persona (responsibilities, task schema, delegation protocol, briefing format) used by external agent-runner tooling (e.g. Claude Code, AGY) elsewhere in the workspace.
  - `prompts/*.txt` are prompt templates used by the backend's "Fix with AI" feature (`agents.txt`, `stack.txt`, `description.txt`), each instructing an AI CLI to generate/repair one specific piece of a target project's metadata.

# Key Technologies & Stack

- **Node.js** (CommonJS modules, `type: "commonjs"` in `package.json`) — runtime for both the server and CLI.
- **Express 5** — HTTP server, static file serving, JSON body parsing, REST routes.
- **Server-Sent Events (native, via raw `res.write`)** — real-time push of dashboard updates and AI-fix progress/logs to the browser; no WebSocket library used.
- **Node `fs.watch`** — filesystem change detection driving the SSE push model.
- **Node `child_process.spawn`** — shells out to external AI CLIs (`claude`, `agy`) for the "Fix with AI" automation.
- **Vanilla JavaScript, HTML, CSS** — the entire frontend, no build step, no framework, no bundler.
- **Bash** — `meridian_sync` utility script.
- **Google Fonts (Inter)** — only external runtime dependency in the UI.

# Directory Structure

```
meridian/
├── server.js              # Express app: REST API, SSE stream, filesystem aggregation, AI-fix orchestration
├── cli.js                 # `meridian` CLI entrypoint (start / add commands)
├── meridian_sync           # Bash script: syncs agents/Odin.md into the workspace's shared agent directory
├── package.json / package-lock.json
├── public/                 # Static frontend served by Express
│   ├── index.html          # Dashboard markup + Add/Edit Project and Fix-with-AI modals
│   ├── app.js               # SSE client, project card rendering, modal/form logic, fix-with-AI flow
│   └── styles.css           # Dashboard styling
├── agents/
│   └── Odin.md              # Chief-of-Staff orchestrator agent persona/protocol definition
├── prompts/                 # Prompt templates used by the "Fix with AI" backend feature
│   ├── agents.txt            # Prompt to generate a missing AGENTS.md
│   ├── stack.txt              # Prompt to infer/rewrite the `stack` field in project-info.json
│   └── description.txt        # Prompt to infer/rewrite the `description` field in project-info.json
├── .meridian/
│   └── project-info.json    # Meridian's own metadata entry (name/description/stack), same schema it expects of tracked projects
├── meridian-out.log / meridian-err.log   # stdout/stderr logs from `meridian start` (detached server process)
└── test-spawn.js            # Standalone scratch script for experimenting with child_process spawning
```

Data owned by *tracked* projects (not part of this repo, but read/written by it at runtime):
```
<tracked-project>/.meridian/project-info.json   # name, description, stack[]
<tracked-project>/.meridian/tasks.jsonl          # task backlog, one JSON object per line
<tracked-project>/.meridian/tasks/<id>.json      # per-task expected_results
<tracked-project>/AGENTS.md                       # presence is tracked as a health signal
```

# Domain Concepts

- **Project (registry entry)** — A workspace subdirectory that has been registered with Meridian. The global registry only stores its filesystem `path`; all descriptive metadata lives inside the project itself.
- **Decentralized architecture** — The current data model where each project owns its own `.meridian/project-info.json`, as opposed to the legacy model where the global `projects.json` embedded every project's `name`, `stack`, and `purpose` directly. `server.js` auto-migrates old-format entries on startup.
- **`project-info.json`** — Per-project metadata file: `name`, `description`, `stack` (array of technology strings).
- **`tasks.jsonl`** — Per-project task backlog: one compact JSON object per line, no wrapping array and no `tasks` key. Each task's `expected_results` lives beside it in `.meridian/tasks/<id>.json`, so the board can be served without them; `GET /api/projects/tasks/:taskId` serves a task with the field hydrated. The canonical field list, the nine statuses and the timestamp rules are defined in `plugin/plugins/meridian/references/schema.md`, which is the single source of truth.
- **Health signals / "missing" badges** — The dashboard flags a project as missing `AGENTS.md`, missing `stack`, or missing `description`, computed by `getStatusData()` in `server.js` on every aggregation pass.
- **Fix with AI** — A dashboard action that shells out to an AI coding CLI (`claude` or `agy`) inside a specific tracked project's directory, using one of the `prompts/*.txt` templates, to auto-remediate a missing-metadata health signal. Output streams back to the UI live over SSE.
- **Odin / Chief of Staff** — An AI orchestrator persona (defined in `agents/Odin.md`, synced elsewhere via `meridian_sync`) that consumes Meridian's data files to track tasks, delegate to specialist subagents, identify blocked work, and produce executive "CTO briefings" summarizing the state of all managed projects. Odin does not modify production code directly — it only delegates and records.
- **CTO** — The human operator of the workspace; the audience for Odin's briefings and the user of the Meridian dashboard.
- **Subagent** — A specialist AI agent (e.g. a "react-expert") that Odin delegates individual tasks to; dispatched by the Meridian skills against a single task at a time.
- **`RUNNING_DIR`** — The directory Meridian treats as the workspace root when locating the global `.meridian/projects.json`; defaults to the current working directory but is overridable via the `MERIDIAN_RUNNING_DIR` environment variable.









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
