# Dispatch from the board — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator start, queue and stop `meridian:work` runs from the board, with one background session per repository and every failure visible.

**Architecture:** The decisions live in four pure modules under `lib/` and are unit-tested. `server.js` keeps only what cannot be pure: spawning the CLI, signalling it, reading live sessions from `claude agents --json`, and holding the per-project queue in memory. The frontend gains a tri-state button per card, two header controls, and a run tab in the task modal.

**Tech Stack:** Node 18+, CommonJS, Express 5, `node --test`, vanilla JS frontend with no build step.

**Spec:** `docs/superpowers/specs/2026-09-17-dispatch-from-the-board-design.md`

## Global Constraints

- **Language.** Code comments, commit messages and documentation in English. The operator is addressed in Portuguese only in chat, never in files.
- **No new dependencies.** `express` stays the only runtime dependency.
- **Tests are hermetic.** Everything writes to `os.tmpdir()`. No test may read the workspace registry or spawn a CLI. `test/scripts-are-importable.test.js` pins this for `scripts/`; do not break it.
- **`lib/` is the source of truth for anything `public/app.js` also needs.** The frontend has no module system, so a shared function is copied inline into `app.js` and the `lib/` file carries a comment saying so. `lib/board.js` is the precedent.
- **Writes to `tasks.jsonl` go through `lib/tasks.js` only.** Never write the file directly.
- **No `queued` field on the task.** The queue is in memory and nowhere else (spec, "State: in memory, per project").
- **Commit after every task**, Conventional Commits, scope `MERID-<n>` when a board task exists, otherwise `dispatch`.

## Corrections to the spec

The spec was written on 2026-09-17 and four of its measurements have since changed. Where this plan and the spec disagree, **this plan is right** — each item below was re-probed on 2026-09-20.

| Spec says | Actually true now |
|---|---|
| `~/.gemini/config/plugins/meridian` is a symlink to the repo | It is a **copy**. `agy plugin install` copies. Changing plugin files requires `npm run plugin:reload`. |
| The Claude CLI is not authenticated | It **is** (`loggedIn: true`, `claude.ai`). Auth stays an eligibility check, but it is not a blocker today. |
| `agy --print-timeout` defaults to `5m0s` | It defaults to **`0s`**, which waits until the turn completes. Still set it explicitly, but the "nearly every dispatch would be cut off" rationale no longer holds. |
| Failure is detected by matching prose | Both CLIs emit a **structured final event** (shapes in Task 5). Text matching is the fallback only, as the spec already allowed. |

One thing the spec does not mention and that breaks dispatch immediately if missed: **`claude` refuses `--output-format stream-json` without `--verbose`.** Probed: `Error: When using --print, --output-format=stream-json requires --verbose`.

---

### Task 1: Curate the Bash allowlist

The spec calls this "the actual prerequisite for this feature, not the buttons". A dispatched agent runs with the operator's shell privileges for anything the allowlist admits, and a missing entry silently ends the run. This task writes no application code and must land first.

**Files:**
- Create: `.claude/settings.json` in the Meridian repo
- Create: `docs/dispatch-allowlist.md`

- [ ] **Step 1: Confirm there is no allowlist today**

```bash
ls -a .claude/
cat .claude/settings.json 2>/dev/null || echo "none"
```

Expected: `.claude/` holds only `agents/`; no `settings.json`.

- [ ] **Step 2: Write the allowlist**

Create `.claude/settings.json`. The starting set is what `meridian:work` cannot run without — the test runner, and the git verbs the pipeline uses. Everything absent is denied, which ends the run noisily.

```json
{
  "permissions": {
    "allow": [
      "Bash(npm test)",
      "Bash(npm test:*)",
      "Bash(node --test:*)",
      "Bash(git status)",
      "Bash(git status:*)",
      "Bash(git diff:*)",
      "Bash(git add:*)",
      "Bash(git commit:*)",
      "Bash(git log:*)",
      "Bash(git rev-parse:*)"
    ],
    "deny": [
      "Bash(git push:*)",
      "Bash(gh repo delete:*)",
      "Bash(rm -rf:*)"
    ]
  }
}
```

The `deny` entries are not paranoia about the model: they are the operations whose blast radius leaves the machine or is unrecoverable, and no stage of `work` needs them. `git push` is excluded deliberately — publishing stays a human act.

- [ ] **Step 3: Document what the list is and how to extend it**

Create `docs/dispatch-allowlist.md`:

```markdown
# The dispatch allowlist

A dispatched agent runs headless. A tool call needing a permission that is not
granted is **auto-denied, not queued** — the run ends there. So this list is
the boundary that matters, and it is also the thing that breaks a dispatch
when it is too narrow.

It lives in each project's `.claude/settings.json` under `permissions.allow`,
which is the mechanism the headless denial message itself points at.

## What belongs in it

Whatever `meridian:work` cannot complete without: the project's test runner,
and the git verbs the pipeline uses to stage and commit its own work.

## What does not

`git push`, anything that deletes outside the working tree, and anything that
reaches a network service that can act on the operator's behalf. Publishing is
a human act; the pipeline stops at the commit.

## Extending it per project

Each project needs its own, because the test runner differs — `pytest`,
`mix test`, `npm test`. Copy this repository's file and replace the runner
entries.

## When a run dies for a missing permission

The run tab shows *"Run stopped: a command is outside the allowlist"* and the
log names the tool call. Add the specific verb, not a wildcard.
```

- [ ] **Step 4: Verify the settings file is valid and is picked up**

```bash
python3 -c "import json; json.load(open('.claude/settings.json')); print('valid json')"
claude --help >/dev/null && echo "cli ok"
```

Expected: `valid json`, `cli ok`.

- [ ] **Step 5: Commit**

```bash
git add .claude/settings.json docs/dispatch-allowlist.md
git commit -m "feat(dispatch): curate the Bash allowlist a dispatched agent runs under

A headless run auto-denies any permission it was not granted, so the
allowlist is the whole boundary and also the most likely cause of a
dispatch that dies at its first command. The starting set is what work
cannot run without: the test runner, and the git verbs the pipeline uses
to stage and commit. git push is denied deliberately."
```

---

### Task 2: The queue, as pure state

**Files:**
- Create: `lib/dispatch-queue.js`
- Test: `test/dispatch-queue.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `createDispatchState()`, `enqueue(state, projectPath, taskId) -> boolean`, `dequeue(state, projectPath, taskId) -> boolean`, `pullNext(state, projectPath) -> string|null`, `queueFor(state, projectPath) -> string[]`, `clearQueue(state, projectPath) -> void`, `setAuto(state, projectPath, enabled) -> void`, `isAuto(state, projectPath) -> boolean`

- [ ] **Step 1: Write the failing tests**

Create `test/dispatch-queue.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    createDispatchState, enqueue, dequeue, pullNext,
    queueFor, clearQueue, setAuto, isAuto
} = require('../lib/dispatch-queue');

const A = '/ws/alpha';
const B = '/ws/beta';

test('a fresh state has an empty queue and auto off for any project', () => {
    const s = createDispatchState();
    assert.deepEqual(queueFor(s, A), []);
    assert.equal(isAuto(s, A), false);
});

test('enqueue appends in click order and reports that it added', () => {
    const s = createDispatchState();
    assert.equal(enqueue(s, A, 'T-1'), true);
    assert.equal(enqueue(s, A, 'T-2'), true);
    assert.deepEqual(queueFor(s, A), ['T-1', 'T-2']);
});

// A double click must not queue the same task twice, which is what lets the
// card button be a plain toggle with no guard of its own.
test('enqueue is idempotent and says it added nothing', () => {
    const s = createDispatchState();
    enqueue(s, A, 'T-1');
    assert.equal(enqueue(s, A, 'T-1'), false);
    assert.deepEqual(queueFor(s, A), ['T-1']);
});

test('queues are per project and do not leak into each other', () => {
    const s = createDispatchState();
    enqueue(s, A, 'T-1');
    enqueue(s, B, 'T-9');
    assert.deepEqual(queueFor(s, A), ['T-1']);
    assert.deepEqual(queueFor(s, B), ['T-9']);
});

test('dequeue removes one id and reports whether it was there', () => {
    const s = createDispatchState();
    enqueue(s, A, 'T-1');
    enqueue(s, A, 'T-2');
    assert.equal(dequeue(s, A, 'T-1'), true);
    assert.deepEqual(queueFor(s, A), ['T-2']);
    assert.equal(dequeue(s, A, 'T-404'), false);
});

test('pullNext takes from the front and empties down to null', () => {
    const s = createDispatchState();
    enqueue(s, A, 'T-1');
    enqueue(s, A, 'T-2');
    assert.equal(pullNext(s, A), 'T-1');
    assert.equal(pullNext(s, A), 'T-2');
    assert.equal(pullNext(s, A), null);
});

// The returned array must be a copy: the caller renders it and must not be
// able to mutate the queue by accident.
test('queueFor hands back a copy, not the live array', () => {
    const s = createDispatchState();
    enqueue(s, A, 'T-1');
    queueFor(s, A).push('T-INJECTED');
    assert.deepEqual(queueFor(s, A), ['T-1']);
});

test('clearQueue empties one project and leaves the other alone', () => {
    const s = createDispatchState();
    enqueue(s, A, 'T-1');
    enqueue(s, B, 'T-9');
    clearQueue(s, A);
    assert.deepEqual(queueFor(s, A), []);
    assert.deepEqual(queueFor(s, B), ['T-9']);
});

test('auto is per project and toggles', () => {
    const s = createDispatchState();
    setAuto(s, A, true);
    assert.equal(isAuto(s, A), true);
    assert.equal(isAuto(s, B), false);
});

