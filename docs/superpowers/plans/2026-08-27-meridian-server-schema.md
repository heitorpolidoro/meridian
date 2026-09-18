# Meridian Server & Schema — Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Meridian server the single write path for tasks — extracting the data layer into a tested module, converting `tasks.json` to a bare array, and adding the timestamp fields the board filter and the skills depend on.

**Architecture:** The task data layer moves out of `server.js` into `lib/tasks.js` so it can be unit-tested without HTTP. All timestamp rules live in two small stamping functions used by both `POST` and `PUT`, so skills, agents, and dashboard drags produce identical results. Schema migration rides the read/write funnel — no migration script.

**Tech Stack:** Node.js 24 (CommonJS), Express 5, `node --test` (built-in runner, no new dependencies), `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-08-27-meridian-skills-design.md`

## Global Constraints

- No new runtime dependencies. `express` stays the only entry in `dependencies`.
- Test runner is Node's built-in `node --test`. Do not add jest, vitest, or mocha.
- CommonJS (`require`/`module.exports`) — `package.json` declares `"type": "commonjs"`.
- Status values are exactly these nine, lowercase: `backlog`, `specreview`, `readytodo`, `inprogress`, `codereview`, `qareview`, `blocked`, `done`, `nope`.
- Priority values are exactly these four, lowercase: `critical`, `high`, `medium`, `low`. Default `medium`. A task with no `priority` field reads as `medium`.
- Timestamps are ISO-8601 via `new Date().toISOString()`.
- Never delete a task. Hiding is a view concern handled in Phase 2.
- Tests write only to `os.tmpdir()`. Never touch the six real projects.

## File Structure

| File | Responsibility |
|---|---|
| `lib/tasks.js` (create) | Task data layer: key derivation, id generation, read/write of `tasks.json`, timestamp stamping. No Express, no HTTP. |
| `test/tasks.test.js` (create) | Unit tests for `lib/tasks.js`. |
| `server.js` (modify) | Express routes only. Requires the data layer instead of defining it. |
| `agents/Odin.md` (modify) | Drop the `lastUpdated` field and the rule to maintain it. |
| `package.json` (modify) | Real `test` script. |

`server.js` is 35.7 KB and holds routes, aggregation, SSE, AI-fix spawning, and the data layer in one file. This plan extracts only the data layer — the part every task below touches — and leaves the rest alone.

---

### Task 1: Test harness and the `deriveKey` bug

`deriveKey` throws on any multi-word project name, which breaks `POST /api/projects` — the endpoint the new onboarding flow depends on. Fixing it first gives the test harness its first real test.

**Files:**
- Create: `test/tasks.test.js`
- Create: `lib/tasks.js`
- Modify: `package.json:9` (the `scripts.test` line)
- Modify: `server.js:26-32` (remove `deriveKey`), `server.js:1-10` (add require)

**Interfaces:**
- Consumes: nothing.
- Produces: `deriveKey(name: string) => string`, exported from `lib/tasks.js`.

- [ ] **Step 1: Write the failing test**

Create `test/tasks.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deriveKey } = require('../lib/tasks');

test('deriveKey: single word takes the first five letters', () => {
    assert.equal(deriveKey('Meridian'), 'MERID');
});

test('deriveKey: multi-word takes the initials', () => {
    assert.equal(deriveKey('Audio Transcriber'), 'AT');
    assert.equal(deriveKey('Repertoire Hero'), 'RH');
});

test('deriveKey: underscores and hyphens split like spaces', () => {
    assert.equal(deriveKey('project_d'), 'PD');
    assert.equal(deriveKey('audit-processor'), 'AP');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/`
Expected: FAIL — `Cannot find module '../lib/tasks'`.

- [ ] **Step 3: Create the module with the fixed function**

Create `lib/tasks.js`:

```js
'use strict';

function deriveKey(name) {
    const words = name.trim().split(/[\s_\-]+/).filter(Boolean);
    if (words.length === 1) {
        return words[0].substring(0, 5).toUpperCase();
    }
    return words.map(w => w[0]).join('').toUpperCase();
}

module.exports = { deriveKey };
```

