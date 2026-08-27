# Meridian Plugin & Skills — Implementation Plan (Phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Meridian as a Claude Code plugin providing four project-scoped skills (`meridian:status`, `meridian:work`, `meridian:new`, `meridian:next`) and six agents from a single source, replacing the 36 agent files currently copied across six projects; and stop the `done` column from drowning the board.

**Architecture:** The plugin installs once at user scope and is visible in every directory, so each skill's first act is to validate `./.meridian/` in the CWD and offer onboarding when it is absent. The pipeline protocol that used to live in `agents/pm.md` is dissolved: its flow rules become `references/pipeline.md` (loaded by `work`), its schema becomes `references/schema.md` (shared), and its bootstrap section becomes the charter of a redefined `pm` agent that plans and curates rather than orchestrates. Skills run in the main session and talk to the operator; the six agents are subagents the skills dispatch. All task writes go through the Phase 1 API.

**Tech Stack:** Claude Code plugin (`.claude-plugin/marketplace.json` + `plugins/<name>/.claude-plugin/plugin.json`, with `agents/`, `skills/`, `references/` at the plugin root), Markdown skills with YAML frontmatter, Node.js 24 / Express 5 for the two server-side fixes, `node --test` via `npm test`, vanilla JS for the board.

**Spec:** `docs/superpowers/specs/2026-08-27-meridian-skills-design.md`

**Phase 1 (merged, `c654fc4`):** `lib/tasks.js` owns the data layer; `tasks.json` is a bare array; `moved_at` / `completed_at` / `priority` are stamped by the server; `POST`/`PUT` accept the full schema and validate `status`/`priority`; `GET /api/status` accepts `project` and `limit`.

## Global Constraints

- No new runtime dependencies. `express` stays the only entry in `dependencies`.
- Test runner is Node's built-in `node --test` via `npm test`. The bare-directory form `node --test test/` crashes on every Node installed on this machine — always use `npm test`.
- CommonJS for all Node code.
- Status values are exactly these nine, lowercase: `backlog`, `specreview`, `readytodo`, `inprogress`, `codereview`, `qareview`, `blocked`, `done`, `nope`.
- Priority values are exactly these four, lowercase: `critical`, `high`, `medium`, `low`. Default `medium`.
- Task ids are `<KEY>-<N>`, with `KEY` from `.meridian/project-info.json`. The server generates them; never compute an id client-side.
- **Every task write goes through the server API.** Skills and agents never hand-edit `tasks.json` while the server is reachable. Skills start the server (`node cli.js start`) before acting.
- Skills resolve the project from `./.meridian/` in the **current working directory only**. Never walk up the tree.
- All specs, commits, and agent-facing prose in English. Skill descriptions in English.
- Never delete a task.
- Automated tests write only to `os.tmpdir()`. Never touch the six real projects under `~/workspace`.
- The Meridian server's default port is 3333 (`server.js:8`). Use 3399 for any verification server so the live one is undisturbed.

## Verification model — read this before Task 1

Phase 1 was Node code and every task carried a `node --test` cycle. Phase 2 is mostly **prose artifacts** — skills and agent definitions — which have no unit tests. Faking a TDD cycle for a Markdown file would be theatre. Each task below states the verification it actually supports:

| Kind of task | How it is verified |
|---|---|
| Plugin scaffold | `claude plugin marketplace add` / `install`, then `claude plugin list` and a skill invocation |
| Skill or agent prose | Structural checks (frontmatter parses, referenced paths exist, no dangling `${CLAUDE_PLUGIN_ROOT}`), then a behavioral run against a throwaway project registered in Meridian, asserting the resulting state through the API |
| Server code (Task 9) | `npm test`, TDD as in Phase 1 |
| Board filter (Task 8) | Browser verification against the live board plus a `node --test` unit test for the extracted predicate |

**A note on installing:** `claude plugin marketplace add` and `claude plugin install` modify user-level configuration. In a non-interactive session the permission classifier may refuse them — this happened when installing an unrelated plugin earlier. If a step is refused, stop and hand the exact command to the operator rather than working around it.

## File Structure

