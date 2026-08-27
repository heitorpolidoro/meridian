# Project Context & Purpose

Meridian is a **workspace status dashboard** for a developer (referred to internally as "the CTO") who manages multiple independent software projects at once. It solves the problem of losing visibility into the state of many concurrent projects — what's in progress, what's blocked, which projects are missing basic documentation (like an `AGENTS.md`), and what an AI orchestrator agent should work on next.

It has two audiences:
1. **The human user**, who gets a live, auto-refreshing web dashboard listing every tracked project, its declared tech stack, description, and task backlog.
2. **AI agents**, specifically an orchestrator persona named **Odin** ("Chief of Staff"), who reads the same underlying data files (`.meridian/projects.json`, per-project `.meridian/project-info.json`, and per-project `tasks.json`) to coordinate work, delegate to specialist subagents, and produce executive briefings across all managed projects.

Meridian itself does not implement project work — it is meta-tooling: a registry, dashboard, and light automation layer sitting above a workspace of unrelated projects.

# High-level Architecture

Meridian is a small single-process Node.js application with three cooperating parts:

- **Backend (`server.js`)** — An Express app that:
  - Aggregates status data by reading a global project registry plus each tracked project's local metadata and task files (no database; the filesystem is the data layer).
  - Serves a REST API for managing the project registry (add/edit projects, list candidate directories).
  - Pushes live updates to the browser over **Server-Sent Events** (`/api/stream`), triggered by `fs.watch` watchers on `projects.json` and every tracked project's `tasks.json`.
  - Implements a "Fix with AI" feature: on request, it spawns an external AI CLI (`claude` or `agy`) as a child process inside the target project's directory, feeding it a canned prompt (from `prompts/`) to auto-generate a missing `AGENTS.md`, infer the tech `stack`, or write a `description`. Progress/log output is streamed back to the browser via the same SSE channel.
  - Performs a one-time startup migration from an older centralized `projects.json` schema (which embedded `name`/`stack`/`purpose` per entry) to the current **decentralized** schema, where the global file only stores project `path`s and each project owns its own metadata in `.meridian/project-info.json`.

- **Frontend (`public/`)** — Static, dependency-free HTML/CSS/vanilla JS (`index.html`, `app.js`, `styles.css`). It connects to the SSE stream on load, renders a card per project (name, description, stack badges, task list, warning badges for missing metadata), and provides modals for adding/editing a project and for launching "Fix with AI" runs.

- **CLI (`cli.js`, `meridian_sync`)**:
  - `cli.js` is the `meridian` command-line entrypoint. `meridian start` launches `server.js` as a detached background process (logs to `meridian-out.log` / `meridian-err.log`); `meridian add <path>` registers a new project directory in the global registry without going through the UI.
  - `meridian_sync` is a standalone bash script (independent of the Node app) that copies the Odin agent persona definition (`agents/Odin.md`) into the parent workspace's shared agent directory (`../.agents/orchestrator/AGENT.md`), so other tooling in the workspace can load Odin as the active orchestrator agent.

- **Data layer** — Entirely file-based, no database:
  - `<RUNNING_DIR>/.meridian/projects.json` — global registry, one entry per tracked project (`{ path }`).
  - `<project>/.meridian/project-info.json` — per-project metadata: `name`, `description`, `stack` (array of technologies).
  - `<project>/tasks.json` — per-project task backlog (see Domain Concepts).
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
<tracked-project>/tasks.json                     # task backlog (see Domain Concepts)
<tracked-project>/AGENTS.md                       # presence is tracked as a health signal
```

# Domain Concepts

- **Project (registry entry)** — A workspace subdirectory that has been registered with Meridian. The global registry only stores its filesystem `path`; all descriptive metadata lives inside the project itself.
- **Decentralized architecture** — The current data model where each project owns its own `.meridian/project-info.json`, as opposed to the legacy model where the global `projects.json` embedded every project's `name`, `stack`, and `purpose` directly. `server.js` auto-migrates old-format entries on startup.
- **`project-info.json`** — Per-project metadata file: `name`, `description`, `stack` (array of technology strings).
- **`tasks.json`** — Per-project task backlog file with a `lastUpdated` timestamp and a `tasks` array. Each task has `id`, `title`, `description`, `status` (`todo` | `in_progress` | `blocked` | `done`), `priority` (`critical` | `high` | `medium` | `low`), `assignee` (convention: `subagent:<name>`), `blockedReason`, and `completedAt`. This schema is defined and enforced by the Odin agent protocol, not by application code.
- **Health signals / "missing" badges** — The dashboard flags a project as missing `AGENTS.md`, missing `stack`, or missing `description`, computed by `getStatusData()` in `server.js` on every aggregation pass.
- **Fix with AI** — A dashboard action that shells out to an AI coding CLI (`claude` or `agy`) inside a specific tracked project's directory, using one of the `prompts/*.txt` templates, to auto-remediate a missing-metadata health signal. Output streams back to the UI live over SSE.
- **Odin / Chief of Staff** — An AI orchestrator persona (defined in `agents/Odin.md`, synced elsewhere via `meridian_sync`) that consumes Meridian's data files to track tasks, delegate to specialist subagents, identify blocked work, and produce executive "CTO briefings" summarizing the state of all managed projects. Odin does not modify production code directly — it only delegates and records.
- **CTO** — The human operator of the workspace; the audience for Odin's briefings and the user of the Meridian dashboard.
- **Subagent** — A specialist AI agent (e.g. a "react-expert") that Odin delegates individual tasks to; referenced in `tasks.json` via the `assignee` field as `subagent:<name>`.
- **`RUNNING_DIR`** — The directory Meridian treats as the workspace root when locating the global `.meridian/projects.json`; defaults to the current working directory but is overridable via the `MERIDIAN_RUNNING_DIR` environment variable.







<!-- MERIDIAN_INSTRUCTIONS_START -->
# Meridian Instructions

> **AI Task Management**: If an AI agent needs to create, update, or read project tasks, they MUST directly parse and modify the `.meridian/tasks.json` file (A JSON object with a `tasks` array containing tasks with `id`, `title`, `status`, `justification`, `blockedBy`, `running`).
> **Active Execution (`running`)**: boolean flag (`true`/`false`). Set to `true` when an agent starts actively working on a task, and set to `false` when finished or handed off.
> **Dependencies (`blockedBy`)**: optional array of task IDs that must reach `done` before this task can proceed. A task with a non-empty `blockedBy` whose dependencies aren't all `done` yet should have status `blocked` — that dependency is sufficient justification on its own (e.g. `justification: "Blocked on <task-id>"`). When every task in `blockedBy` reaches `done`, move this task back to `backlog`.
> **Allowed Statuses**: When assigning a status to a task, you MUST use EXACTLY one of the following lowercase strings. DO NOT invent new statuses or use synonyms like 'pending', 'todo', or 'completed'.
  - `backlog`: Task is planned but not ready to be worked on yet.
  - `specreview`: Task needs specification or design review.
  - `readytodo`: Task is fully specified and ready to be picked up.
  - `inprogress`: Task is currently being worked on by developer.
  - `codereview`: Task code is being reviewed for architecture, security, and test quality.
  - `qareview`: Task is being verified independently by QA against expected results.
  - `blocked`: Task cannot proceed due to external dependencies.
  - `done`: Task is fully completed.
  - `nope`: Task was cancelled or won't be done.
> **Implementation Rule**: Before starting any implementation work, ask the user if they want to create a task for it in the Meridian system.
<!-- MERIDIAN_INSTRUCTIONS_END -->