The fix is the order of `.join('')` and `.toUpperCase()`: the original called `.toUpperCase()` on the array returned by `.map()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/`
Expected: PASS, 3 tests.

- [ ] **Step 5: Wire the test script**

In `package.json`, replace the `test` line:

```json
    "test": "node --test test/",
```

- [ ] **Step 6: Point `server.js` at the module**

Delete `function deriveKey` (`server.js:26-32`). Add to the requires at the top of `server.js`:

```js
const { deriveKey } = require('./lib/tasks');
```

- [ ] **Step 7: Verify the server still boots**

Run: `PORT=3399 node server.js`
Expected: prints `Meridian Dashboard running on http://localhost:3399`. Stop it with Ctrl-C.

- [ ] **Step 8: Commit**

```bash
git add lib/tasks.js test/tasks.test.js package.json server.js
git commit -m "fix: deriveKey crashed on multi-word names; add test harness"
```

---

### Task 2: Move `nextTaskId` into the data layer

**Files:**
- Modify: `lib/tasks.js`
- Modify: `test/tasks.test.js`
- Modify: `server.js:34-44` (remove `nextTaskId`), require line

**Interfaces:**
- Consumes: `deriveKey` from Task 1.
- Produces: `nextTaskId(tasks: Array<{id?: string}>, key: string) => string`.

- [ ] **Step 1: Write the failing test**

Append to `test/tasks.test.js`:

```js
const { nextTaskId } = require('../lib/tasks');

test('nextTaskId: first task of a project', () => {
    assert.equal(nextTaskId([], 'MERID'), 'MERID-1');
});

test('nextTaskId: continues from the highest existing number', () => {
    const tasks = [{ id: 'MERID-1' }, { id: 'MERID-7' }, { id: 'MERID-3' }];
    assert.equal(nextTaskId(tasks, 'MERID'), 'MERID-8');
});

test('nextTaskId: ignores ids from other keys and malformed ids', () => {
    const tasks = [{ id: 'AEQUI-99' }, { id: 'MERID-2' }, { id: 'MERID-x' }, {}];
    assert.equal(nextTaskId(tasks, 'MERID'), 'MERID-3');
});
```

Update the require at the top of the test file to `const { deriveKey, nextTaskId } = require('../lib/tasks');` and remove the duplicate require line.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/`
Expected: FAIL — `nextTaskId is not a function`.

- [ ] **Step 3: Move the function**

Cut `nextTaskId` from `server.js:34-44` and paste it into `lib/tasks.js` unchanged. Add it to the exports:

```js
module.exports = { deriveKey, nextTaskId };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/`
Expected: PASS, 6 tests.

- [ ] **Step 5: Update the server require**

```js
const { deriveKey, nextTaskId } = require('./lib/tasks');
```

- [ ] **Step 6: Commit**

```bash
git add lib/tasks.js test/tasks.test.js server.js
git commit -m "refactor: move nextTaskId into lib/tasks"
```

---

### Task 3: Move `getTasks` / `saveTasks`, pinning current behavior

A pure move first, so the behavior change in Task 4 has passing tests to break.

**Files:**
- Modify: `lib/tasks.js`
- Modify: `test/tasks.test.js`
- Modify: `server.js:433-456` (remove both functions), require line

**Interfaces:**
- Consumes: nothing new.
- Produces: `getTasks(projPath: string) => { tasks: Array<Object> }` and `saveTasks(projPath: string, tasksData: { tasks: Array<Object> }) => void`.

Note the return shape drops `lastUpdated`: callers in `server.js` only ever read `.tasks`, except the aggregation line removed in Task 9.

- [ ] **Step 1: Write the failing test**

Append to `test/tasks.test.js`:

```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getTasks, saveTasks } = require('../lib/tasks');

function tmpProject(contents) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-test-'));
    fs.mkdirSync(path.join(dir, '.meridian'), { recursive: true });
    if (contents !== undefined) {
        fs.writeFileSync(
            path.join(dir, '.meridian', 'tasks.json'),
            JSON.stringify(contents, null, 2)
        );
    }
    return dir;
}