// "Stop queue" is named for what it does: it discards queued work rather than
// suspending it. A button that quietly kept the queue would be a trap.
test('turning auto off clears that project queue', () => {
    const s = createDispatchState();
    setAuto(s, A, true);
    enqueue(s, A, 'T-1');
    enqueue(s, B, 'T-9');
    setAuto(s, A, false);
    assert.deepEqual(queueFor(s, A), []);
    assert.deepEqual(queueFor(s, B), ['T-9'], 'other projects untouched');
});

test('turning auto on does not disturb an existing queue', () => {
    const s = createDispatchState();
    enqueue(s, A, 'T-1');
    setAuto(s, A, true);
    assert.deepEqual(queueFor(s, A), ['T-1']);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/dispatch-queue.test.js`
Expected: FAIL — `Cannot find module '../lib/dispatch-queue'`

- [ ] **Step 3: Implement**

Create `lib/dispatch-queue.js`:

```js
'use strict';

// The dispatch queue and the auto flag, per project, in memory.
//
// Nothing here is persisted, deliberately. A server that is down dispatches
// nothing, so there is nothing for persistence to protect — and a flag that
// outlives the thing it describes is exactly the orphaned `running` bug this
// codebase already had to write a hook to clean up. A restart clears both and
// the board shows that truthfully.
//
// No `queued` field is written to the task either: the queue is already
// authoritative here, and writing one would touch tasks.jsonl, fire fs.watch
// and rebuild the board once per enqueue for a change nobody asked for.

function createDispatchState() {
    return { queues: new Map(), auto: new Map() };
}

function listFor(state, projectPath) {
    if (!state.queues.has(projectPath)) state.queues.set(projectPath, []);
    return state.queues.get(projectPath);
}

// Returns whether it added. Idempotent: a double click cannot queue twice.
function enqueue(state, projectPath, taskId) {
    const list = listFor(state, projectPath);
    if (list.includes(taskId)) return false;
    list.push(taskId);
    return true;
}

function dequeue(state, projectPath, taskId) {
    const list = listFor(state, projectPath);
    const at = list.indexOf(taskId);
    if (at === -1) return false;
    list.splice(at, 1);
    return true;
}

function pullNext(state, projectPath) {
    const list = listFor(state, projectPath);
    return list.length === 0 ? null : list.shift();
}

// A copy: callers render this, and a caller that mutates it would be editing
// the queue by accident.
function queueFor(state, projectPath) {
    return listFor(state, projectPath).slice();
}

function clearQueue(state, projectPath) {
    state.queues.set(projectPath, []);
}

// Disabling clears the queue. `Stop queue` discards rather than suspends —
// see the comment on the matching test.
function setAuto(state, projectPath, enabled) {
    state.auto.set(projectPath, Boolean(enabled));
    if (!enabled) clearQueue(state, projectPath);
}

function isAuto(state, projectPath) {
    return state.auto.get(projectPath) === true;
}

module.exports = {
    createDispatchState, enqueue, dequeue, pullNext,
    queueFor, clearQueue, setAuto, isAuto
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/dispatch-queue.test.js`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add lib/dispatch-queue.js test/dispatch-queue.test.js
git commit -m "feat(dispatch): add the in-memory per-project queue and auto flag

Neither is persisted: a server that is down dispatches nothing, and a
flag outliving what it describes is the orphaned running bug again.
Enqueue is idempotent so the card button needs no guard, and turning
auto off clears the queue because Stop queue discards rather than
suspends."
```

---

### Task 3: The eligibility decision

**Files:**
- Create: `lib/dispatch-eligibility.js`
- Test: `test/dispatch-eligibility.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `dispatchEligibility({ taskId, tasks, authenticated, liveSession }) -> { ok: true } | { ok: false, reason: string }`

- [ ] **Step 1: Write the failing tests**

Create `test/dispatch-eligibility.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dispatchEligibility } = require('../lib/dispatch-eligibility');

const board = [
    { id: 'T-1', status: 'ready_todo' },
    { id: 'T-2', status: 'backlog', blockedBy: ['T-1'] },
    { id: 'T-3', status: 'done' },
    { id: 'T-4', status: 'nope' },
    { id: 'T-5', status: 'blocked', blockedBy: ['T-3'] },
    { id: 'T-6', status: 'spec_approval' }
];

const ok = (over = {}) => Object.assign(
    { taskId: 'T-1', tasks: board, authenticated: true, liveSession: null }, over);

test('a workable task on an authenticated CLI with a free repo is eligible', () => {
    assert.deepEqual(dispatchEligibility(ok()), { ok: true });
});

// Authentication is checked first because it is the one failure that applies
// to every task at once, and its remedy is a single command.
test('an unauthenticated CLI is refused with the command that fixes it', () => {
    const out = dispatchEligibility(ok({ authenticated: false }));
    assert.equal(out.ok, false);
    assert.match(out.reason, /not authenticated/i);
    assert.match(out.reason, /claude auth login/);
});

test('a live session in the repo refuses, naming the lock', () => {
    const out = dispatchEligibility(ok({ liveSession: { pid: 123, kind: 'background' } }));
    assert.equal(out.ok, false);
    assert.match(out.reason, /already running/i);
});

test('authentication outranks the repo lock', () => {
    const out = dispatchEligibility(ok({ authenticated: false, liveSession: { pid: 1 } }));
    assert.match(out.reason, /not authenticated/i);
});

test('a task that left the board is refused by id', () => {
    const out = dispatchEligibility(ok({ taskId: 'T-404' }));
    assert.equal(out.ok, false);
    assert.match(out.reason, /T-404/);
});

test('done and nope are not dispatchable', () => {
    assert.match(dispatchEligibility(ok({ taskId: 'T-3' })).reason, /already done/i);
    assert.match(dispatchEligibility(ok({ taskId: 'T-4' })).reason, /dropped/i);
});

// The spec allows queueing a blocked task behind its blocker; this is the
// check that makes that safe, because it runs at pull time, not enqueue time.
test('an unmet blocker is refused, naming which one', () => {
    const out = dispatchEligibility(ok({ taskId: 'T-2' }));
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'T-2 still blocked by T-1');
});

test('a blocked task whose blocker reached done is eligible', () => {
    assert.deepEqual(dispatchEligibility(ok({ taskId: 'T-5' })), { ok: true });
});

test('several unmet blockers are all named', () => {
    const tasks = [{ id: 'X', status: 'backlog', blockedBy: ['A', 'B'] },
                   { id: 'A', status: 'backlog' }, { id: 'B', status: 'done' }];
    const out = dispatchEligibility(ok({ taskId: 'X', tasks }));
    assert.equal(out.reason, 'X still blocked by A');
});

// A blocker id that is not on the board cannot be shown to be done, so it
// blocks. Treating an unknown id as satisfied would silently dispatch work
// whose dependency nobody can see.
test('a blocker that is not on the board still blocks', () => {
    const tasks = [{ id: 'X', status: 'backlog', blockedBy: ['GHOST'] }];
    const out = dispatchEligibility(ok({ taskId: 'X', tasks }));
    assert.equal(out.reason, 'X still blocked by GHOST');
});

test('spec_approval is dispatchable — the operator asked for it explicitly', () => {
    assert.deepEqual(dispatchEligibility(ok({ taskId: 'T-6' })), { ok: true });
});

test('a missing or malformed board refuses rather than throwing', () => {
    assert.equal(dispatchEligibility(ok({ tasks: null })).ok, false);
    assert.equal(dispatchEligibility(ok({ tasks: 'nope' })).ok, false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/dispatch-eligibility.test.js`
Expected: FAIL — `Cannot find module '../lib/dispatch-eligibility'`

- [ ] **Step 3: Implement**

Create `lib/dispatch-eligibility.js`:

```js
'use strict';

// May this task be dispatched right now, and if not, what does the operator
// need to read?
//
// Checked when pulling from the queue, never when enqueuing: a task can sit
// in the queue for minutes, and its blocker can land or its status can move
// in that time. That re-check is also what makes it safe to queue a `blocked`
// task behind its blocker — being earlier in the queue is not a guarantee the
// blocker reached `done`, since `work` stops at human gates and QA can send a
// task back.
//
// A task that fails a check is discarded from the queue with this reason
// shown, not re-queued at the back: a task whose blocker never lands would
// spin forever, and re-enqueueing is one click.

const NOT_DISPATCHABLE = {
    done: id => `${id} is already done`,
    nope: id => `${id} was dropped`
};

function refuse(reason) {
    return { ok: false, reason };
}

function dispatchEligibility({ taskId, tasks, authenticated, liveSession }) {
    // First, because it applies to every task at once and has one remedy.
    if (!authenticated) {
        return refuse('CLI not authenticated — run `claude auth login`');
    }
    if (liveSession) {
        return refuse('a session is already running in this repository');
    }
    if (!Array.isArray(tasks)) {
        return refuse('the board could not be read');
    }

    const byId = new Map(tasks.map(t => [t && t.id, t]));
    const task = byId.get(taskId);
    if (!task) return refuse(`${taskId} is no longer on the board`);

    const gone = NOT_DISPATCHABLE[task.status];
    if (gone) return refuse(gone(taskId));

    // An id that is not on the board cannot be shown to be done, so it
    // blocks. Treating it as satisfied would dispatch work whose dependency
    // nobody can see.
    for (const blockerId of task.blockedBy || []) {
        const blocker = byId.get(blockerId);
        if (!blocker || blocker.status !== 'done') {
            return refuse(`${taskId} still blocked by ${blockerId}`);
        }
    }

    return { ok: true };
}

module.exports = { dispatchEligibility };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/dispatch-eligibility.test.js`
Expected: PASS, 12 tests

- [ ] **Step 5: Commit**

```bash
git add lib/dispatch-eligibility.js test/dispatch-eligibility.test.js
git commit -m "feat(dispatch): decide whether a task may be dispatched, with a reason

Checked at pull time rather than enqueue time, which is what makes it
safe to queue a blocked task behind its blocker: the queue order is not
a guarantee the blocker landed. A blocker id absent from the board
blocks, because it cannot be shown to be done."
```

---

### Task 4: The command each CLI runs

**Files:**
- Create: `lib/dispatch-command.js`
- Test: `test/dispatch-command.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `dispatchCommand(tool, taskId) -> { argv: string[], display: string } | null`, `DISPATCH_TIMEOUT_MS`

- [ ] **Step 1: Write the failing tests**

Create `test/dispatch-command.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dispatchCommand, DISPATCH_TIMEOUT_MS } = require('../lib/dispatch-command');

test('both CLIs invoke the work skill for the given task', () => {
    for (const tool of ['claude', 'agy']) {
        const cmd = dispatchCommand(tool, 'MERID-12');
        assert.equal(cmd.argv[0], tool);
        assert.ok(cmd.argv.includes('/meridian:work MERID-12'),
            `${tool} passes the slash command as one argv entry`);
        assert.equal(cmd.display, cmd.argv.join(' '));
    }
});

// Probed 2026-09-20: `claude -p --output-format stream-json` without
// --verbose exits immediately with "requires --verbose". Without this the
// feature never runs once.
test('claude asks for stream-json and the --verbose it requires', () => {
    const { argv } = dispatchCommand('claude', 'T-1');
    assert.ok(argv.includes('--output-format'));
    assert.ok(argv.includes('stream-json'));
    assert.ok(argv.includes('--verbose'), 'stream-json is refused without it');
});

test('agy asks for stream-json and an explicit timeout', () => {
    const { argv } = dispatchCommand('agy', 'T-1');
    assert.ok(argv.includes('--output-format'));
    assert.ok(argv.includes('stream-json'));
    const at = argv.indexOf('--print-timeout');
    assert.notEqual(at, -1, 'timeout is stated rather than inherited');
    assert.match(argv[at + 1], /^\d+[ms]$/);
});

// Probed: a relative write under --sandbox landed in the CLI's scratch
// directory instead of the repository, while an absolute write to /tmp
// succeeded. It breaks real work without preventing escape.
test('agy never runs sandboxed', () => {
    assert.ok(!dispatchCommand('agy', 'T-1').argv.includes('--sandbox'));
});

test('neither CLI is given a permission mode that bypasses the allowlist', () => {
    for (const tool of ['claude', 'agy']) {
        const flat = dispatchCommand(tool, 'T-1').argv.join(' ');
        assert.ok(!/bypassPermissions|dangerously/i.test(flat));
    }
});

// The task id reaches a spawn. Anything that is not an id must not get there,
// and argv (no shell) plus this guard are the two layers that stop it.
test('an id that is not a plain task id yields no command', () => {
    for (const bad of ['T-1; rm -rf /', '$(whoami)', '../../etc/passwd', '', null]) {
        assert.equal(dispatchCommand('claude', bad), null, `refused: ${bad}`);
    }
});

test('an unknown tool yields no command', () => {
    assert.equal(dispatchCommand('bash', 'T-1'), null);
    assert.equal(dispatchCommand('', 'T-1'), null);
});

test('the timeout is well above the longest observed run', () => {
    assert.ok(DISPATCH_TIMEOUT_MS >= 2 * 60 * 60 * 1000, 'at least two hours');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/dispatch-command.test.js`
Expected: FAIL — `Cannot find module '../lib/dispatch-command'`

- [ ] **Step 3: Implement**

Create `lib/dispatch-command.js`:

```js
'use strict';

// The exact command a dispatch runs, per CLI.
//
// Same shape as lib/tooling.js: a fixed table, argv rather than a string, and
// a caller that names a tool rather than supplying a command. The task id is
// the only variable, and it is validated before it reaches a spawn.
//
// Both CLIs run in stream-json. Text mode was measured to exit 0 while
// producing nothing ("a tool required the 'command' permission that headless
// mode cannot prompt for, so it was auto-denied"), so the exit code alone
// cannot be trusted. stream-json gives the live events the board renders and
// a structured verdict from the same mechanism.

// A task id, nothing else. This string reaches a spawn: argv means no shell
// interprets it, and this is the second layer.
const SAFE_ID = /^[A-Za-z0-9_.-]+$/;

// The measured median run is 11-15 minutes in `in_progress` alone, and a full
// `work` chains several stages. Two hours is well clear of the longest
// observed run without leaving a wedged process forever.
const DISPATCH_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function dispatchCommand(tool, taskId) {
    if (typeof taskId !== 'string' || !SAFE_ID.test(taskId)) return null;

    const prompt = `/meridian:work ${taskId}`;
    const table = {
        // --verbose is not optional: probed 2026-09-20, `claude -p` refuses
        // --output-format stream-json without it.
        claude: ['claude', '-p', prompt,
                 '--output-format', 'stream-json', '--verbose',
                 '--permission-mode', 'acceptEdits'],
        // No --sandbox: it redirects relative writes to a scratch directory
        // while leaving absolute writes through, so it breaks legitimate
        // in-repo work without being a boundary. The allowlist is the
        // boundary.
        agy: ['agy', '-p', prompt,
              '--output-format', 'stream-json',
              '--mode', 'accept-edits',
              '--print-timeout', `${Math.round(DISPATCH_TIMEOUT_MS / 1000)}s`]
    };

    const argv = table[tool];
    if (!argv) return null;
    return { argv, display: argv.join(' ') };
}

module.exports = { dispatchCommand, DISPATCH_TIMEOUT_MS };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/dispatch-command.test.js`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add lib/dispatch-command.js test/dispatch-command.test.js
git commit -m "feat(dispatch): build the per-CLI dispatch command from a fixed table

argv rather than a string, and the caller names a tool rather than
supplying a command — the same shape as lib/tooling.js. claude gets the
--verbose that stream-json refuses to run without, and agy does not get
--sandbox, which redirects relative writes without stopping absolute
ones."
```

---

### Task 5: Reading the verdict out of the stream

**Files:**
- Create: `lib/dispatch-outcome.js`
- Test: `test/dispatch-outcome.test.js`

Both CLIs emit one JSON object per line and a final result event, but **in different envelopes**. Both shapes below were captured from a real run on 2026-09-20, not invented:

```
claude: {"type":"result","subtype":"success","is_error":false,"result":"ok",
         "permission_denials":[],"terminal_reason":"completed","num_turns":1}

agy:    {"event":"result","result":{"conversation_id":"…","status":"SUCCESS",
         "response":"ok\n","duration_seconds":2.1,"num_turns":1}}
```

**Interfaces:**
- Consumes: nothing
- Produces: `finalEvent(text) -> object|null`, `dispatchOutcome({ stdout, code }) -> { ok: boolean, reason: string|null, summary: string }`

- [ ] **Step 1: Write the failing tests**

Create `test/dispatch-outcome.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { finalEvent, dispatchOutcome } = require('../lib/dispatch-outcome');

const CLAUDE_OK = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: 'done',
    permission_denials: [], terminal_reason: 'completed', num_turns: 4
});
const AGY_OK = JSON.stringify({
    event: 'result',
    result: { conversation_id: 'c1', status: 'SUCCESS', response: 'done\n', num_turns: 4 }
});

const stream = (...lines) => lines.join('\n') + '\n';

test('the final result event is found past any amount of chatter', () => {
    const text = stream('{"type":"system","subtype":"init"}',
                        '{"type":"assistant"}', CLAUDE_OK);
    assert.equal(finalEvent(text).type, 'result');
});

test('unparseable lines are skipped rather than throwing', () => {
    const text = stream('not json at all', '', '   ', CLAUDE_OK);
    assert.equal(finalEvent(text).subtype, 'success');
});

test('a stream with no result event yields null', () => {
    assert.equal(finalEvent(stream('{"type":"assistant"}')), null);
    assert.equal(finalEvent(''), null);
    assert.equal(finalEvent(null), null);
});

test('a successful run of either CLI reads as ok', () => {
    for (const text of [stream(CLAUDE_OK), stream(AGY_OK)]) {
        assert.deepEqual(dispatchOutcome({ stdout: text, code: 0 }),
            { ok: true, reason: null, summary: 'done' });
    }
});

// The measured failure that started all of this: agy printed nothing useful
// and exited 0. A run with no result is a failure whatever the code says.
test('no result event is a failure even on exit 0', () => {
    const out = dispatchOutcome({ stdout: stream('{"type":"assistant"}'), code: 0 });
    assert.equal(out.ok, false);
    assert.match(out.reason, /no result/i);
});

test('claude is_error is a failure and carries its text', () => {
    const text = stream(JSON.stringify({
        type: 'result', is_error: true, result: 'the model refused',
        permission_denials: [], terminal_reason: 'error'
    }));
    const out = dispatchOutcome({ stdout: text, code: 0 });
    assert.equal(out.ok, false);
    assert.match(out.reason, /the model refused/);
});

test('agy a non-SUCCESS status is a failure and carries its status', () => {
    const text = stream(JSON.stringify({
        event: 'result', result: { status: 'ERROR', response: 'boom' }
    }));
    const out = dispatchOutcome({ stdout: text, code: 0 });
    assert.equal(out.ok, false);
    assert.match(out.reason, /boom|ERROR/);
});

// A permission denial is structured now, so it is read rather than matched.
// This is the failure the allowlist causes, and it has a specific remedy.
test('a permission denial is translated to the allowlist remedy', () => {
    const text = stream(JSON.stringify({
        type: 'result', is_error: false, result: '',
        permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'npm run lint' } }],
        terminal_reason: 'completed'
    }));
    const out = dispatchOutcome({ stdout: text, code: 0 });
    assert.equal(out.ok, false);
    assert.match(out.reason, /outside the allowlist/i);
    assert.match(out.reason, /npm run lint/, 'names the command that was denied');
});