| File | Responsibility |
|---|---|
| `plugin/.claude-plugin/marketplace.json` (create) | Marketplace manifest listing the one plugin. |
| `plugin/plugins/meridian/.claude-plugin/plugin.json` (create) | Plugin manifest: name, description, author. |
| `plugin/plugins/meridian/references/schema.md` (create) | Task schema and the nine-status vocabulary. Shared by `status`, `work`, `new`, `next`. |
| `plugin/plugins/meridian/references/pipeline.md` (create) | Fluxo A/B, iteration cap, stagnation check, commit rule, unblocking rule. Loaded by `work`. |
| `plugin/plugins/meridian/references/preamble.md` (create) | The shared skill preamble: resolve project, ensure server, onboard. |
| `plugin/plugins/meridian/agents/*.md` (create, 6) | `pm` (redefined), `developer`, `qa`, `code-reviewer`, `spec-generator`, `spec-reviewer`. |
| `plugin/plugins/meridian/skills/{status,work,new,next}/SKILL.md` (create) | The four skills. |
| `public/app.js`, `public/index.html` (modify) | The `done` window filter. |
| `lib/board.js` (create) | The `done`-window predicate, extracted so it can be unit-tested. |
| `server.js`, `test/api-tasks.test.js` (modify) | Task 9's two deferred findings. |
| `agents/`, `.claude/agents/`, `.agents/agents/` (delete) | Removed in Task 10 once the plugin is proven. |

---

### Task 1: Plugin scaffold that loads

Prove the mechanism before writing content into it. This task ships one trivial skill whose only job is to appear in `claude plugin list` and be invocable.

**Files:**
- Create: `plugin/.claude-plugin/marketplace.json`
- Create: `plugin/plugins/meridian/.claude-plugin/plugin.json`
- Create: `plugin/plugins/meridian/skills/status/SKILL.md` (placeholder body, replaced in Task 5)

**Interfaces:**
- Consumes: nothing.
- Produces: an installable plugin named `meridian`, and the marketplace name `meridian` used by every later `claude plugin` command.

- [ ] **Step 1: Write the marketplace manifest**

Create `plugin/.claude-plugin/marketplace.json`:

```json
{
  "name": "meridian",
  "owner": {
    "name": "Heitor Polidoro"
  },
  "metadata": {
    "description": "Project-scoped skills and agents that drive the Meridian task pipeline.",
    "version": "0.1.0"
  },
  "plugins": [
    {
      "name": "meridian",
      "source": "./plugins/meridian",
      "description": "Read, create, and advance Meridian tasks for the project in the current directory."
    }
  ]
}
```

- [ ] **Step 2: Write the plugin manifest**

Create `plugin/plugins/meridian/.claude-plugin/plugin.json`:

```json
{
  "name": "meridian",
  "description": "Project-scoped skills and agents for the Meridian task pipeline: read board status, create tasks, and drive a task from backlog to done.",
  "author": {
    "name": "Heitor Polidoro"
  }
}
```

- [ ] **Step 3: Write a placeholder skill**

Create `plugin/plugins/meridian/skills/status/SKILL.md`:

```markdown
---
name: status
description: Use when the operator asks for the Meridian board state of the current project - lists tasks per status and surfaces interrupted work.
---

# Meridian Status

Placeholder. Replaced in Task 5.

Report that the Meridian plugin loaded successfully and that this skill is not implemented yet.
```

- [ ] **Step 4: Register and install**

```bash
claude plugin marketplace add ~/workspace/meridian/plugin
claude plugin install meridian@meridian
```

If either command is refused by the permission classifier, stop and report both commands verbatim for the operator to run. Do not attempt an alternative install path.

- [ ] **Step 5: Verify it loaded**

```bash
claude plugin list | grep -A3 meridian
```

Expected: a `meridian@meridian` entry, scope `user`, status enabled.

- [ ] **Step 6: Commit**

```bash
git add plugin/
git commit -m "feat: meridian plugin scaffold with a placeholder status skill"
```

---

### Task 2: Shared references

The three files every skill reads. Extract them from `agents/pm.md` and `AGENTS.md`, which stay in place until Task 10.

**Files:**
- Create: `plugin/plugins/meridian/references/schema.md`
- Create: `plugin/plugins/meridian/references/pipeline.md`
- Create: `plugin/plugins/meridian/references/preamble.md`

**Interfaces:**
- Consumes: the content of `agents/pm.md` (Task Schema, Fluxo A, Fluxo B, Stagnation, Unblocking sections).
- Produces: three files addressed by later skills as `${CLAUDE_PLUGIN_ROOT}/references/<name>.md`.

- [ ] **Step 1: Write `references/schema.md`**