test('getTasks: reads the wrapped object shape', () => {
    const dir = tmpProject({ lastUpdated: '2026-01-01T00:00:00.000Z', tasks: [{ id: 'A-1' }] });
    assert.deepEqual(getTasks(dir).tasks, [{ id: 'A-1' }]);
});

test('getTasks: reads the bare array shape', () => {
    const dir = tmpProject([{ id: 'A-1' }]);
    assert.deepEqual(getTasks(dir).tasks, [{ id: 'A-1' }]);
});

test('getTasks: missing file yields an empty list', () => {
    const dir = tmpProject(undefined);
    assert.deepEqual(getTasks(dir).tasks, []);
});

test('getTasks: malformed JSON yields an empty list instead of throwing', () => {
    const dir = tmpProject(undefined);
    fs.writeFileSync(path.join(dir, '.meridian', 'tasks.json'), '{not json');
    assert.deepEqual(getTasks(dir).tasks, []);
});

test('saveTasks: creates .meridian when absent and round-trips', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-test-'));
    saveTasks(dir, { tasks: [{ id: 'A-1', title: 'x' }] });
    assert.deepEqual(getTasks(dir).tasks, [{ id: 'A-1', title: 'x' }]);
});
```

Fold the new requires into the existing require lines at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/`
Expected: FAIL — `getTasks is not a function`.

- [ ] **Step 3: Move the functions**

Cut `getTasks` and `saveTasks` from `server.js:433-456` into `lib/tasks.js`. Add `const fs = require('node:fs');` and `const path = require('node:path');` at the top of `lib/tasks.js`. Change `getTasks`'s three return sites from `{ lastUpdated: null, tasks: ... }` to `{ tasks: ... }`, and its object-shape return from `return parsed;` to `return { tasks: parsed.tasks || [] };`. Leave `saveTasks` otherwise unchanged for now — it still writes the wrapper and still stamps `lastUpdated`.

Export both:

```js
module.exports = { deriveKey, nextTaskId, getTasks, saveTasks };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/`
Expected: PASS, 11 tests.

- [ ] **Step 5: Update the server require and verify boot**

```js
const { deriveKey, nextTaskId, getTasks, saveTasks } = require('./lib/tasks');
```

Run: `PORT=3399 node server.js`, then in another shell `curl -s localhost:3399/api/status | head -c 200`.
Expected: JSON containing `"projects"`. Stop the server.

- [ ] **Step 6: Commit**

```bash
git add lib/tasks.js test/tasks.test.js server.js
git commit -m "refactor: move task read/write into lib/tasks"
```

---

### Task 4: Write a bare array and backfill `completed_at`

**Files:**
- Modify: `lib/tasks.js`
- Modify: `test/tasks.test.js`

**Interfaces:**
- Consumes: `getTasks`, `saveTasks` from Task 3.
- Produces: same signatures; `saveTasks` now writes a JSON array, and `getTasks` fills `completed_at` from `updated_at` for `done` tasks that lack it.

- [ ] **Step 1: Write the failing test**

Append to `test/tasks.test.js`:

```js
test('saveTasks: writes a bare array with no lastUpdated wrapper', () => {
    const dir = tmpProject({ lastUpdated: 'old', tasks: [{ id: 'A-1' }] });
    saveTasks(dir, { tasks: [{ id: 'A-1' }] });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, '.meridian', 'tasks.json'), 'utf8'));
    assert.ok(Array.isArray(raw), 'file should be a bare array');
    assert.deepEqual(raw, [{ id: 'A-1' }]);
});

test('getTasks: backfills completed_at from updated_at for done tasks', () => {
    const dir = tmpProject([
        { id: 'A-1', status: 'done', updated_at: '2026-08-13T00:00:00.000Z' }
    ]);
    assert.equal(getTasks(dir).tasks[0].completed_at, '2026-08-13T00:00:00.000Z');
});

test('getTasks: backfill leaves completed_at null when updated_at is absent', () => {
    const dir = tmpProject([{ id: 'A-1', status: 'done' }]);
    assert.equal(getTasks(dir).tasks[0].completed_at, null);
});

test('getTasks: backfill never overwrites an existing completed_at', () => {
    const dir = tmpProject([
        { id: 'A-1', status: 'done', updated_at: '2026-08-20T00:00:00.000Z', completed_at: '2026-08-01T00:00:00.000Z' }
    ]);
    assert.equal(getTasks(dir).tasks[0].completed_at, '2026-08-01T00:00:00.000Z');
});

test('getTasks: backfill does not touch tasks that are not done', () => {
    const dir = tmpProject([{ id: 'A-1', status: 'backlog', updated_at: '2026-08-13T00:00:00.000Z' }]);
    assert.equal('completed_at' in getTasks(dir).tasks[0], false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/`