// Text matching survives only where the output arrived unstructured.
test('an auth failure in unstructured output is still translated', () => {
    const out = dispatchOutcome({ stdout: 'Failed to authenticate: OAuth session expired', code: 1 });
    assert.equal(out.ok, false);
    assert.match(out.reason, /not authenticated/i);
    assert.match(out.reason, /claude auth login/);
});

test('an unstructured denial message is translated too', () => {
    const out = dispatchOutcome({
        stdout: "a tool required the 'command' permission that headless mode cannot prompt for",
        code: 0
    });
    assert.match(out.reason, /outside the allowlist/i);
});

// A translation table that swallows what it does not recognise is worse than
// no table at all.
test('an unrecognised failure is surfaced verbatim, trimmed to the end', () => {
    const noise = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const out = dispatchOutcome({ stdout: noise, code: 3 });
    assert.equal(out.ok, false);
    assert.match(out.reason, /line 199/, 'keeps the end, where the error is');
    assert.ok(out.reason.length < 1000, 'but does not dump the whole run');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/dispatch-outcome.test.js`
Expected: FAIL — `Cannot find module '../lib/dispatch-outcome'`

- [ ] **Step 3: Implement**

Create `lib/dispatch-outcome.js`:

```js
'use strict';

// Did the dispatch succeed, and if not, what does the operator need to read?
//
// The exit code is not enough and neither CLI has a flag to change that:
// `agy -p` was measured printing "no output produced — a tool required the
// 'command' permission that headless mode cannot prompt for, so it was
// auto-denied" and exiting 0. So the verdict comes from the structured final
// event of the stream, and a run that produced no result at all is a failure
// whatever the exit code says.
//
// The two CLIs wrap that event differently. Captured 2026-09-20:
//   claude: {"type":"result","is_error":false,"result":"…",
//            "permission_denials":[],"terminal_reason":"completed"}
//   agy:    {"event":"result","result":{"status":"SUCCESS","response":"…"}}

const AUTH_REMEDY = 'CLI not authenticated — run `claude auth login`';
const ALLOWLIST_REMEDY = 'Run stopped: a command is outside the allowlist';

// Unstructured fallbacks. These only fire when no result event arrived, which
// is why they stay: output that never became JSON still has to be readable.
const TEXT_SHAPES = [
    [/failed to authenticate|oauth session expired/i, AUTH_REMEDY],
    [/permission that headless mode cannot prompt for/i, ALLOWLIST_REMEDY]
];

function isResultEvent(obj) {
    return obj && (obj.type === 'result' || obj.event === 'result');
}

// The last result event in the stream. Lines that are not JSON are skipped:
// a CLI is free to print a banner, and one bad line must not lose the verdict.
function finalEvent(text) {
    if (typeof text !== 'string') return null;
    let found = null;
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed[0] !== '{') continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (isResultEvent(parsed)) found = parsed;
        } catch (err) {
            // Not JSON, or a partial line. Keep looking.
        }
    }
    return found;
}