It must state, as prose an agent can follow:
- The file is `<project>/.meridian/tasks.json`, a **bare JSON array** of task objects — not an object with a `tasks` key.
- Every field, with its type and who writes it: `id` (server), `title`, `status`, `priority`, `justification`, `expected_results` (array), `blockedBy` (array of ids), `spec_path`, `spec_iterations`, `code_review_iterations`, `qa_iterations`, `last_review_findings` (array), `running` (boolean), `created_at`, `updated_at`, `moved_at`, `completed_at` (the last four stamped by the server, never by an agent).
- The nine statuses with a one-line meaning each, copied from the `AGENTS.md` MERIDIAN_INSTRUCTIONS block so the wording stays consistent.
- The four priorities, default `medium`.
- The id format `<KEY>-<N>`, generated server-side.
- The rule that all writes go through the API: `POST /api/projects/tasks` to create, `PUT /api/projects/tasks/:taskId` to update, both with `projectPath` in the body. Hand-editing is the fallback only when the server cannot be started.

- [ ] **Step 2: Write `references/pipeline.md`**

Port these sections from `agents/pm.md` verbatim in substance, rewritten to address the skill rather than an agent persona:
- **Fluxo A** (spec): `backlog` → dispatch `meridian:spec-generator` → `specreview` → dispatch `meridian:spec-reviewer` → `APPROVED` moves to `readytodo` and clears `last_review_findings`; `NEEDS_REVISION` increments `spec_iterations` and redispatches the generator with findings only.
- **Fluxo B** (build): `readytodo` → `inprogress` → dispatch `meridian:developer` → `codereview` → dispatch `meridian:code-reviewer` → `qareview` → dispatch `meridian:qa` → on approval `git add` + `git commit -m "<id>: <title>"`, move to `done`.
- **Iteration cap**: 5. Before any redispatch, if the count exceeds 5 **or** the blocking findings are substantively identical to the previous round, set `blocked` with justification `"Blocked after N iterations — see last_review_findings. Needs human input."`
- **Specialist failure is not a revision round**: if a dispatched agent fails outright rather than returning `NEEDS_REVISION`, set `blocked`, record the failure in `justification`, stop, and do not consume an iteration.
- **Unblocking**: when a task reaches `done`, scan `blocked` tasks; any whose `blockedBy` ids are all `done` moves to `backlog`.
- **Context discipline**: retain only each specialist's verdict and blocking findings; discard the full report after acting on it.
- **`running`**: set `true` before dispatching a specialist, `false` when it returns — through the API, on every transition.

- [ ] **Step 3: Write `references/preamble.md`**

The shared opening every skill performs:

1. **Resolve the project.** Look for `./.meridian/` in the current working directory only. Do not walk up.
2. **If absent**, ask the operator whether to register this directory with Meridian. On yes, read the repository to infer `name`, `stack` and `description`, then `POST /api/projects` with `{ name, path, stack, description }` — the server registers the path, creates `.meridian/`, writes `project-info.json` and derives the task `key`. Creating it complete avoids the card appearing with three "missing" badges. Then offer — do not force — to generate `AGENTS.md` if absent. On no, stop.
3. **Ensure the server.** Probe `http://localhost:3333/api/status`. If unreachable, run `node <meridian>/cli.js start` and wait for it to answer. If it still cannot start, say so and fall back to reading `tasks.json` directly — but never *write* by hand without telling the operator the server is down.

- [ ] **Step 4: Verify the references resolve**

```bash
ls plugin/plugins/meridian/references/
grep -rn "CLAUDE_PLUGIN_ROOT" plugin/plugins/meridian/ || echo "no references yet — expected until Task 4"
```

Expected: three files present.

- [ ] **Step 5: Commit**

```bash
git add plugin/plugins/meridian/references/
git commit -m "feat: shared references for schema, pipeline and skill preamble"
```

---

### Task 3: The six agents, with `pm` redefined

**Files:**
- Create: `plugin/plugins/meridian/agents/{pm,developer,qa,code-reviewer,spec-generator,spec-reviewer}.md`

**Interfaces:**
- Consumes: the existing `agents/*.md` bodies; `references/schema.md` from Task 2.
- Produces: six agents addressable as `meridian:pm`, `meridian:developer`, `meridian:qa`, `meridian:code-reviewer`, `meridian:spec-generator`, `meridian:spec-reviewer`. Task 6's `work` skill dispatches five of them by these exact names.

- [ ] **Step 1: Port the five specialists**

Copy `agents/developer.md`, `agents/qa.md`, `agents/code-reviewer.md`, `agents/spec-generator.md`, `agents/spec-reviewer.md` into the plugin's `agents/`, each with frontmatter:

```markdown
---
name: developer
description: Implements exactly one Meridian task from its spec, TDD, staging changes without committing.
tools: Read, Write, Edit, Bash, Grep, Glob
---
```