Expected: FAIL — the file is still an object, and `completed_at` is `undefined`.

- [ ] **Step 3: Implement**

In `lib/tasks.js`, add the backfill helper and call it from `getTasks` before returning, in all three list-producing paths:

```js
function backfillCompletedAt(tasks) {
    for (const task of tasks) {
        if (task.status === 'done' && task.completed_at === undefined) {
            task.completed_at = task.updated_at || null;
        }
    }
    return tasks;
}
```

Wrap each `getTasks` return as `return { tasks: backfillCompletedAt(list) };`.

Replace the body of `saveTasks` so it writes the array and no longer stamps `lastUpdated`:

```js
function saveTasks(projPath, tasksData) {
    const localMeridianDir = path.join(projPath, '.meridian');
    if (!fs.existsSync(localMeridianDir)) {
        fs.mkdirSync(localMeridianDir, { recursive: true });
    }
    fs.writeFileSync(
        path.join(localMeridianDir, 'tasks.json'),
        JSON.stringify(tasksData.tasks, null, 2),
        'utf8'
    );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/tasks.js test/tasks.test.js
git commit -m "feat: bare-array tasks.json and completed_at backfill"
```

---

### Task 5: The stamping helpers

**Files:**
- Modify: `lib/tasks.js`
- Modify: `test/tasks.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `stampNewTask(task: Object) => Object` and `stampTaskUpdate(task: Object, prevStatus: string) => Object`. Both mutate and return the task.

- [ ] **Step 1: Write the failing test**

Append to `test/tasks.test.js`:

```js
const { stampNewTask, stampTaskUpdate } = require('../lib/tasks');

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test('stampNewTask: sets created_at, moved_at and updated_at', () => {
    const t = stampNewTask({ id: 'A-1', status: 'backlog' });
    assert.match(t.created_at, ISO);
    assert.equal(t.moved_at, t.created_at);
    assert.equal(t.updated_at, t.created_at);
});

test('stampTaskUpdate: a write without a status change touches only updated_at', () => {
    const t = stampTaskUpdate({ id: 'A-1', status: 'backlog', moved_at: 'earlier' }, 'backlog');
    assert.match(t.updated_at, ISO);
    assert.equal(t.moved_at, 'earlier');
    assert.equal('completed_at' in t, false);
});

test('stampTaskUpdate: a status change sets moved_at', () => {
    const t = stampTaskUpdate({ id: 'A-1', status: 'inprogress', moved_at: 'earlier' }, 'readytodo');
    assert.match(t.moved_at, ISO);
    assert.notEqual(t.moved_at, 'earlier');
});

test('stampTaskUpdate: entering done sets completed_at', () => {
    const t = stampTaskUpdate({ id: 'A-1', status: 'done' }, 'qareview');
    assert.match(t.completed_at, ISO);
    assert.equal(t.completed_at, t.moved_at);
});

test('stampTaskUpdate: leaving done clears completed_at', () => {
    const t = stampTaskUpdate({ id: 'A-1', status: 'inprogress', completed_at: '2026-08-01T00:00:00.000Z' }, 'done');
    assert.equal(t.completed_at, null);
});