function tail(text, lines = 12, cap = 800) {
    const body = String(text || '').trim().split('\n').slice(-lines).join('\n');
    return body.length > cap ? body.slice(-cap) : body;
}

function translateText(text) {
    for (const [pattern, remedy] of TEXT_SHAPES) {
        if (pattern.test(String(text || ''))) return remedy;
    }
    return null;
}

// A denial is structured, so it is read rather than matched, and the command
// that was refused is named — that is the thing the operator has to add.
function denialReason(denials) {
    if (!Array.isArray(denials) || denials.length === 0) return null;
    const first = denials[0] || {};
    const what = (first.tool_input && (first.tool_input.command || first.tool_input.file_path))
        || first.tool_name || 'a tool call';
    return `${ALLOWLIST_REMEDY} (${what})`;
}

function dispatchOutcome({ stdout, code }) {
    const event = finalEvent(stdout);

    if (!event) {
        // No verdict at all. This is the measured exit-0-with-nothing case.
        const translated = translateText(stdout);
        return {
            ok: false,
            reason: translated || `the run produced no result${code ? ` (exit ${code})` : ''}: ${tail(stdout)}`,
            summary: ''
        };
    }

    if (event.type === 'result') {
        const denial = denialReason(event.permission_denials);
        if (denial) return { ok: false, reason: denial, summary: String(event.result || '') };
        if (event.is_error || event.terminal_reason === 'error') {
            return {
                ok: false,
                reason: translateText(event.result) || tail(event.result) || 'the run reported an error',
                summary: String(event.result || '')
            };
        }
        return { ok: true, reason: null, summary: String(event.result || '') };
    }

    // agy
    const result = event.result || {};
    const response = String(result.response || '').trim();
    if (result.status !== 'SUCCESS') {
        return {
            ok: false,
            reason: translateText(response) || tail(response) || `the run reported ${result.status || 'no status'}`,
            summary: response
        };
    }
    return { ok: true, reason: null, summary: response };
}

module.exports = { finalEvent, dispatchOutcome };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/dispatch-outcome.test.js`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add lib/dispatch-outcome.js test/dispatch-outcome.test.js
git commit -m "feat(dispatch): read the verdict from the stream, not the exit code

agy was measured exiting 0 having produced nothing, so the exit code
cannot decide this. The verdict comes from each CLI's structured final
event — their envelopes differ and both shapes are captured in the
module comment — and a run with no result is a failure regardless.
Permission denials are read from the structured field and name the
command that was refused; text matching remains only for output that
never became JSON."
```

---

### Task 6: The repository lock, derived from live sessions

**Files:**
- Create: `lib/dispatch-sessions.js`
- Test: `test/dispatch-sessions.test.js`

`server.js` is not touched here. The helper that calls this module
(`liveSessionFor`, using the existing `runTooling`) lands in Task 7, so this
task stays a pure module with its own tests.

**Interfaces:**
- Consumes: nothing
- Produces: `backgroundSessionFor(agentsJson, projectPath) -> { pid, sessionId } | null`

The lock is derived, never stored: a process that died is gone from `claude agents --json` on its own, so the lock cannot stick. Real output shape, captured 2026-09-20:

```json
[{"pid":46841,"cwd":"/ws/alpha","kind":"interactive","sessionId":"1f6c…","status":"idle"}]
```

- [ ] **Step 1: Write the failing tests**

Create `test/dispatch-sessions.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { backgroundSessionFor } = require('../lib/dispatch-sessions');

const LIST = JSON.stringify([
    { pid: 1, cwd: '/ws/alpha', kind: 'interactive', sessionId: 'a', status: 'idle' },
    { pid: 2, cwd: '/ws/beta', kind: 'background', sessionId: 'b', status: 'busy' },
    { pid: 3, cwd: '/ws/beta/sub', kind: 'background', sessionId: 'c', status: 'busy' }
]);

test('a background session in the project is the lock', () => {
    assert.deepEqual(backgroundSessionFor(LIST, '/ws/beta'), { pid: 2, sessionId: 'b' });
});

// The operator's own terminal must not lock the board out of dispatching.
test('an interactive session is not a lock', () => {
    assert.equal(backgroundSessionFor(LIST, '/ws/alpha'), null);
});

test('a project with no session at all is free', () => {
    assert.equal(backgroundSessionFor(LIST, '/ws/gamma'), null);
});

// A session in a subdirectory is a different working tree as far as the lock
// is concerned; matching by prefix would lock a parent out of dispatching
// because something runs in one of its folders.
test('the cwd must match exactly, not by prefix', () => {
    assert.equal(backgroundSessionFor(LIST, '/ws'), null);
});

test('a trailing slash on either side still matches', () => {
    assert.deepEqual(backgroundSessionFor(LIST, '/ws/beta/'), { pid: 2, sessionId: 'b' });
});

// The CLI being absent, erroring or printing a banner must read as "no
// session", never as a lock: an unreadable list would otherwise freeze
// dispatch permanently with no way to tell why.
test('unreadable output reads as no session rather than throwing', () => {
    for (const junk of ['', 'command not found', '{}', '[', null, undefined]) {
        assert.equal(backgroundSessionFor(junk, '/ws/beta'), null);
    }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/dispatch-sessions.test.js`
Expected: FAIL — `Cannot find module '../lib/dispatch-sessions'`

- [ ] **Step 3: Implement**

Create `lib/dispatch-sessions.js`:

```js
'use strict';

// The one-session-per-repository lock, derived from `claude agents --json`
// rather than stored.
//
// Derived matters: a process that died is gone from that list on its own, so
// the lock cannot stick the way a stored flag would. This is the same lesson
// the orphaned `running` flag taught.
//
// Only `kind: "background"` counts. The operator's own interactive session in
// the repo is not a lock — locking the board out because a terminal is open
// would make the feature useless on the machine it runs on.

const path = require('node:path');

function normalise(dir) {
    if (typeof dir !== 'string' || !dir) return null;
    return path.normalize(dir).replace(/\/+$/, '') || '/';
}

function backgroundSessionFor(agentsJson, projectPath) {
    const want = normalise(projectPath);
    if (!want) return null;

    let list;
    try {
        list = JSON.parse(agentsJson);
    } catch (err) {
        // Absent CLI, a banner, a partial write. No session, not a lock.
        return null;
    }
    if (!Array.isArray(list)) return null;

    // Exact cwd only. Prefix matching would let a session in one subfolder
    // lock the parent repository out of dispatching.
    const hit = list.find(s =>
        s && s.kind === 'background' && normalise(s.cwd) === want);

    return hit ? { pid: hit.pid, sessionId: hit.sessionId } : null;
}

module.exports = { backgroundSessionFor };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/dispatch-sessions.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add lib/dispatch-sessions.js test/dispatch-sessions.test.js
git commit -m "feat(dispatch): derive the per-repo lock from claude agents --json

Derived rather than stored, so a process that died releases the lock by
disappearing. Only background sessions count: the operator's own
terminal in the repo must not lock the board out. Unreadable output
reads as no session, because a lock nobody can clear is worse than a
missed one."
```