Keep each body as-is except: point every mention of the task schema at `${CLAUDE_PLUGIN_ROOT}/references/schema.md` instead of restating it, and drop any instruction to hand-edit `tasks.json` — the specialists never write task state; the `work` skill does, through the API.

- [ ] **Step 2: Write the redefined `pm`**

`agents/pm.md` in the plugin is **not** the old orchestrator. Its charter, per spec decision D3:

```markdown
---
name: pm
description: Plans and curates a Meridian backlog - decomposes a plan or feature into well-formed tasks with dependencies and expected results, and audits an existing board for gaps. Never dispatches agents and never writes production code.
tools: Read, Write, Edit, Bash, Grep, Glob
---
```

Body covers exactly two jobs:
- **Decomposition** — given `docs/plans/implementation-plan.md` or a feature description, produce PR-sized tasks with `blockedBy` wired from stated dependencies and `expected_results` written for each. Tasks with no unmet dependency start in `backlog`; the rest start in `blocked` with `justification: "Blocked on <id>"`. Create them through `POST /api/projects/tasks`.
- **Curation** — sweep the board and report tasks missing `expected_results`, dependencies pointing at ids that do not exist, and `blocked` tasks with an empty `blockedBy`. Report; fix only what the operator approves.

State explicitly that it never dispatches subagents and never writes production code, and that the reason `expected_results` is mandatory is that `meridian:qa` receives only those.

- [ ] **Step 3: Verify frontmatter parses on all six**

```bash
for f in plugin/plugins/meridian/agents/*.md; do
  echo "--- $f"; head -6 "$f" | grep -E "^(name|description|tools):" || echo "MISSING FRONTMATTER"
done
```

Expected: `name`, `description` and `tools` on each of the six.

- [ ] **Step 4: Reinstall and confirm the agents register**

```bash
claude plugin marketplace update meridian && claude plugin install meridian@meridian
```

Then confirm the six appear as `meridian:*` agent types. If the commands are refused, hand them to the operator.

- [ ] **Step 5: Commit**

```bash
git add plugin/plugins/meridian/agents/
git commit -m "feat: six plugin agents, with pm redefined as planner and curator"
```

---

### Task 4: Skill `new`

The smallest skill — build it first to shake out the preamble.

**Files:**
- Create: `plugin/plugins/meridian/skills/new/SKILL.md`

**Interfaces:**
- Consumes: `references/preamble.md`, `references/schema.md`.
- Produces: the invocation `meridian:new "<title>"`.

- [ ] **Step 1: Write the skill**

Frontmatter:

```markdown
---
name: new
description: Use when the operator wants to add a task to the current project's Meridian backlog - creates it through the API with expected results.
---
```

Body:
1. Perform the shared preamble at `${CLAUDE_PLUGIN_ROOT}/references/preamble.md`.
2. Take the title from the invocation argument; ask for it if absent.
3. **Require `expected_results`.** Ask the operator for concrete, mechanically verifiable outcomes if they were not supplied. State the reason when asking: `meridian:qa` receives only `expected_results`, so a task without them produces a weak spec and a blind QA.
4. Accept an optional `priority`; default `medium`. Reject anything outside the four values before calling the API.
5. `POST /api/projects/tasks` with `{ projectPath, title, expected_results, priority }`. The server generates the id and stamps the dates — never compute either.
6. Report the created id, title and status.

- [ ] **Step 2: Behavioral verification against a throwaway project**

```bash
mkdir -p /tmp/meridian-verify/skilltest && cd /tmp/meridian-verify/skilltest
```

Register it through the API, invoke `meridian:new "Verify the new skill"` with an expected result, then assert:

```bash
curl -s "localhost:3333/api/status?project=/tmp/meridian-verify/skilltest" | python3 -c "
import json,sys
t=json.load(sys.stdin)['projects'][0]['tasks'][0]
assert t['status']=='backlog', t['status']
assert t['priority']=='medium', t['priority']
assert t['expected_results'], 'expected_results empty'
assert t['created_at'] and t['moved_at'], 'not stamped'
print('OK', t['id'], t['title'])"
```

Expected: `OK <KEY>-1 Verify the new skill`. Then remove the project from the registry and delete `/tmp/meridian-verify/skilltest`.

- [ ] **Step 3: Commit**

```bash
git add plugin/plugins/meridian/skills/new/
git commit -m "feat: meridian:new skill"
```

---

### Task 5: Skill `status`

Replaces the Task 1 placeholder.

**Files:**
- Modify: `plugin/plugins/meridian/skills/status/SKILL.md`