test('stampTaskUpdate: done to done does not restamp completed_at', () => {
    const t = stampTaskUpdate({ id: 'A-1', status: 'done', completed_at: '2026-08-01T00:00:00.000Z' }, 'done');
    assert.equal(t.completed_at, '2026-08-01T00:00:00.000Z');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/`
Expected: FAIL — `stampNewTask is not a function`.

- [ ] **Step 3: Implement**

Add to `lib/tasks.js` and export both:

```js
function stampNewTask(task) {
    const now = new Date().toISOString();
    task.created_at = now;
    task.moved_at = now;
    task.updated_at = now;
    return task;
}

function stampTaskUpdate(task, prevStatus) {
    const now = new Date().toISOString();
    task.updated_at = now;
    if (task.status !== prevStatus) {
        task.moved_at = now;
        if (task.status === 'done') {
            task.completed_at = now;
        } else if (prevStatus === 'done') {
            task.completed_at = null;
        }
    }
    return task;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/`
Expected: PASS, 22 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/tasks.js test/tasks.test.js
git commit -m "feat: task timestamp stamping helpers"
```

---

### Task 6: Extend `POST /api/projects/tasks`

**Files:**
- Modify: `server.js:459-494`

**Interfaces:**
- Consumes: `nextTaskId`, `getTasks`, `saveTasks`, `stampNewTask`.
- Produces: `POST /api/projects/tasks` accepting `{ projectPath, title, blockedBy?, expected_results?, priority?, justification? }` and returning `201 { success: true, task }`.

- [ ] **Step 1: Write the failing test**

Create `test/api-tasks.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Builds an isolated fixture workspace: a registry at <ws>/.meridian/projects.json
// pointing at one project. The server is pointed here with MERIDIAN_RUNNING_DIR so
// the tests never see the six real projects.
function workspaceWith(name) {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-ws-'));
    const dir = path.join(ws, 'fixture-project');
    fs.mkdirSync(path.join(dir, '.meridian'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, '.meridian', 'project-info.json'),
        JSON.stringify({ name, key: 'TST', stack: [], description: 'x' })
    );
    fs.mkdirSync(path.join(ws, '.meridian'), { recursive: true });
    fs.writeFileSync(
        path.join(ws, '.meridian', 'projects.json'),
        JSON.stringify({ projects: [{ path: dir }] })
    );
    return { ws, dir };
}

async function withServer(ws, fn) {
    const port = 3400 + Math.floor(Math.random() * 500);
    const proc = require('node:child_process').spawn('node', ['server.js'], {
        env: { ...process.env, PORT: String(port), MERIDIAN_RUNNING_DIR: ws },
        cwd: path.join(__dirname, '..'),
        stdio: 'ignore'
    });
    try {
        for (let i = 0; i < 50; i++) {
            try { await fetch(`http://localhost:${port}/api/status`); break; }
            catch { await new Promise(r => setTimeout(r, 100)); }
        }
        await fn(`http://localhost:${port}`);
    } finally {
        proc.kill('SIGKILL');
    }
}

test('POST /api/projects/tasks stores the extended fields and stamps dates', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const res = await fetch(`${base}/api/projects/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                projectPath: dir,
                title: 'Add a thing',
                expected_results: ['The thing exists'],
                priority: 'high',
                justification: 'because'
            })
        });
        assert.equal(res.status, 201);
        const { task } = await res.json();
        assert.equal(task.id, 'TST-1');
        assert.equal(task.status, 'backlog');
        assert.equal(task.priority, 'high');
        assert.deepEqual(task.expected_results, ['The thing exists']);
        assert.equal(task.justification, 'because');
        assert.ok(task.created_at && task.moved_at && task.updated_at);
    });
});

test('POST /api/projects/tasks defaults priority to medium', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const res = await fetch(`${base}/api/projects/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: dir, title: 'No priority given' })
        });
        const { task } = await res.json();
        assert.equal(task.priority, 'medium');
        assert.deepEqual(task.expected_results, []);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/api-tasks.test.js`
Expected: FAIL — `task.priority` is `undefined`.

- [ ] **Step 3: Implement**

In `server.js`, change the destructure and the `newTask` literal in the `POST /api/projects/tasks` handler:

```js
const { projectPath, title, blockedBy, expected_results, priority, justification } = req.body;
```

```js
const newTask = stampNewTask({
    id: nextTaskId(tasksData.tasks, key),
    title,
    status: 'backlog',
    justification: justification || '',
    priority: priority || 'medium',
    expected_results: Array.isArray(expected_results) ? expected_results : [],
    running: false,
    blockedBy: Array.isArray(blockedBy) ? blockedBy : []
});
```

Add `stampNewTask` to the require from `./lib/tasks`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/`
Expected: PASS, 24 tests.