---

### Task 7: The dispatch endpoints

**Files:**
- Modify: `server.js` — add after the tooling endpoints (after `server.js:490`), and extend `GET /api/status`
- Test: `test/api-dispatch.test.js`

**Interfaces:**
- Consumes: `lib/dispatch-queue.js` (all), `lib/dispatch-sessions.js` (`backgroundSessionFor`)
- Produces: the four endpoints below, plus `dispatchState` and `runDispatchLoop(projectPath)` (a stub in this task, implemented in Task 8)

- [ ] **Step 1: Write the failing tests**

Create `test/api-dispatch.test.js`.

**Use the fixture pattern this repo already has** — `test/api-tasks.test.js:10-51` defines `workspaceWith(name)` and `withServer(ws, fn)`. There is no `test/helpers/` directory and the repo copies these helpers per file rather than sharing them; follow that, do not introduce a shared helper for this task. `withServer` spawns the real `server.js` with `MERIDIAN_RUNNING_DIR` pointed at the fixture workspace, which is what keeps tests away from the real boards, and polls `/api/status` until it answers.

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Copied from test/api-tasks.test.js:10-51, extended to seed tasks. The
// server is pointed at this workspace with MERIDIAN_RUNNING_DIR so the tests
// never see the real boards.
function workspaceWith(tasks) {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-ws-'));
    const dir = path.join(ws, 'fixture-project');
    fs.mkdirSync(path.join(dir, '.meridian'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.meridian', 'project-info.json'),
        JSON.stringify({ name: 'Fixture', key: 'TST', stack: [], description: 'x' }));
    fs.writeFileSync(path.join(dir, '.meridian', 'tasks.jsonl'),
        tasks.map(t => JSON.stringify(t)).join('\n') + '\n');
    fs.mkdirSync(path.join(ws, '.meridian'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.meridian', 'projects.json'),
        JSON.stringify({ projects: [{ path: dir }] }));
    return { ws, dir };
}

async function withServer(ws, fn) {
    const port = 3400 + Math.floor(Math.random() * 500);
    const proc = require('node:child_process').spawn('node', ['server.js'], {
        env: { ...process.env, PORT: String(port), MERIDIAN_RUNNING_DIR: ws },
        cwd: path.join(__dirname, '..'),
        stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    proc.stderr.on('data', chunk => { stderr += chunk; });
    try {
        let ready = false;
        for (let i = 0; i < 50; i++) {
            try { await fetch(`http://localhost:${port}/api/status`); ready = true; break; }
            catch { await new Promise(r => setTimeout(r, 100)); }
        }
        if (!ready) throw new Error(`Server did not start.\nstderr:\n${stderr || '(empty)'}`);
        await fn(`http://localhost:${port}`);
    } finally {
        proc.kill('SIGKILL');
    }
}

const TASKS = [
    { id: 'TST-1', title: 'one', status: 'ready_todo', created_at: '2026-01-01T00:00:00Z' },
    { id: 'TST-2', title: 'two', status: 'backlog', created_at: '2026-01-02T00:00:00Z' }
];

const json = (base, p) => fetch(`${base}${p}`).then(r => r.json());
const post = (base, p, body) => fetch(`${base}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});
const projectIn = (body, dir) => body.projects.find(p => p.path === dir);

test('status carries an empty queue and auto off before anything is dispatched', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    await withServer(ws, async base => {
        const p = projectIn(await json(base, '/api/status'), dir);
        assert.deepEqual(p.queue, []);
        assert.equal(p.autoDispatch, false);
        assert.ok('dispatchBlockedReason' in p);
    });
});

test('POST dispatch enqueues and the queue shows in status, in order', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    await withServer(ws, async base => {
        await post(base, '/api/projects/dispatch', { projectPath: dir, taskId: 'TST-1', tool: 'claude' });
        await post(base, '/api/projects/dispatch', { projectPath: dir, taskId: 'TST-2', tool: 'claude' });
        assert.deepEqual(projectIn(await json(base, '/api/status'), dir).queue, ['TST-1', 'TST-2']);
    });
});

test('dispatching the same task twice queues it once', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    await withServer(ws, async base => {
        await post(base, '/api/projects/dispatch', { projectPath: dir, taskId: 'TST-1', tool: 'claude' });
        await post(base, '/api/projects/dispatch', { projectPath: dir, taskId: 'TST-1', tool: 'claude' });
        assert.deepEqual(projectIn(await json(base, '/api/status'), dir).queue, ['TST-1']);
    });
});

test('DELETE removes one task from the queue', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    await withServer(ws, async base => {
        await post(base, '/api/projects/dispatch', { projectPath: dir, taskId: 'TST-1', tool: 'claude' });
        await post(base, '/api/projects/dispatch', { projectPath: dir, taskId: 'TST-2', tool: 'claude' });
        await fetch(`${base}/api/projects/dispatch/TST-1?project=${encodeURIComponent(dir)}`,
            { method: 'DELETE' });
        assert.deepEqual(projectIn(await json(base, '/api/status'), dir).queue, ['TST-2']);
    });
});

test('auto on is reported; auto off clears the queue with it', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    await withServer(ws, async base => {
        await post(base, '/api/projects/dispatch', { projectPath: dir, taskId: 'TST-1', tool: 'claude' });
        await post(base, '/api/projects/dispatch/auto', { projectPath: dir, enabled: true });
        assert.equal(projectIn(await json(base, '/api/status'), dir).autoDispatch, true);

        await post(base, '/api/projects/dispatch/auto', { projectPath: dir, enabled: false });
        const p = projectIn(await json(base, '/api/status'), dir);
        assert.equal(p.autoDispatch, false);
        assert.deepEqual(p.queue, [], 'stop queue discards rather than suspends');
    });
});

// The endpoint names a tool; it must never accept a command.
test('an unknown tool is refused', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    await withServer(ws, async base => {
        const res = await post(base, '/api/projects/dispatch',
            { projectPath: dir, taskId: 'TST-1', tool: 'bash -c rm' });
        assert.equal(res.status, 400);
    });
});

test('a project that is not registered is refused', async () => {
    const { ws } = workspaceWith(TASKS);
    await withServer(ws, async base => {
        const res = await post(base, '/api/projects/dispatch',
            { projectPath: '/etc', taskId: 'TST-1', tool: 'claude' });
        assert.equal(res.status, 400);
    });
});

test('a missing field is refused rather than half-applied', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    await withServer(ws, async base => {
        for (const body of [{ projectPath: dir }, { taskId: 'TST-1' }, {}]) {
            assert.equal((await post(base, '/api/projects/dispatch', body)).status, 400);
        }
    });
});

// The queue is in memory and nowhere else. Nothing here may touch the board.
test('enqueueing writes nothing to tasks.jsonl', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    const file = path.join(dir, '.meridian', 'tasks.jsonl');
    const before = fs.readFileSync(file, 'utf8');
    await withServer(ws, async base => {
        await post(base, '/api/projects/dispatch', { projectPath: dir, taskId: 'TST-1', tool: 'claude' });
        assert.equal(fs.readFileSync(file, 'utf8'), before, 'no queued field was written');
    });
});
```

Note for the implementer: `runDispatchLoop` is a no-op stub in this task, so none of these tests spawn a CLI. Once Task 8 lands, the loop will find no `claude` on a fixture machine and refuse on the authentication check — which is why `withServer` must never run against a real workspace.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/api-dispatch.test.js`
Expected: FAIL — the queue fields are absent from `/api/status`

- [ ] **Step 3: Implement**

In `server.js`, near the other requires at the top:

```js
const {
    createDispatchState, enqueue, dequeue, queueFor, setAuto, isAuto
} = require('./lib/dispatch-queue');
const { backgroundSessionFor } = require('./lib/dispatch-sessions');
const { dispatchCommand } = require('./lib/dispatch-command');
```

Next to `const watchers = new Map();` (`server.js:1242`), add:

```js
// The dispatch queue, the auto flag and the last run per project. All in
// memory: see lib/dispatch-queue.js for why none of it is persisted.
const dispatchState = createDispatchState();
const lastRun = new Map();
```

Add a helper beside `runTooling` (`server.js:362`):

```js
// The live background session for a project, or null. Derived on demand from
// the CLI rather than tracked, so a process that died releases the lock by
// disappearing.
async function liveSessionFor(projectPath) {
    const probe = await runTooling(['claude', 'agents', '--json'], 10000);
    return backgroundSessionFor(probe.stdout, projectPath);
}
```

In the handler for `GET /api/status`, where each project object is assembled, add:

```js
    queue: queueFor(dispatchState, project.path),
    autoDispatch: isAuto(dispatchState, project.path),
    dispatchBlockedReason: null, // filled by the loop in Task 8
    lastRun: lastRun.get(project.path) || null,
```

Add the four endpoints after the tooling ones (`server.js:490`):

```js
// Dispatch: the client names a project, a task and a tool. It never sends a
// command — lib/dispatch-command.js owns that, the same way lib/tooling.js
// owns the settings screen's commands.

function registeredProject(projectPath) {
    if (!projectPath || !fs.existsSync(PROJECTS_JSON_PATH)) return false;
    const { projects } = JSON.parse(fs.readFileSync(PROJECTS_JSON_PATH, 'utf8'));
    return (projects || []).some(p => p.path === projectPath);
}

app.post('/api/projects/dispatch', (req, res) => {
    const { projectPath, taskId, tool } = req.body || {};
    if (!projectPath || !taskId || !tool) {
        return res.status(400).json({ error: 'projectPath, taskId and tool are required' });
    }
    if (!registeredProject(projectPath)) {
        return res.status(400).json({ error: `Unknown project ${projectPath}` });
    }
    // Validating here rather than at spawn time means an unknown tool or a
    // malformed id is rejected before it can sit in the queue.
    if (!dispatchCommand(tool, taskId)) {
        return res.status(400).json({ error: `Cannot dispatch ${taskId} with ${tool}` });
    }

    const added = enqueue(dispatchState, projectPath, taskId);
    broadcastUpdate();
    runDispatchLoop(projectPath);
    res.json({ ok: true, added, queue: queueFor(dispatchState, projectPath) });
});

app.delete('/api/projects/dispatch/:taskId', (req, res) => {
    const projectPath = req.query.project;
    if (!registeredProject(projectPath)) {
        return res.status(400).json({ error: `Unknown project ${projectPath}` });
    }
    const removed = dequeue(dispatchState, projectPath, req.params.taskId);
    broadcastUpdate();
    res.json({ ok: true, removed, queue: queueFor(dispatchState, projectPath) });
});

app.post('/api/projects/dispatch/auto', (req, res) => {
    const { projectPath, enabled } = req.body || {};
    if (!registeredProject(projectPath)) {
        return res.status(400).json({ error: `Unknown project ${projectPath}` });
    }
    // Disabling clears the queue — `Stop queue` discards rather than suspends.
    setAuto(dispatchState, projectPath, Boolean(enabled));
    broadcastUpdate();
    if (enabled) runDispatchLoop(projectPath);
    res.json({ ok: true, autoDispatch: isAuto(dispatchState, projectPath) });
});

app.post('/api/projects/dispatch/stop', async (req, res) => {
    const { projectPath } = req.body || {};
    if (!registeredProject(projectPath)) {
        return res.status(400).json({ error: `Unknown project ${projectPath}` });
    }
    const stopped = await stopDispatch(projectPath);
    broadcastUpdate();
    res.json({ ok: true, stopped });
});
```

Add stubs so this task is testable on its own; Task 8 replaces both bodies:

```js
// Implemented in Task 8.
function runDispatchLoop(projectPath) { /* no-op until the runner lands */ }
async function stopDispatch(projectPath) { return false; }
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/api-dispatch.test.js`
Expected: PASS, 9 tests

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add server.js test/api-dispatch.test.js
git commit -m "feat(dispatch): add the queue endpoints and report queue state

The client names a project, a task and a tool, never a command — the
same contract as the settings screen. The tool and id are validated at
enqueue so nothing malformed can sit in the queue, and enqueueing writes
nothing to tasks.jsonl: the queue is in memory and nowhere else."
```

---

### Task 8: The runner

**Files:**
- Modify: `server.js` — replace the two stubs from Task 7
- Create: `lib/run-log.js`
- Test: `test/run-log.test.js`

**Interfaces:**
- Consumes: `lib/dispatch-command.js`, `lib/dispatch-outcome.js`, `lib/dispatch-eligibility.js`, `lib/dispatch-queue.js`, `lib/dispatch-sessions.js`
- Produces: `runLogPath(projectPath, taskId, now) -> string`, `appendRunLog(file, chunk)`, `listRunLogs(projectPath, taskId) -> string[]`

- [ ] **Step 1: Write the failing tests for the log**

Create `test/run-log.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLogPath, appendRunLog, listRunLogs } = require('../lib/run-log');

function project() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-runlog-'));
    fs.mkdirSync(path.join(dir, '.meridian'), { recursive: true });
    return dir;
}

test('the log lands in .meridian/runs named by task and timestamp', () => {
    const dir = project();
    const file = runLogPath(dir, 'DEMO-1', new Date('2026-09-20T14:05:09Z'));
    assert.equal(path.dirname(file), path.join(dir, '.meridian', 'runs'));
    assert.match(path.basename(file), /^DEMO-1-2026-09-20T14-05-09\.log$/);
});

// Two runs of one task must not overwrite each other: "what did it do at 3am"
// is the question the file exists to answer.
test('two runs of one task get two files', () => {
    const dir = project();
    const a = runLogPath(dir, 'DEMO-1', new Date('2026-09-20T14:05:09Z'));
    const b = runLogPath(dir, 'DEMO-1', new Date('2026-09-20T15:30:00Z'));
    assert.notEqual(a, b);
});

test('appending creates the directory and accumulates', () => {
    const dir = project();
    const file = runLogPath(dir, 'DEMO-1', new Date());
    appendRunLog(file, 'first\n');
    appendRunLog(file, 'second\n');
    assert.equal(fs.readFileSync(file, 'utf8'), 'first\nsecond\n');
});

test('logs for a task are listed newest first', () => {
    const dir = project();
    const older = runLogPath(dir, 'DEMO-1', new Date('2026-09-20T10:00:00Z'));
    const newer = runLogPath(dir, 'DEMO-1', new Date('2026-09-20T12:00:00Z'));
    appendRunLog(older, 'a');
    appendRunLog(newer, 'b');
    appendRunLog(runLogPath(dir, 'DEMO-2', new Date()), 'c');
    assert.deepEqual(listRunLogs(dir, 'DEMO-1').map(p => path.basename(p)),
        [path.basename(newer), path.basename(older)]);
});

test('a project with no runs lists nothing rather than throwing', () => {
    assert.deepEqual(listRunLogs(project(), 'DEMO-1'), []);
});

// The id reaches a file path. It is validated everywhere else too; this is
// the layer that stops a traversal from landing outside .meridian/runs.
test('an id that is not a plain task id is refused', () => {
    const dir = project();
    for (const bad of ['../../etc/passwd', 'a/b', '', null]) {
        assert.throws(() => runLogPath(dir, bad, new Date()));
    }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/run-log.test.js`
Expected: FAIL — `Cannot find module '../lib/run-log'`

- [ ] **Step 3: Implement the log**

Create `lib/run-log.js`:

```js
'use strict';

// Run output is written to a file as well as streamed.
//
// Streaming alone answers "what is it doing"; only a file answers "what did
// it do at 3am", and an operator opening the modal mid-run has already missed
// the beginning. Sits next to the existing .meridian/reports/ precedent.

const fs = require('node:fs');
const path = require('node:path');

// This id becomes a filename. It is validated at the endpoint and in
// lib/dispatch-command.js too; this is the layer that keeps a traversal from
// landing outside .meridian/runs.
const SAFE_ID = /^[A-Za-z0-9_.-]+$/;

function runsDir(projectPath) {
    return path.join(projectPath, '.meridian', 'runs');
}

// Colons are legal on the filesystems this runs on but make the name awkward
// to type and to complete, so the timestamp uses dashes throughout.
function stamp(now) {
    return now.toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-');
}

function runLogPath(projectPath, taskId, now) {
    if (typeof taskId !== 'string' || !SAFE_ID.test(taskId)) {
        throw new Error(`Unsafe task id for a run log: ${taskId}`);
    }
    return path.join(runsDir(projectPath), `${taskId}-${stamp(now)}.log`);
}

function appendRunLog(file, chunk) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, chunk);
}

// Newest first: the operator almost always wants the last run.
function listRunLogs(projectPath, taskId) {
    if (typeof taskId !== 'string' || !SAFE_ID.test(taskId)) return [];
    let names;
    try {
        names = fs.readdirSync(runsDir(projectPath));
    } catch (err) {
        return [];
    }
    return names
        .filter(n => n.startsWith(`${taskId}-`) && n.endsWith('.log'))
        .sort()
        .reverse()
        .map(n => path.join(runsDir(projectPath), n));
}

module.exports = { runLogPath, appendRunLog, listRunLogs };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/run-log.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Implement the runner in server.js**

Replace the two stubs from Task 7. The spawn, signals and timers are not unit-tested here — the spec says so, and Task 12 verifies them against a real board.

```js
const { dispatchOutcome } = require('./lib/dispatch-outcome');
const { dispatchEligibility } = require('./lib/dispatch-eligibility');
const { pullNext, isAuto, queueFor } = require('./lib/dispatch-queue');
const { runLogPath, appendRunLog } = require('./lib/run-log');
const { DISPATCH_TIMEOUT_MS } = require('./lib/dispatch-command');

// One in-flight run per project: { child, taskId, tool, startedAt, logFile }.
const running = new Map();

// SIGTERM lets the CLI end its session, which fires SessionEnd, which runs
// running-flag.sh, which clears `running` on the task and leaves a
// resume_context note. That is the same observable result as interrupting a
// session by hand — the behaviour the operator already knows. SIGKILL is
// strictly worse: no hook, so `running` stays stuck and no note is left. It
// is the fallback only.
const SIGKILL_GRACE_MS = 10000;

async function stopDispatch(projectPath) {
    const run = running.get(projectPath);
    if (!run) return false;
    try {
        run.child.kill('SIGTERM');
    } catch (err) {
        return false;
    }
    setTimeout(() => {
        if (running.get(projectPath) === run) {
            try { run.child.kill('SIGKILL'); } catch (e) { /* already gone */ }
        }
    }, SIGKILL_GRACE_MS);
    return true;
}

function sendDispatch(payload) {
    const line = `data: ${JSON.stringify({ type: 'dispatch', ...payload })}\n\n`;
    clients.forEach(c => { try { c.write(line); } catch (e) { /* gone */ } });
}

// Pulls one task and runs it, then calls itself. Re-entrant by design: every
// path that can free the repository calls it, and the guards below make the
// extra calls no-ops.
async function runDispatchLoop(projectPath) {
    if (running.has(projectPath)) return;

    const authProbe = await runTooling(PROBES.claude.ready, 10000);
    const authenticated = parseReadiness('claude', authProbe.stdout || authProbe.stderr, authProbe.code).ready;
    const liveSession = await liveSessionFor(projectPath);

    let taskId = pullNext(dispatchState, projectPath);
    if (!taskId && isAuto(dispatchState, projectPath)) {
        // Pulled at dispatch time, not snapshotted when auto was armed: a
        // task created a minute ago has to be able to join.
        const { tasks } = getTasks(projectPath);
        taskId = (workableTasks(tasks).find(t => !t.skip_auto_dispatch) || {}).id || null;
    }
    if (!taskId) return;

    const { tasks } = getTasks(projectPath);
    const verdict = dispatchEligibility({ taskId, tasks, authenticated, liveSession });
    if (!verdict.ok) {
        // Discarded with a visible reason, never re-queued at the back: a task
        // whose blocker never lands would spin forever, and re-enqueueing is
        // one click.
        lastRun.set(projectPath, { taskId, ok: false, reason: verdict.reason, endedAt: new Date().toISOString() });
        sendDispatch({ projectPath, taskId, state: 'refused', reason: verdict.reason });
        broadcastUpdate();
        return runDispatchLoop(projectPath);
    }

    const tool = 'claude';
    const command = dispatchCommand(tool, taskId);
    const startedAt = new Date();
    const logFile = runLogPath(projectPath, taskId, startedAt);

    // argv, no shell: the task id never reaches a shell to be interpreted.
    const child = require('child_process').spawn(command.argv[0], command.argv.slice(1), {
        cwd: projectPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0', CI: '1' }
    });

    const run = { child, taskId, tool, startedAt, logFile };
    running.set(projectPath, run);
    appendRunLog(logFile, `$ ${command.display}\n\n`);
    sendDispatch({ projectPath, taskId, state: 'started', command: command.display });
    broadcastUpdate();

    let stdout = '';
    const take = chunk => {
        const text = chunk.toString();
        stdout += text;
        appendRunLog(logFile, text);
        sendDispatch({ projectPath, taskId, state: 'output', chunk: text });
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);

    const killer = setTimeout(() => stopDispatch(projectPath), DISPATCH_TIMEOUT_MS);

    child.on('error', err => {
        appendRunLog(logFile, `\n[spawn failed] ${err.message}\n`);
    });

    child.on('close', code => {
        clearTimeout(killer);
        running.delete(projectPath);
        const outcome = dispatchOutcome({ stdout, code });
        appendRunLog(logFile, `\n[${outcome.ok ? 'ok' : 'failed'}] ${outcome.reason || outcome.summary}\n`);
        lastRun.set(projectPath, {
            taskId, tool,
            startedAt: startedAt.toISOString(),
            endedAt: new Date().toISOString(),
            exitCode: code,
            ok: outcome.ok,
            reason: outcome.reason
        });
        sendDispatch({ projectPath, taskId, state: outcome.ok ? 'done' : 'failed', reason: outcome.reason });
        broadcastUpdate();
        runDispatchLoop(projectPath);
    });
}
```

Then fill `dispatchBlockedReason` in `GET /api/status`. It is computed per request, so the board can explain a disabled button:

```js
    dispatchBlockedReason: running.has(project.path)
        ? `a run is in flight (${running.get(project.path).taskId})`
        : null,
```

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS, no regressions. The runner itself has no unit test — Task 12 verifies it.

- [ ] **Step 7: Commit**

```bash
git add server.js lib/run-log.js test/run-log.test.js
git commit -m "feat(dispatch): run one queued task per repo, logging to a file

Output is streamed over SSE and appended to .meridian/runs/, because
streaming alone answers what it is doing and only a file answers what it
did at 3am. Stopping sends SIGTERM so the CLI's SessionEnd hook clears
the running flag and leaves a resume note; SIGKILL is the fallback after
ten seconds and is strictly worse. A task failing its eligibility check
is discarded with a visible reason rather than re-queued, and the auto
mode pulls at dispatch time so new work can join."
```

---

### Task 9: `skip_auto_dispatch`

**Files:**
- Modify: `lib/tasks.js` — the writable-field list
- Modify: `plugin/plugins/meridian/references/schema.md:44` — insert in the field table
- Test: `test/tasks.test.js` — extend

**Interfaces:**
- Consumes: nothing
- Produces: the field, accepted on task update and read by the auto loop in Task 8

- [ ] **Step 1: Write the failing tests**

Add to `test/tasks.test.js`:

```js
// Excluded from Dispatch all, never from the card's own Dispatch: the
// operator's explicit act is not the same as the loop picking a task, the
// same principle as the spec_approval gate a machine never crosses alone.
test('skip_auto_dispatch survives a save and reload', () => {
    const dir = tempProject([{ id: 'T-1', status: 'backlog', skip_auto_dispatch: true }]);
    const { tasks } = getTasks(dir);
    assert.equal(tasks[0].skip_auto_dispatch, true);
});

test('a task without the field is included by default', () => {
    const dir = tempProject([{ id: 'T-1', status: 'backlog' }]);
    assert.equal(getTasks(dir).tasks[0].skip_auto_dispatch, undefined);
});
```

Use whatever `tempProject` helper `test/tasks.test.js` already defines; read the file first.

- [ ] **Step 2: Run to verify**

Run: `node --test test/tasks.test.js`
Expected: the round-trip test may already pass if `lib/tasks.js` preserves unknown fields. If it passes, note that in the commit and keep the test as the pin.

- [ ] **Step 3: Document the field**

In `plugin/plugins/meridian/references/schema.md`, insert after the `operator_feedback` row (line 44):

```markdown
| `skip_auto_dispatch` | boolean — exclude this task from `Dispatch all` and the auto loop. Absent means included. Does **not** block the card's own `Dispatch` | **operator only** — agents must not set or clear it |
```

And add below the table, near the note about the four server-stamped timestamps:

```markdown
`skip_auto_dispatch` is operator-owned, like `priority`. An agent must never
set or clear it: it records a human decision that this task is not for the
automatic loop. It is deliberately not named `auto_dispatch` — the
project-level flag says whether the loop runs, this says whether a task is
eligible, and one name for two things is a trap for whoever reads this next.
```

- [ ] **Step 4: Reload the plugin so a dispatched agent reads the new schema**

```bash
npm run plugin:reload
```

Expected: both CLIs report success. `agy plugin install` copies, so without this a dispatched agent reads the old schema.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/tasks.js test/tasks.test.js plugin/plugins/meridian/references/schema.md
git commit -m "feat(dispatch): add skip_auto_dispatch and document it as operator-owned

It excludes a task from the automatic loop but never from the card's own
Dispatch button, where the operator's act is explicit — the same
principle as the spec_approval gate. Named for the task rather than the
project so it cannot be confused with the project-level autoDispatch
flag."
```

---

### Task 10: The card's tri-state button

**Files:**
- Modify: `public/app.js` — the card renderer
- Modify: `public/styles.css`
- Modify: `lib/board.js` — add the label decision, with the inline copy in `app.js`
- Test: `test/board.test.js` — extend

**Interfaces:**
- Consumes: `queue` and `lastRun` from `GET /api/status`
- Produces: `dispatchButton(task, { queue, runningTaskId }) -> { action, label, title }`

One button whose label states which of the three situations the task is in. Enqueue is idempotent, so a double click cannot queue twice.

- [ ] **Step 1: Write the failing tests**

Add to `test/board.test.js`:

```js
const { dispatchButton } = require('../lib/board');

test('a task that is neither queued nor running offers dispatch', () => {
    const out = dispatchButton({ id: 'T-1', status: 'ready_todo' }, { queue: [], runningTaskId: null });
    assert.equal(out.action, 'dispatch');
    assert.match(out.label, /dispatch/i);
});

test('the running task offers stop', () => {
    const out = dispatchButton({ id: 'T-1', status: 'in_progress' }, { queue: [], runningTaskId: 'T-1' });
    assert.equal(out.action, 'stop');
    assert.match(out.label, /stop/i);
});

test('a queued task offers removal from the queue', () => {
    const out = dispatchButton({ id: 'T-2', status: 'backlog' }, { queue: ['T-2'], runningTaskId: 'T-1' });
    assert.equal(out.action, 'unqueue');
    assert.match(out.label, /queue/i);
});

// Running outranks queued: a task cannot be both, and if the state is ever
// inconsistent the honest button is the one that can stop the process.
test('running wins over queued', () => {
    const out = dispatchButton({ id: 'T-1' }, { queue: ['T-1'], runningTaskId: 'T-1' });
    assert.equal(out.action, 'stop');
});

// Terminal tasks have nothing to dispatch, and a button there is noise on a
// board with dozens of finished cards.
test('done and nope carry no button', () => {
    assert.equal(dispatchButton({ id: 'T-3', status: 'done' }, { queue: [], runningTaskId: null }), null);
    assert.equal(dispatchButton({ id: 'T-4', status: 'nope' }, { queue: [], runningTaskId: null }), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/board.test.js`
Expected: FAIL — `dispatchButton is not a function`

- [ ] **Step 3: Implement in lib/board.js**

```js
// Which of the three situations is this task in? One button, and its label
// says which — enqueue is idempotent anyway, so an accidental double click
// cannot queue a task twice.
//
// public/app.js carries an inline copy: the frontend has no module system.
// This file is the source of truth — change both.
const NO_DISPATCH = ['done', 'nope'];

function dispatchButton(task, { queue, runningTaskId }) {
    if (!task || NO_DISPATCH.includes(task.status)) return null;
    // Running outranks queued. A task cannot honestly be both, and if the
    // state ever disagrees the useful button is the one that stops a process.
    if (task.id === runningTaskId) {
        return { action: 'stop', label: 'Stop', title: 'Signal the running session (SIGTERM)' };
    }
    if ((queue || []).includes(task.id)) {
        return { action: 'unqueue', label: 'Remove from queue', title: 'Drop this task from the queue' };
    }
    return { action: 'dispatch', label: 'Dispatch', title: 'Queue this task; runs at once if the repo is free' };
}
```

Export it alongside the existing exports.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/board.test.js`
Expected: PASS

- [ ] **Step 5: Wire it into the card**

Copy `dispatchButton` and `NO_DISPATCH` inline into `public/app.js` next to the other inline copies, with the same "source of truth is lib/board.js" comment. In the card renderer, render the button when it is not null, carrying `data-dispatch-action`, `data-task-id` and `data-project`. Add one delegated click handler:

```js
document.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-dispatch-action]');
    if (!btn) return;
    const { dispatchAction: action, taskId, project } = btn.dataset;
    btn.disabled = true;
    try {
        if (action === 'dispatch') {
            await fetch('/api/projects/dispatch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectPath: project, taskId, tool: 'claude' })
            });
        } else if (action === 'unqueue') {
            await fetch(`/api/projects/dispatch/${encodeURIComponent(taskId)}?project=${encodeURIComponent(project)}`,
                { method: 'DELETE' });
        } else if (action === 'stop') {
            await fetch('/api/projects/dispatch/stop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectPath: project, taskId })
            });
        }
    } catch (err) {
        showFlashMessage('Could not reach the server', 'error');
    } finally {
        btn.disabled = false;
    }
    // The SSE broadcast re-renders; no optimistic update, so the board never
    // shows a queue position the server does not have.
});
```

Add a `.card-dispatch-btn` rule to `public/styles.css` matching the existing card button styling, and a queue-position badge rule.

- [ ] **Step 6: Verify in the browser**

Start the server, open a project, and check: a card shows `Dispatch`; clicking it turns the button into `Remove from queue`; clicking that returns it to `Dispatch`. Take a screenshot.

- [ ] **Step 7: Commit**

```bash
git add lib/board.js public/app.js public/styles.css test/board.test.js
git commit -m "feat(dispatch): put a tri-state dispatch button on the card