**Interfaces:**
- Consumes: `references/preamble.md`, `references/schema.md`; `GET /api/status?project=&limit=`.
- Produces: the invocation `meridian:status`, and the hand-off into `work` that Task 6 relies on.

- [ ] **Step 1: Write the skill**

Frontmatter description: `Use when the operator asks for the Meridian board state of the current project - lists the top tasks per status and surfaces interrupted work.`

Body:
1. Shared preamble.
2. `GET /api/status?project=<cwd>&limit=5`. Format the returned JSON as a compact table grouped by status. Do not read `tasks.json` directly — the API already applies the ordering and the `priority` default.
3. **Consistency line.** Report any `blocked` task whose `blockedBy` ids are all `done`. State plainly when there are none.
4. **Interrupted tasks.** Report every task with status `inprogress` **or** `running: true`. Explain the reasoning in the skill text so a future reader understands it: the skill runs in a fresh session, so no agent from a previous session is alive; either flag therefore means work was abandoned mid-flight. Check both independently — `running: true` legitimately occurs in `backlog`, `specreview`, `codereview` and `qareview` during a live run, so it is not exclusive to `inprogress`.
5. If any interrupted task exists, **ask the operator** whether to resume one. On yes, enter the `work` flow for that id, and when it dispatches `meridian:developer` include a resumption briefing: the stage it stopped at, the open round's `last_review_findings`, and an instruction to establish actual state with `git status` and `git diff` **before writing anything**, because the working tree may hold partial work.

- [ ] **Step 2: Behavioral verification**

Invoke `meridian:status` in `~/workspace/project_a` (47 tasks, 36 done, 7 blocked, one task with `running: true`). Assert the output caps each status at five, names the running task, and reports the consistency line. Read-only — this must not write anything.

- [ ] **Step 3: Commit**

```bash
git add plugin/plugins/meridian/skills/status/
git commit -m "feat: meridian:status skill"
```

---

### Task 6: Skill `work`

The heaviest skill.

**Files:**
- Create: `plugin/plugins/meridian/skills/work/SKILL.md`

**Interfaces:**
- Consumes: `references/preamble.md`, `references/pipeline.md`, `references/schema.md`; the five specialist agents from Task 3.
- Produces: the invocation `meridian:work <TASKID>`, which Task 7's `next` chains into.

- [ ] **Step 1: Write the skill**

Frontmatter description: `Use when the operator wants to start or resume work on a specific Meridian task - drives it through the pipeline until done or blocked.`

Body:
1. Shared preamble, then load `${CLAUDE_PLUGIN_ROOT}/references/pipeline.md` — it holds the flow rules, the cap and the commit rule.
2. Fetch the task. Enter at the stage its status indicates:

| Status | Action |
|---|---|
| `backlog` | Fluxo A step 1 — dispatch `meridian:spec-generator` |
| `specreview` | Fluxo A step 2 — dispatch `meridian:spec-reviewer` |
| `readytodo` | Fluxo B step 1 — dispatch `meridian:developer` |
| `inprogress` | dispatch `meridian:developer` **with the resumption briefing** |
| `codereview` | dispatch `meridian:code-reviewer` |
| `qareview` | dispatch `meridian:qa` |
| `blocked` | do not start; report `justification` and `blockedBy` |
| `done`, `nope` | refuse; reopening is an explicit operator action, and it clears `completed_at` |

3. A task flows through consecutive stages in one invocation — a `backlog` task runs Fluxo A and continues into Fluxo B without a second call.
4. Resumption context matters **only** for `inprogress`. A review is never half-done; `codereview` and `qareview` simply run their agent.
5. If `tasks.json` is empty, dispatch `meridian:pm` to decompose a plan into tasks first.
6. Every transition through `PUT /api/projects/tasks/:taskId`, including `running` true/false around each dispatch.

- [ ] **Step 2: Behavioral verification on a throwaway project**

Create a scratch project with one `readytodo` task whose `expected_results` is something trivially checkable (for example, "a file `hello.txt` exists containing `hello`"). Invoke `meridian:work` on it and assert afterwards through the API that the task reached `done`, that `completed_at` is set, and that a commit exists. Then delete the scratch project and deregister it.

- [ ] **Step 3: Verify the refusals**

Assert that invoking `work` on a `done` task refuses, and on a `blocked` task reports rather than starting. These are the two paths most likely to be implemented as "try anyway".

- [ ] **Step 4: Commit**

```bash
git add plugin/plugins/meridian/skills/work/
git commit -m "feat: meridian:work skill"
```

---