- [ ] **Step 5: Commit**

```bash
git add server.js test/api-tasks.test.js
git commit -m "feat: POST tasks accepts priority, expected_results, justification"
```

---

### Task 7: Extend `PUT /api/projects/tasks/:taskId`

**Files:**
- Modify: `server.js:498-527`
- Modify: `test/api-tasks.test.js`

**Interfaces:**
- Consumes: `getTasks`, `saveTasks`, `stampTaskUpdate`; the `project` and `withServer` helpers from Task 6.
- Produces: `PUT /api/projects/tasks/:taskId` accepting the full schema and returning `200 { success: true, task }`.

- [ ] **Step 1: Write the failing test**

Append to `test/api-tasks.test.js`:

```js
async function seed(base, dir, body) {
    const res = await fetch(`${base}/api/projects/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: dir, title: 'seed', ...body })
    });
    return (await res.json()).task;
}

async function put(base, dir, id, body) {
    const res = await fetch(`${base}/api/projects/tasks/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: dir, ...body })
    });
    return (await res.json()).task;
}

test('PUT accepts the pipeline fields', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        await seed(base, dir);
        const task = await put(base, dir, 'TST-1', {
            spec_path: 'docs/tasks/TST-1-spec.md',
            spec_iterations: 2,
            code_review_iterations: 1,
            qa_iterations: 0,
            last_review_findings: ['missing test'],
            expected_results: ['works'],
            priority: 'critical'
        });
        assert.equal(task.spec_path, 'docs/tasks/TST-1-spec.md');
        assert.equal(task.spec_iterations, 2);
        assert.equal(task.code_review_iterations, 1);
        assert.equal(task.qa_iterations, 0);
        assert.deepEqual(task.last_review_findings, ['missing test']);
        assert.equal(task.priority, 'critical');
    });
});

test('PUT stamps completed_at when the task enters done', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        await seed(base, dir);
        const task = await put(base, dir, 'TST-1', { status: 'done' });
        assert.ok(task.completed_at, 'completed_at should be set');
        assert.equal(task.completed_at, task.moved_at);
    });
});

test('PUT clears completed_at when the task leaves done', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        await seed(base, dir);
        await put(base, dir, 'TST-1', { status: 'done' });
        const task = await put(base, dir, 'TST-1', { status: 'inprogress' });
        assert.equal(task.completed_at, null);
    });
});

test('PUT without a status change leaves moved_at alone', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const seeded = await seed(base, dir);
        const task = await put(base, dir, 'TST-1', { title: 'renamed' });
        assert.equal(task.title, 'renamed');
        assert.equal(task.moved_at, seeded.moved_at);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/api-tasks.test.js`
Expected: FAIL — `spec_path` is `undefined` and `completed_at` is never set.

- [ ] **Step 3: Implement**

Replace the body of the `PUT` handler between reading `tasksData` and calling `saveTasks`:

```js
const task = tasksData.tasks[taskIndex];
const prevStatus = task.status;

const scalarFields = [
    'status', 'justification', 'title', 'priority', 'spec_path',
    'spec_iterations', 'code_review_iterations', 'qa_iterations'
];
for (const field of scalarFields) {
    if (req.body[field] !== undefined) task[field] = req.body[field];
}
if (req.body.blockedBy !== undefined) {
    task.blockedBy = Array.isArray(req.body.blockedBy) ? req.body.blockedBy : [];
}
if (req.body.expected_results !== undefined) {
    task.expected_results = Array.isArray(req.body.expected_results) ? req.body.expected_results : [];
}
if (req.body.last_review_findings !== undefined) {
    task.last_review_findings = Array.isArray(req.body.last_review_findings) ? req.body.last_review_findings : [];
}
if (req.body.running !== undefined) task.running = Boolean(req.body.running);

stampTaskUpdate(task, prevStatus);
```

Add `stampTaskUpdate` to the require from `./lib/tasks`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/`
Expected: PASS, 28 tests.

- [ ] **Step 5: Commit**

```bash
git add server.js test/api-tasks.test.js
git commit -m "feat: PUT tasks accepts full schema and owns timestamp stamping"
```

---

### Task 8: `GET /api/status` gains `project` and `limit`

**Files:**
- Modify: `server.js:161` (`getStatusData` signature), `server.js:305-307` (the route)
- Modify: `test/api-tasks.test.js`

**Interfaces:**
- Consumes: `getStatusData()`.
- Produces: `getStatusData(options?: { project?: string, limit?: number })`. With no options the response is byte-identical to today's.

- [ ] **Step 1: Write the failing test**

Append to `test/api-tasks.test.js`:

```js
test('GET /api/status?project= narrows to one project', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const all = await (await fetch(`${base}/api/status`)).json();
        assert.equal(all.projects.length, 1);
        const one = await (await fetch(`${base}/api/status?project=${encodeURIComponent(dir)}`)).json();
        assert.equal(one.projects.length, 1);
        assert.equal(one.projects[0].path, dir);

        const none = await (await fetch(`${base}/api/status?project=${encodeURIComponent('/nope')}`)).json();
        assert.equal(none.projects.length, 0);
    });
});