One button whose label states which of the three situations the task is
in. Running outranks queued, because if the two ever disagree the useful
button is the one that can stop a process. Terminal tasks carry none: on
a board with dozens of finished cards a dead button is noise."
```

---

### Task 11: The board header controls

**Files:**
- Modify: `public/index.html` — the board header
- Modify: `public/app.js`
- Modify: `public/styles.css`

`Dispatch all` follows the screen it is on: the project view arms that project, the global view arms every project with one control per row.

- [ ] **Step 1: Add the controls to the project header**

In `public/index.html`, beside the existing board header controls:

```html
<button type="button" id="dispatch-all-btn" class="secondary-btn">Dispatch all</button>
<button type="button" id="stop-queue-btn" class="secondary-btn hidden">Stop queue</button>
```

- [ ] **Step 2: Wire them**

In `public/app.js`:

```js
// `Stop queue` is named for what it does: it discards the queue rather than
// suspending it. A button labelled "Pause" that threw away queued work would
// be a trap.
async function setAutoDispatch(projectPath, enabled) {
    await fetch('/api/projects/dispatch/auto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, enabled })
    });
}

document.getElementById('dispatch-all-btn')?.addEventListener('click',
    () => setAutoDispatch(currentProjectPath, true));
document.getElementById('stop-queue-btn')?.addEventListener('click',
    () => setAutoDispatch(currentProjectPath, false));