### Task 7: Skill `next`

**Files:**
- Create: `plugin/plugins/meridian/skills/next/SKILL.md`

**Interfaces:**
- Consumes: `references/preamble.md`; `GET /api/status?project=`; the `work` skill from Task 6.
- Produces: the invocation `meridian:next`.

- [ ] **Step 1: Write the skill**

Frontmatter description: `Use when the operator does not know which Meridian task to pick up next - selects the task closest to done and hands it to work.`

Body:
1. Shared preamble.
2. Select right-to-left along the pipeline — closest to finished first:

```
qareview → codereview → inprogress → readytodo → specreview → backlog
```

`blocked`, `done` and `nope` are skipped entirely.

3. Ordering is three-level: **stage first, then priority, then oldest `created_at`.** Priority breaks ties *within* a stage and never crosses stages — a `critical` in `backlog` must not jump ahead of a `high` in `qareview`, because that defeats the point of finishing work already in flight. State this reasoning in the skill so it is not "simplified" later.
4. Report the chosen task and why it was chosen, then hand it to `work`.
5. If every status is empty, say so and suggest `meridian:new` or `meridian:pm`.

- [ ] **Step 2: Behavioral verification**

On a scratch project seeded with tasks across `backlog` (one `critical`) and `qareview` (one `low`), assert `next` picks the `qareview` task — the case that proves priority does not cross stages.

- [ ] **Step 3: Commit**

```bash
git add plugin/plugins/meridian/skills/next/
git commit -m "feat: meridian:next skill"
```

---

### Task 8: Hide old `done` tasks on the board

**Files:**
- Create: `lib/board.js`
- Create: `test/board.test.js`
- Modify: `public/app.js` (`renderKanbanBoard` around line 842, the `hideEmptyColumns` block around line 849)
- Modify: `public/index.html:56-63` (the `kanban-header` block)

**Interfaces:**
- Consumes: `completed_at`, stamped by Phase 1.
- Produces: `isRecentlyCompleted(task, windowDays, now) => boolean`, exported from `lib/board.js` and duplicated as an inline function in `public/app.js` (the frontend has no module system and no build step; the shared file exists so the rule is unit-tested, and `app.js` carries a comment naming `lib/board.js` as its source of truth).

- [ ] **Step 1: Write the failing test**

Create `test/board.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isRecentlyCompleted } = require('../lib/board');

const NOW = new Date('2026-08-27T12:00:00.000Z');

test('a task completed today is recent', () => {
    assert.equal(isRecentlyCompleted({ completed_at: '2026-08-27T09:00:00.000Z' }, 7, NOW), true);
});

test('a task completed inside the window is recent', () => {
    assert.equal(isRecentlyCompleted({ completed_at: '2026-08-22T12:00:00.000Z' }, 7, NOW), true);
});

test('a task completed outside the window is not', () => {
    assert.equal(isRecentlyCompleted({ completed_at: '2026-08-01T12:00:00.000Z' }, 7, NOW), false);
});

test('a null completed_at counts as old', () => {
    assert.equal(isRecentlyCompleted({ completed_at: null }, 7, NOW), false);
});

test('a missing completed_at counts as old', () => {
    assert.equal(isRecentlyCompleted({}, 7, NOW), false);
});

test('an unparseable completed_at counts as old rather than throwing', () => {
    assert.equal(isRecentlyCompleted({ completed_at: 'not a date' }, 7, NOW), false);
});

test('a null window means show everything', () => {
    assert.equal(isRecentlyCompleted({ completed_at: '2020-01-01T00:00:00.000Z' }, null, NOW), true);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/board'`.

- [ ] **Step 3: Implement**

Create `lib/board.js`:

```js
'use strict';

// The done-column window rule. public/app.js carries an inline copy of this
// function: the frontend has no module system and no build step, so the rule
// cannot be imported there. This file is the source of truth — change both.
function isRecentlyCompleted(task, windowDays, now = new Date()) {
    if (windowDays === null || windowDays === undefined) return true;
    const raw = task && task.completed_at;
    if (!raw) return false;
    const completed = new Date(raw);
    if (Number.isNaN(completed.getTime())) return false;
    return (now.getTime() - completed.getTime()) <= windowDays * 24 * 60 * 60 * 1000;
}

module.exports = { isRecentlyCompleted };
```

- [ ] **Step 4: Run the test again**

Run: `npm test`
Expected: PASS, 58 tests.

- [ ] **Step 5: Add the selector to the board markup**