test('GET /api/status?limit= caps tasks per status', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        for (let i = 0; i < 3; i++) await seed(base, dir);
        const res = await (await fetch(`${base}/api/status?limit=2`)).json();
        for (const proj of res.projects) {
            const perStatus = {};
            for (const t of proj.tasks) {
                perStatus[t.status] = (perStatus[t.status] || 0) + 1;
            }
            for (const [status, count] of Object.entries(perStatus)) {
                assert.ok(count <= 2, `${proj.name} has ${count} tasks in ${status}, expected at most 2`);
            }
        }
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/api-tasks.test.js`
Expected: FAIL — the query parameters are ignored, so `one.projects.length` is the full project count.

- [ ] **Step 3: Implement**

Change the signature to `function getStatusData(options = {}) {` and, immediately after the `for (const projEntry of parsed.projects || [])` line, skip non-matching projects:

```js
if (options.project && path.resolve(projEntry.path) !== path.resolve(options.project)) continue;
```

Add the limiting helper above `getStatusData`:

```js
const PRIORITY_ORDER = ['critical', 'high', 'medium', 'low'];

function limitPerStatus(tasks, limit) {
    const byStatus = new Map();
    for (const task of tasks) {
        if (!byStatus.has(task.status)) byStatus.set(task.status, []);
        byStatus.get(task.status).push(task);
    }
    const out = [];
    for (const [status, list] of byStatus) {
        list.sort((a, b) => {
            if (status === 'done') {
                return String(b.completed_at || '').localeCompare(String(a.completed_at || ''));
            }
            const pa = PRIORITY_ORDER.indexOf(a.priority || 'medium');
            const pb = PRIORITY_ORDER.indexOf(b.priority || 'medium');
            if (pa !== pb) return pa - pb;
            return String(a.created_at || '').localeCompare(String(b.created_at || ''));
        });
        out.push(...list.slice(0, limit));
    }
    return out;
}
```

Change the `tasks` property in the `data.projects.push({...})` literal:

```js
    tasks: options.limit ? limitPerStatus(tasksData.tasks || [], options.limit) : (tasksData.tasks || []),
```

Change the route:

```js
app.get('/api/status', (req, res) => {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
    res.json(getStatusData({
        project: req.query.project,
        limit: Number.isInteger(limit) && limit > 0 ? limit : undefined
    }));
});
```

Every other caller of `getStatusData()` (the SSE broadcast) passes no argument and is unaffected.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/`
Expected: PASS, 30 tests.

- [ ] **Step 5: Verify the dashboard is unchanged**

Run: `PORT=3399 node server.js`, open `http://localhost:3399`, confirm the six project cards and the kanban board render as before. Stop the server.

- [ ] **Step 6: Commit**

```bash
git add server.js test/api-tasks.test.js
git commit -m "feat: GET /api/status accepts project and limit"
```

---

### Task 9: Retire `lastUpdated`

**Files:**
- Modify: `server.js:282` (the aggregation payload)
- Modify: `agents/Odin.md:30` and `agents/Odin.md:52`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. This is removal.

- [ ] **Step 1: Confirm nothing reads it**

Run: `grep -rn "lastUpdated" server.js public/ agents/ lib/ test/`
Expected: matches only in `server.js:282` and `agents/Odin.md`. If `public/app.js` appears, stop and report — the frontend would break.

- [ ] **Step 2: Remove from the payload**

Delete the `lastUpdated: tasksData.lastUpdated,` line from the `data.projects.push({...})` literal in `getStatusData`.

- [ ] **Step 3: Remove from the Odin definition**

In `agents/Odin.md`, delete the `"lastUpdated": "YYYY-MM-DDTHH:MM:SSZ",` line from the documented schema (line 30) and the bullet `- Always update \`lastUpdated\` when modifying the file.` (line 52).

- [ ] **Step 4: Run the full suite and boot the server**

Run: `node --test test/`
Expected: PASS, 30 tests.

Run: `PORT=3399 node server.js`, load `http://localhost:3399`, confirm the board still renders. Stop the server.

- [ ] **Step 5: Commit**

```bash
git add server.js agents/Odin.md
git commit -m "chore: retire lastUpdated from payload and Odin definition"
```

---

### Task 10: Convert the six live projects

The conversion happens on first write, so this task triggers one harmless write per project and verifies the result.

**Files:**
- Create: `scripts/normalize-tasks.js`

**Interfaces:**
- Consumes: `getTasks`, `saveTasks` from `lib/tasks.js`.
- Produces: a one-shot script. Not wired into the server.

- [ ] **Step 1: Write the script**

Create `scripts/normalize-tasks.js`:

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { getTasks, saveTasks } = require('../lib/tasks');

const registry = path.join(process.cwd(), '.meridian', 'projects.json');
const { projects } = JSON.parse(fs.readFileSync(registry, 'utf8'));

for (const { path: projPath } of projects) {
    const data = getTasks(projPath);
    saveTasks(projPath, data);
    const done = data.tasks.filter(t => t.status === 'done');
    const stamped = done.filter(t => t.completed_at);
    console.log(`${projPath}: ${data.tasks.length} tasks, ${stamped.length}/${done.length} done with completed_at`);
}
```

- [ ] **Step 2: Back up first**

```bash
cd ~/workspace
for p in project_a project_b project_c project_d meridian project_e; do
  cp "$p/.meridian/tasks.json" "$p/.meridian/tasks.json.bak"
done
```

- [ ] **Step 3: Run it from the workspace root**

```bash
cd ~/workspace && node meridian/scripts/normalize-tasks.js
```

Expected output, one line per project, totalling 43 of 56 `done` tasks carrying `completed_at`.

- [ ] **Step 4: Verify the shapes converted**

```bash
cd ~/workspace && python3 -c "
import json,glob
for p in sorted(glob.glob('*/.meridian/tasks.json')):
    d=json.load(open(p))
    print(f'{p:42s} {\"array OK\" if isinstance(d,list) else \"STILL AN OBJECT\"}')
"
```

Expected: `array OK` on all six.

- [ ] **Step 5: Confirm the dashboard still reads them**

Run: `PORT=3399 node meridian/server.js` from the workspace root, load the board, confirm all six projects render with their tasks. Stop the server. Then remove the backups.

- [ ] **Step 6: Commit**

```bash
cd ~/workspace/meridian
git add scripts/normalize-tasks.js
git commit -m "chore: add one-shot tasks.json normalizer"
```

---

## Phase 2 preview

Not planned here. Once this phase is green, the second plan covers the plugin scaffold, the four skills (`status`, `work`, `new`, `next`), the redefined PM agent, the `done` window in `public/app.js`, and deleting the 36 copied `meridian-*` agent files.