```

Render exactly one of the two, from `autoDispatch` in the status payload, and show the queue length beside `Stop queue` when it is non-zero. When `dispatchBlockedReason` is set, disable `Dispatch all` and put the reason in its `title` — the spec's point is that a disabled button must explain itself rather than swallow the click.

- [ ] **Step 3: Add the per-row control to the global view**

In the project-row renderer of the global view, render the same pair per row, bound to that row's project path.

- [ ] **Step 4: Verify in the browser**

Arm `Dispatch all` on a project with an empty queue and confirm the button flips to `Stop queue`; press it and confirm the queue empties. Confirm the global view shows one control per row and that arming one project does not arm another. Screenshot both.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/app.js public/styles.css
git commit -m "feat(dispatch): add Dispatch all and Stop queue to the board header

Dispatch all follows the screen it is on — the project view arms that
project, the global view one control per row. Stop queue is named for
what it does: it discards the queue, and a button labelled Pause that
threw away queued work would be a trap. A blocked control states its
reason in the title rather than swallowing the click."
```

---

### Task 12: The run tab, and verifying the whole thing against a real board

**Files:**
- Modify: `server.js` — add `GET /api/projects/runs/:taskId`
- Modify: `public/index.html` — third modal tab beside `📄 Specification` and `🖥️ Interactive Mockup` (`public/index.html:282-283`)
- Modify: `public/app.js`

