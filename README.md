# Meridian

A local kanban board that an AI agent can read, write, and be driven by.

Meridian keeps one task board per project, stored as plain files inside that
project's own `.meridian/` directory. A small Express server renders every
board in one dashboard and exposes them over a REST API. A companion plugin
teaches Claude Code and Antigravity to read the same files, so the board is
both what you look at and what the agent works from — not a copy of it.

There is no database. The filesystem is the data layer, and every file is
meant to be readable with `cat` and greppable with `grep`.

## Why it exists

Driving an AI agent through real work means answering the same question over
and over: what is this task, what was decided about it, and what is left. Chat
history answers that badly — it scrolls away, and a new session starts blind.

Meridian puts that state in files next to the code. A task carries its spec,
its expected results, the questions asked about it and the answers given. An
agent picking the task up a week later reads the same thing you do.

## Requirements

- Node.js 18 or newer — Express 5's own floor; developed on 24
- [Claude Code](https://code.claude.com/docs/en/setup) or
  [Antigravity](https://antigravity.google/docs/getting-started?tab=cli), if you
  want the agent pipeline. The board works on its own without either.

## Running the board

```bash
npm install
node server.js
```

The dashboard is then at `http://localhost:3333`. `PORT` overrides the port.

To run it detached, with a pidfile and logs:

```bash
node cli.js start     # also: stop, restart
node cli.js add <path>
```

Meridian walks up from the directory it starts in to find the workspace root,
and keeps its registry of tracked projects at
`<workspace>/.meridian/projects.json`. Point it at a directory holding several
repositories and it will show them side by side.

## The board

Ten columns, in pipeline order:

`backlog` → `spec_review` → `spec_approval` → `ready_todo` → `in_progress` →
`code_review` → `qa_review` → `done`

plus `blocked` for work waiting on another task, and `nope` for work that was
dropped. Both terminal columns sort by recency, so what finished today is at
the top rather than buried under last week.

The two review columns are where a human is expected to intervene: a spec is
approved or sent back before code is written, and the result is approved or
sent back before the task closes.

## How a task is stored

Inside each tracked project:

```
.meridian/
├── project-info.json     name, description, tech stack
├── tasks.jsonl           one compact JSON object per line, one line per task
├── tasks/<id>.json       the expected results for that task, split out
└── events.jsonl          append-only history of every change
```

`tasks.jsonl` is one line per task rather than one pretty-printed array,
because it makes the cheap operations cheap: `wc -l` counts the board without
parsing it, and `grep '"id":"PROJ-42"'` returns one whole task. The bulky part
of a task — its expected results — lives in its own file, so reading the board
does not mean reading every acceptance criterion on it.

Writes go through a single boundary (`lib/tasks.js`) and are atomic: serialise,
write a sibling temp file, rename. The detail file is written before the line
that refers to it, so a crash can leave an orphan detail file but never a line
pointing at something absent.

## The plugin

The plugin is what lets an agent drive the board. It ships four skills:

| Skill | What it does |
|---|---|
| `/meridian:status` | the board state for the project you are in |
| `/meridian:new` | record a task, from a title alone or from work already done |
| `/meridian:next` | pick the task closest to done and hand it to `work` |
| `/meridian:work` | drive one task through the pipeline until done or blocked |

`work` is the substantial one. It dispatches specialist subagents in sequence —
spec generation, spec review, implementation, code review, QA — and stops at
the two approval columns for a human.

### Installing it

For Claude Code:

```bash
claude plugin marketplace add heitorpolidoro/meridian
claude plugin install meridian@meridian
```

For Antigravity, which has no marketplace concept, install from a clone:

```bash
agy plugin install plugin/plugins/meridian
node scripts/render-agy-hooks.js
```

The second command is not optional. Antigravity's hook manifest needs an
absolute path and documents no plugin-root variable, so the tracked file
carries a placeholder and that script writes the real install directory into
the copy. `npm run plugin:reload` does both CLIs and this step together.

## Settings

`/settings` in the dashboard reports, for each CLI: whether it is installed,
whether it could actually run a dispatch, and whether the installed plugin
still matches this repository. That last one is content-addressed rather than
version-based — neither CLI reports a version that moves when you edit a skill,
so a stale copy is otherwise invisible while the agent quietly reads it.

Each action shows the exact command before running it, with buttons to copy it
or run it in place. The page posts an action name, never a command string: the
command table in `lib/tooling.js` is the only thing that can be executed.

## API

| | |
|---|---|
| `GET /api/status` | every project, light — no task detail |
| `GET /api/projects/tasks/:taskId` | one task, including its expected results |
| `POST`/`PUT`/`DELETE /api/projects/tasks` | create, update, remove |
| `GET /api/stats` | time per stage, measured from real agent runtime |
| `GET /api/stream` | server-sent events, pushed on any file change |
| `GET /api/tooling` | CLI and plugin state for the settings screen |

Stage durations come from the `running` flag rather than from how long a task
sat in a column, so idle overnight time is not reported as work.

## Tests

```bash
npm test
```

341 tests, no framework beyond `node --test`. They are hermetic: everything
writes to `os.tmpdir()`, and nothing reads the registry of whatever workspace
you happen to be in.

## Layout

```
server.js          Express app, REST API, SSE, file watchers
cli.js             start/stop/add
lib/               all logic worth testing, one concern per file
public/            dashboard — no framework, no build step
plugin/            the Claude Code / Antigravity plugin
docs/              design docs and implementation plans
scripts/           migrations and install helpers
```

`public/` has no module system, so a few functions in `lib/` have an inline
copy in `public/app.js`. Where that happens, the `lib/` file says so and is the
source of truth.

## License

ISC