In `public/index.html`, inside the `<div style="display: flex; align-items: center; gap: 1.2rem;">` that already holds the `Hide Empty Columns` label (lines 57-63), add a sibling label with the same styling, containing:

```html
<select id="done-window" style="cursor: pointer; background: transparent; color: var(--text-secondary); border: none; outline: none;">
    <option value="1">24h</option>
    <option value="7">7 days</option>
    <option value="30">30 days</option>
    <option value="">All</option>
</select>
```

with the text `Done shown:` before it.

- [ ] **Step 6: Wire it in `public/app.js`**

Mirror the `hideEmptyColumns` pattern exactly (declaration near line 31, wiring near line 849):

- `let doneWindowDays = (() => { const v = localStorage.getItem('meridian_done_window'); return v === '' ? null : (v === null ? 7 : Number(v)); })();`
- In `renderKanbanBoard`, set the select's value from `doneWindowDays` and give it an `onchange` that writes `localStorage.setItem('meridian_done_window', e.target.value)` and calls `refreshProjectView()`.
- Add the inline copy of `isRecentlyCompleted` with a comment pointing at `lib/board.js`.
- In the `KANBAN_STATUSES.forEach` loop, for `statusCol.id === 'done'` only, split `colTasks` into visible and hidden by the predicate, render the visible ones, and set the column count to the visible length.
- Below the visible cards in the `done` column, when hidden tasks exist, render a chip reading `+N concluídas` that on click reveals the rest **for this render only** — do not change the stored preference.
- Leave `sortColumnTasks` alone; the `done` branch now sorts by `completed_at` descending because Phase 1 populates it.

- [ ] **Step 7: Verify in the browser**

Start the server on 3399, load the board, and confirm against `project_a` (36 `done` tasks, 36 stamped): the default 7-day window shows only recently completed cards, the `+N concluídas` chip reports the remainder, switching the selector to `All` shows all 36, the choice survives a reload, and the other eight columns are untouched. Take a screenshot for the report. Stop the server.

- [ ] **Step 8: Commit**

```bash
git add lib/board.js test/board.test.js public/app.js public/index.html
git commit -m "feat: hide old done tasks behind a configurable window"
```

---

### Task 9: The two deferred findings

Carried from Phase 1's final review: I3 and I6.