- [ ] **Step 1: Add the endpoint**

Extend the `lib/run-log` require added in Task 8 to bring in `listRunLogs`:

```js
const { runLogPath, appendRunLog, listRunLogs } = require('./lib/run-log');
```

Then, beside the other `/api/projects/*` routes:

```js
// The run log for one task, newest first. The full output is on disk; the
// one-line reason in /api/status is the summary, and this is what the
// operator opens when the summary is not enough.
app.get('/api/projects/runs/:taskId', (req, res) => {
    const projectPath = req.query.project;
    if (!registeredProject(projectPath)) {
        return res.status(400).json({ error: `Unknown project ${projectPath}` });
    }
    const files = listRunLogs(projectPath, req.params.taskId);
    if (files.length === 0) return res.json({ runs: [] });
    res.json({
        runs: files.slice(0, 5).map(file => ({
            name: path.basename(file),
            body: fs.readFileSync(file, 'utf8')
        }))
    });
});
```

- [ ] **Step 2: Add the tab**

In `public/index.html`, after the mockup tab:

```html
<button type="button" class="tm-tab" id="tm-tab-runs">▶️ Runs <span id="tm-runs-badge" class="tm-tab-pill hidden">Failed</span></button>
```

In `public/app.js`, load the tab's content from the endpoint when it is opened, and **lead with the failure reason above the log** when the last run for that task failed. The reason stays visible until the next run of that task: a failure must never leave the task looking untouched.

- [ ] **Step 3: Verify the log renders**

Open a task with no runs — the tab says so rather than erroring. Then run a dispatch and reopen it.

- [ ] **Step 4: Verify a real dispatch, in a scratch project**

Not on a live board. Create a throwaway project, register it, give it one trivial task, and dispatch it.

```bash
mkdir -p /tmp/dispatch-scratch/.meridian
cd /tmp/dispatch-scratch && git init -q && cp -R ~/workspace/meridian/.claude .
node ~/workspace/meridian/cli.js add /tmp/dispatch-scratch
```

Then, from the board: dispatch the task, and confirm each of these.

- [ ] Output streams into the modal while the run is in flight
- [ ] `.meridian/runs/<id>-<timestamp>.log` exists and holds the same output
- [ ] The card shows the task as running
- [ ] `claude agents --json --cwd /tmp/dispatch-scratch` lists the background session
- [ ] A second dispatch on the same project is refused with the repo-lock reason
- [ ] `Stop` ends the run, and `running` is cleared on the task by the hook
- [ ] A `resume_context` note was written
- [ ] The run tab shows the outcome
- [ ] Dispatch a task with an unmet blocker and confirm it is discarded from the queue with the blocker named
- [ ] Deliberately run a command outside the allowlist and confirm the translated allowlist reason appears

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server.js public/index.html public/app.js public/styles.css
git commit -m "feat(dispatch): add the run tab and verify a dispatch end to end

The tab leads with the failure reason above the log and keeps it until
the task runs again, so a failed dispatch never leaves a task looking
untouched. Verified against a scratch project rather than a live board:
streaming, the log file, the repo lock, SIGTERM clearing the running
flag through the hook, a discarded ineligible task, and the translated
allowlist failure."
```

---

## Self-review

**Spec coverage.** Every section maps to a task: allowlist → 1; in-memory state and the no-`queued`-field rule → 2; eligibility including the blocked-behind-blocker case → 3; the CLI invocation, no sandbox and the raised timeout → 4; structured failure detection and the two translations → 5; the derived one-per-repo lock → 6; the five API endpoints and the three status fields → 7; the runner, SIGTERM-then-SIGKILL, run logs, the auto mode pulling at dispatch time → 8; `skip_auto_dispatch` and `schema.md` → 9; the tri-state card control → 10; `Dispatch all` / `Stop queue` on both screens → 11; the run tab and end-to-end verification → 12.

**Deliberately not covered**, matching the spec's own "Out of scope": a global concurrency cap, pausing between stages of one task, and persisting the queue across restarts.

**One gap the spec leaves open and this plan resolves.** The spec's control table says `Dispatch (claude | agy)`, implying a tool choice per card, but never says where it lives. Task 10 hardcodes `claude` in the card handler and Task 4 already supports both. Add the selector when the second CLI is actually wanted; building a picker before then is a control with one real option.

**Type consistency.** `dispatchEligibility` takes `taskId`, not `task`, in both its definition and its call site in Task 8. `queueFor` returns a copy everywhere. `dispatchButton` is spelled the same in `lib/board.js` and its inline copy. `lastRun` is a `Map` keyed by project path in Tasks 7 and 8, and the shape it stores matches what Task 12 reads.