**Files:**
- Modify: `server.js` (`getStatusData`'s project filter)
- Modify: `test/api-tasks.test.js` (the `withServer` harness and a new I3 test)

**Interfaces:**
- Consumes: `getStatusData(options)` from Phase 1.
- Produces: an error entry when `?project=` matches nothing; a harness that fails loudly when its server does not start.

- [ ] **Step 1: Write the failing test for I3**

Append to `test/api-tasks.test.js`:

```js
test('GET /api/status?project= reports an error when nothing matches', async () => {
    const { ws } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const res = await (await fetch(`${base}/api/status?project=/nope/not/here`)).json();
        assert.equal(res.projects.length, 0);
        assert.equal(res.errors.length, 1);
        assert.match(res.errors[0].message, /not registered|no project/i);
    });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test`
Expected: FAIL — `errors.length` is 0.

- [ ] **Step 3: Implement I3**

In `getStatusData`, track whether `options.project` matched any registry entry. After the loop, when `options.project` was given and nothing matched, push an error naming the path — for example `Project not registered with Meridian: <path>`. A skill passing `cwd` can then tell "not registered" from "registered but empty", which today are identical.

Leave symlink resolution alone: `path.resolve` on both sides stays as-is. Out of scope.

- [ ] **Step 4: Fix I6 — the harness fails loudly**

In `withServer`, replace the silent fall-through after the readiness loop: when the server has not answered after the retries, throw an error naming the port and the elapsed time. Capture the child's stderr rather than discarding it with `stdio: 'ignore'`, and include it in that error. This is what turned one real startup delay into an opaque `ECONNREFUSED` inside an assertion during Phase 1.

Leave the random port selection as it is unless the throw proves insufficient — a loud failure is the fix that matters.

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: PASS. Run it three times in a row and confirm a stable count each time.

- [ ] **Step 6: Commit**

```bash
git add server.js test/api-tasks.test.js
git commit -m "fix: report unmatched project filter, and fail loudly when a test server does not start"
```

---

### Task 10: Retire the copied agent files

Only after every skill is proven. This deletes 36 files across six projects that the plugin now supersedes.

**Files:**
- Delete: `agents/pm.md`, `agents/developer.md`, `agents/qa.md`, `agents/code-reviewer.md`, `agents/spec-generator.md`, `agents/spec-reviewer.md` — the six superseded by the plugin. **`agents/Odin.md` stays**: it is workspace-level, the spec puts it out of scope, and `meridian_sync` still copies it to `../.agents/orchestrator/AGENT.md`.
- Delete: `.claude/agents/meridian-*.md`, `.agents/agents/meridian-*.md` in this repo and in the five other projects
- Modify: `server.js` (the agent-sync machinery that writes those copies)

**Interfaces:**
- Consumes: a working, installed plugin.
- Produces: one source of truth for agent definitions.

- [ ] **Step 1: Confirm the plugin is genuinely in use**

```bash
claude plugin list | grep meridian
ls plugin/plugins/meridian/agents/ plugin/plugins/meridian/skills/
```

Do not proceed unless the plugin is installed and all four skills plus six agents are present. If it is not, stop and report — deleting the copies before the replacement works would leave the six projects with no agents at all.

- [ ] **Step 2: Inventory what is about to go**

```bash
cd ~/workspace && find . -name "meridian-*.md" -not -path "*/node_modules/*" | sort | tee /tmp/meridian-agent-copies.txt | wc -l
```

Expected: 36 files across six projects. Keep the list — it is the record of what was removed.

- [ ] **Step 3: Delete the copies**

```bash
cd ~/workspace && xargs rm -f < /tmp/meridian-agent-copies.txt
find . -name "meridian-*.md" -not -path "*/node_modules/*" | wc -l
```

Expected: 0.

- [ ] **Step 4: Retire the sync machinery**

`server.js` generates and compares those copies — the `missingClaudeAgents` / `outdatedClaudeAgents` / `missingAgyAgents` / `outdatedAgyAgents` health signals and the code that writes them. With one plugin source, those signals are false alarms. Remove the generation and the four fields, and remove their badges from `public/app.js` and `public/index.html`. Leave `missingAgentsMd`, `missingStack`, `missingDescription` and the MERIDIAN_INSTRUCTIONS drift check alone — those still mean something.

- [ ] **Step 5: Delete the six superseded agent sources**

```bash
cd ~/workspace/meridian
git rm agents/pm.md agents/developer.md agents/qa.md agents/code-reviewer.md agents/spec-generator.md agents/spec-reviewer.md
ls agents/
```

Expected: `Odin.md` and nothing else. `pm.md`'s orchestration content now lives in `references/pipeline.md` and its bootstrap in the plugin's `pm` agent; the five specialists are in the plugin. Odin stays — `meridian_sync` still copies it to the workspace's orchestrator directory.

- [ ] **Step 6: Verify the dashboard**

Start the server on 3399, load the board, confirm all six projects render with no agent-related warning badges and no errors in `/api/status`. Stop the server.

- [ ] **Step 7: Run the suite and commit**

```bash
npm test
git add -A
git commit -m "chore: retire the copied agent files in favour of the plugin"
```

---

## Self-review notes

- Task 8 deliberately duplicates `isRecentlyCompleted` between `lib/board.js` and `public/app.js`. This is the one place the plan accepts duplication: the frontend has no module system, no bundler and no build step, and adding one to share seven lines would violate the no-new-dependencies constraint. Both copies carry a comment naming the other.
- Task 10 is the only destructive task. Its Step 1 gate exists because deleting the copies before the plugin works would leave six projects with no agents.
- The four skills have no automated tests, by nature. Their verification steps are behavioral runs against throwaway projects with API assertions — real, but slower and less repeatable than Phase 1's suite. Do not let an implementer substitute "the file exists" for those runs.
- Tasks 2, 3, 5, 6 and 7 specify their Markdown deliverables as **enumerated requirements** rather than verbatim text, which departs from this plan format's usual "show the code, don't describe it" rule. That is deliberate: the deliverable *is* prose, and transcribing four complete skills and six agent bodies into the plan would double its length while adding nothing an implementer could not write from the requirements. Everything mechanically load-bearing — frontmatter, agent names, status transitions, the ordering rules, the API calls — is given verbatim. A reviewer should hold those exact strings to the letter and judge the surrounding prose on whether it carries the stated requirement.

## Out of Scope

- `?project=` symlink resolution (`fs.realpathSync`), explicitly left in Task 9.
- The residual Minors parked in Phase 1: the `parsed.tasks === undefined` hole in `lib/tasks.js`, POST validating a `status` it then discards, `fsync` on the atomic write, and stale `.tmp` sweeping.
- `agents/Odin.md` and the `meridian_sync` script.
- The orphaned `project_d/tasks.json` in the legacy root location.
- Any Meridian server authentication or listen-address change.
