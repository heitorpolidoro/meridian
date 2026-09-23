const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeDispatchLock, pidIsAlive } = require('../lib/dispatch-lock');

// Ports are allocated deterministically per file, from a base no other test
// file uses. They used to be drawn at random from one shared 500-wide range,
// which collided: a second server on a taken port never binds, never answers,
// and times out no matter how long the startup budget is.
const PORT_BASE = 3700;
let nextPort = PORT_BASE;

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

// A PATH containing exactly one executable: node.
//
// These tests drive the real dispatch endpoints, and those start the real
// loop, which probes the CLI and — on a machine where `claude` is installed
// and authenticated — would spawn an actual agent run inside the temp
// fixture project. Making the CLI unreachable by name is the only thing
// that prevents that reliably, and it does so without a test-only switch in
// server.js: the production path still runs, the probes fail with ENOENT,
// readiness reads false and eligibility refuses.
//
// It is a directory of our own with node symlinked into it, not node's own
// directory: `@anthropic-ai/claude-code` also ships on npm, and an
// npm-global install puts `claude` right next to the node binary, which
// would silently defeat a scrub that kept that directory on the PATH.
// Nothing is reachable by name here except what we put in.
//
// The cost is that the authenticated branch of the loop is not covered
// here. It is not covered anywhere: the spawn, the signalling and the UI
// are verified by hand against a scratch board in the last task of this
// plan.
const NODE_ONLY_BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-nodeonly-'));
fs.symlinkSync(process.execPath, path.join(NODE_ONLY_BIN, 'node'));
process.on('exit', () => {
    try { fs.rmSync(NODE_ONLY_BIN, { recursive: true, force: true }); } catch { /* going away anyway */ }
});

async function withServer(ws, fn) {
    const port = nextPort++;
    const proc = require('node:child_process').spawn('node', ['server.js'], {
        env: { ...process.env, PATH: NODE_ONLY_BIN, PORT: String(port), MERIDIAN_RUNNING_DIR: ws },
        cwd: path.join(__dirname, '..'),
        stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    proc.stderr.on('data', chunk => { stderr += chunk; });
    try {
        let ready = false;
        for (let i = 0; i < 250; i++) {
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

// Waits for the loop to record a run, then for it to go quiet. The loop is
// async: an assertion made right after the POST is a race, which is how the
// queue-shape tests below used to pass against a CLI that was merely slow.
// A pass is milliseconds long here — the probes fail with ENOENT — so once a
// refusal is recorded and nothing changes for a further beat, the queue has
// settled and can be asserted on exactly.
async function settled(base, dir) {
    for (let i = 0; i < 200; i++) {
        const p = projectIn(await json(base, '/api/status'), dir);
        if (p.lastRun) break;
        await new Promise(r => setTimeout(r, 50));
    }
    await new Promise(r => setTimeout(r, 300));
    const p = projectIn(await json(base, '/api/status'), dir);
    assert.ok(p.lastRun, 'the loop never recorded a run');
    return p;
}

// The ruling these three depend on: with no CLI reachable the refusal is
// `environment`-scoped, so the loop puts the task back at the front and
// leaves the queue exactly as the operator built it. If an environment
// refusal ever starts draining the queue again, all three fail here rather
// than in front of an operator who lost their queue to a logged-out CLI.
test('POST dispatch enqueues and the queue shows in status, in order', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    await withServer(ws, async base => {
        await post(base, '/api/projects/dispatch', { projectPath: dir, taskId: 'TST-1', tool: 'claude' });
        await post(base, '/api/projects/dispatch', { projectPath: dir, taskId: 'TST-2', tool: 'claude' });
        assert.deepEqual((await settled(base, dir)).queue, ['TST-1', 'TST-2']);
    });
});

test('dispatching the same task twice queues it once', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    await withServer(ws, async base => {
        await post(base, '/api/projects/dispatch', { projectPath: dir, taskId: 'TST-1', tool: 'claude' });
        await post(base, '/api/projects/dispatch', { projectPath: dir, taskId: 'TST-1', tool: 'claude' });
        assert.deepEqual((await settled(base, dir)).queue, ['TST-1']);
    });
});

test('DELETE removes one task from the queue', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    await withServer(ws, async base => {
        await post(base, '/api/projects/dispatch', { projectPath: dir, taskId: 'TST-1', tool: 'claude' });
        await post(base, '/api/projects/dispatch', { projectPath: dir, taskId: 'TST-2', tool: 'claude' });
        await settled(base, dir);
        await fetch(`${base}/api/projects/dispatch/TST-1?project=${encodeURIComponent(dir)}`,
            { method: 'DELETE' });
        assert.deepEqual(projectIn(await json(base, '/api/status'), dir).queue, ['TST-2']);
    });
});

// Kept from fix round 1: it is the only test that pins what the operator
// actually sees when a dispatch cannot run — a reason, not silence — and the
// only one asserting that the refused task survives its own refusal.
test('an unrunnable dispatch is refused with a visible reason and keeps its place', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    await withServer(ws, async base => {
        await post(base, '/api/projects/dispatch', { projectPath: dir, taskId: 'TST-1', tool: 'claude' });
        const p = await settled(base, dir);
        assert.equal(p.lastRun.taskId, 'TST-1');
        assert.equal(p.lastRun.ok, false);
        assert.match(p.lastRun.reason, /authenticated/);
        assert.deepEqual(p.queue, ['TST-1'], 'an environment refusal must not cost the operator the queue');
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

// Fix round 1: isRegisteredProject calls path.resolve unconditionally and
// throws a TypeError on anything but a string, so a missing/non-string
// project value must be refused before it reaches that call — on every
// route, not just the one whose brief tests happened to cover it.
test('DELETE with no ?project= is refused, not a 500', async () => {
    const { ws } = workspaceWith(TASKS);
    await withServer(ws, async base => {
        const res = await fetch(`${base}/api/projects/dispatch/TST-1`, { method: 'DELETE' });
        assert.equal(res.status, 400);
    });
});

test('auto with no projectPath is refused, not a 500', async () => {
    const { ws } = workspaceWith(TASKS);
    await withServer(ws, async base => {
        const res = await post(base, '/api/projects/dispatch/auto', { enabled: true });
        assert.equal(res.status, 400);
    });
});

// Stop never signals a session Meridian did not start, so it can answer
// "nothing stopped" — but it must still say so. The board only flashes a
// message when `reason` is truthy, so a null reason here is a click that
// visibly does nothing, which is exactly the swallowed click the design
// objected to. With no CLI reachable and no lock file, the honest reason is
// that there was nothing to stop.
test('stop with nothing running says so instead of returning a null reason', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    await withServer(ws, async base => {
        const body = await (await post(base, '/api/projects/dispatch/stop', { projectPath: dir })).json();
        assert.equal(body.ok, true);
        assert.equal(body.stopped, false);
        assert.match(body.reason, /nothing is running/i);
    });
});

// A run this server started before it was restarted is invisible to both the
// in-memory `running` map and `claude agents --json`; only the pid lock file
// sees it. Stop must name it, and name the pid, rather than report the repo
// as idle while an agent is still editing it.
test('stop reports a live run left behind by a previous server process', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    // This test process is unambiguously alive, so the lock reads as held.
    writeDispatchLock(dir, {
        pid: process.pid, taskId: 'T-1', startedAt: new Date().toISOString()
    });
    await withServer(ws, async base => {
        const body = await (await post(base, '/api/projects/dispatch/stop', { projectPath: dir })).json();
        assert.equal(body.stopped, false);
        assert.match(body.reason, /previous server process/i);
        assert.match(body.reason, new RegExp(String(process.pid)));
        assert.match(body.reason, /T-1/);
    });
});

// A lock whose pid is gone is not a lock. It releases itself on the next
// read, so Stop falls through to the ordinary "nothing to stop".
test('a stale lock from a dead process does not make stop claim a run', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    let pid = 60000;
    while (pidIsAlive(pid)) pid++;
    writeDispatchLock(dir, { pid, taskId: 'T-1', startedAt: new Date().toISOString() });
    await withServer(ws, async base => {
        const body = await (await post(base, '/api/projects/dispatch/stop', { projectPath: dir })).json();
        assert.equal(body.stopped, false);
        assert.match(body.reason, /nothing is running/i);
    });
});

test('stop with no projectPath is refused, not a 500', async () => {
    const { ws } = workspaceWith(TASKS);
    await withServer(ws, async base => {
        const res = await post(base, '/api/projects/dispatch/stop', {});
        assert.equal(res.status, 400);
    });
});

test('dispatch with no projectPath is refused, not a 500', async () => {
    const { ws } = workspaceWith(TASKS);
    await withServer(ws, async base => {
        const res = await post(base, '/api/projects/dispatch', { taskId: 'TST-1', tool: 'claude' });
        assert.equal(res.status, 400);
    });
});

test('a non-string projectPath is refused, not a 500', async () => {
    const { ws } = workspaceWith(TASKS);
    await withServer(ws, async base => {
        const res = await post(base, '/api/projects/dispatch/auto', { projectPath: 42, enabled: true });
        assert.equal(res.status, 400);
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

// Task 13: a fixture project starts with no .claude/settings.json at all, so
// the status payload must offer to create one and must explain why dispatch
// is blocked in the meantime.
test('status reports canCreateAllowlist and the no-allowlist reason for a fresh project', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    await withServer(ws, async base => {
        const p = projectIn(await json(base, '/api/status'), dir);
        assert.equal(p.canCreateAllowlist, true);
        assert.match(p.dispatchBlockedReason, /no dispatch allowlist/);
        // The card's Dispatch button reads this field, never the overloaded
        // reason string, so the header and the card agree about one gate.
        assert.equal(p.dispatchGateBlocked, true);
    });
});

// The allowlist is the gate, and writing one opens it — for the card button
// as much as for the header's `Dispatch all`.
test('a repository with an allowlist reports an open dispatch gate', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, '.claude', 'settings.json'),
        JSON.stringify({ permissions: { allow: ['Bash(npm test:*)'] } })
    );
    await withServer(ws, async base => {
        const p = projectIn(await json(base, '/api/status'), dir);
        assert.equal(p.dispatchGateBlocked, false);
        assert.equal(p.dispatchBlockedReason, null);
    });
});

test('POST allowlist writes a starting settings.json and reports the detected runner', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    await withServer(ws, async base => {
        const res = await post(base, '/api/projects/allowlist', { projectPath: dir });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.runner, 'npm test');
        assert.equal(body.merged, false, 'a brand new file is created, not merged');
        const settingsPath = path.join(dir, '.claude', 'settings.json');
        assert.equal(body.path, settingsPath);
        const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        assert.ok(written.permissions.allow.includes('Bash(npm test)'));
        assert.ok(fs.readFileSync(settingsPath, 'utf8').endsWith('\n'));

        // canCreateAllowlist must flip off, and the blocked reason must
        // clear, once the file exists.
        const p = projectIn(await json(base, '/api/status'), dir);
        assert.equal(p.canCreateAllowlist, false);
        assert.equal(p.dispatchBlockedReason, null);
    });
});

test('POST allowlist reports a null runner when none is detected', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    await withServer(ws, async base => {
        const body = await (await post(base, '/api/projects/allowlist', { projectPath: dir })).json();
        assert.equal(body.runner, null);
    });
});

// Fix round 2: a real project's `.claude/settings.json` predated the allowlist
// feature — it holds only `enabledPlugins`, no `permissions` key at all.
// That file is not one the operator wrote to refuse dispatch; the old rule
// (canCreateAllowlist only when the file is wholly absent) blocked a project
// like this from ever getting an allowlist through the board. The correct
// rule merges into a file like this rather than refusing it, and every key
// already there must survive byte-for-byte in meaning.
test('POST allowlist merges into a settings.json that has no permissions key at all (pre-existing settings shape)', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: { meridian: true } }));
    await withServer(ws, async base => {
        const res = await post(base, '/api/projects/allowlist', { projectPath: dir });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.merged, true);
        const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        // The unrelated key survives, and permissions was added.
        assert.deepEqual(written.enabledPlugins, { meridian: true });
        assert.ok(Array.isArray(written.permissions.allow));
        assert.ok(written.permissions.allow.some(e => e.startsWith('Bash(git ')));

        // canCreateAllowlist must flip off, and the blocked reason must
        // clear, once the merge lands.
        const p = projectIn(await json(base, '/api/status'), dir);
        assert.equal(p.canCreateAllowlist, false);
        assert.equal(p.dispatchBlockedReason, null);
    });
});

// An empty allow array is not an allowlist the operator wrote to block
// dispatch — it is indistinguishable from a file that never mentioned
// permissions at all, so the endpoint merges here too.
test('POST allowlist merges into a settings.json with an empty allow array', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: [] } }));
    await withServer(ws, async base => {
        const res = await post(base, '/api/projects/allowlist', { projectPath: dir });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.merged, true);
        const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        assert.ok(written.permissions.allow.length > 0);
    });
});

// A `permissions.deny` with no `allow` is not an allowlist either, but its
// deny entries are the operator's own and must survive the merge, unioned
// with whatever Meridian's template denies rather than replaced by it.
test('POST allowlist keeps an existing permissions.deny and unions it with the generated one', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { deny: ['Bash(rm -rf /)'] } }));
    await withServer(ws, async base => {
        const res = await post(base, '/api/projects/allowlist', { projectPath: dir });
        assert.equal(res.status, 200);
        const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        assert.ok(written.permissions.deny.includes('Bash(rm -rf /)'), 'the operator\'s own deny entry must survive');
        assert.ok(written.permissions.allow.length > 0);
    });
});

// The one case this endpoint must never touch: a file that already declares
// a real, non-empty allowlist. It refuses with 409 and leaves the file byte
// for byte as it was, and the result is still valid, round-trippable JSON.
test('POST allowlist refuses a settings.json with a non-empty allow list, leaving it byte-identical', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    const original = '{\n  "permissions": {\n    "allow": ["Bash(echo operator-owned-marker)"]\n  }\n}\n';
    fs.writeFileSync(settingsPath, original);
    await withServer(ws, async base => {
        const res = await post(base, '/api/projects/allowlist', { projectPath: dir });
        assert.equal(res.status, 409);
        const body = await res.json();
        assert.equal(body.error, '.claude/settings.json already has a dispatch allowlist');
        assert.equal(fs.readFileSync(settingsPath, 'utf8'), original, 'the write must not have touched the file at all');
    });
});

test('POST allowlist for an unregistered project is refused', async () => {
    const { ws } = workspaceWith(TASKS);
    await withServer(ws, async base => {
        const res = await post(base, '/api/projects/allowlist', { projectPath: '/etc' });
        assert.equal(res.status, 400);
    });
});

test('POST allowlist with no projectPath is refused, not a 500', async () => {
    const { ws } = workspaceWith(TASKS);
    await withServer(ws, async base => {
        const res = await post(base, '/api/projects/allowlist', {});
        assert.equal(res.status, 400);
    });
});

// A file the operator wrote with a real allowlist is not ours to complete:
// canCreateAllowlist must stay false only for that one case. Absent,
// missing `permissions`, and empty `allow` all still offer to create/merge.
test('canCreateAllowlist is false only once a non-empty allow list exists', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'),
        JSON.stringify({ permissions: { allow: [] } }));
    await withServer(ws, async base => {
        const p = projectIn(await json(base, '/api/status'), dir);
        assert.equal(p.canCreateAllowlist, true);
        assert.match(p.dispatchBlockedReason, /no dispatch allowlist/);
    });
});

// A task-scoped refusal discards the task from the queue outright, so the
// only surface left carrying the reason once the flash message fades is the
// card itself — not a DOM test (this repo has no browser harness and adds
// none here), just a smoke check that the served bundle still carries the
// pieces that make that possible: the badge rendered for a no-longer-queued
// task, its dismiss control, and the `refusals` fallback a multi-candidate
// auto-dispatch pass relies on to keep more than one reason visible.
test('GET /app.js carries the refusal badge, its dismiss control, and the refusals fallback', async () => {
    const { ws } = workspaceWith(TASKS);
    await withServer(ws, async base => {
        const res = await fetch(`${base}/app.js`);
        const body = await res.text();
        assert.match(body, /task-queue-badge--refused/);
        assert.match(body, /data-clear-refusal/);
        assert.match(body, /dismissedRefusals/);
        assert.match(body, /lastRun\.refusals/);
    });
});

// The aggregated all-tickets view has no single project of its own to arm,
// so its `Dispatch all` control has to arm every registered project through
// the existing per-project endpoint, once each — no bulk endpoint was
// added. Same "no browser harness" smoke check as above: it pins the pieces
// that make the behaviour work rather than driving a real DOM.
test('GET /app.js carries a global Dispatch all/Stop queue that acts on every registered project', async () => {
    const { ws } = workspaceWith(TASKS);
    await withServer(ws, async base => {
        const res = await fetch(`${base}/app.js`);
        const body = await res.text();
        // Wired from the aggregated view instead of hiding the header
        // controls the way the single-project code path used to.
        assert.match(body, /updateGlobalDispatchHeaderControls/);
        assert.match(body, /confirmDispatchAllProjects/);
        assert.match(body, /stopAllProjects/);
        // The confirmation must be explicit that it arms several projects
        // and must name how many, not reuse the single-project wording.
        assert.match(body, /eligible\.length/);
        assert.match(body, /unattended/);
        // A gated project (no dispatch allowlist) is skipped, not silently
        // dropped, and the result reports both counts.
        assert.match(body, /dispatchBlockedReason/);
        assert.match(body, /no dispatch allowlist/);
        assert.match(body, /skipped/);
        // Reuses POST /api/projects/dispatch/auto per project; no new bulk
        // route exists to arm or disarm every project in one call.
        assert.match(body, /\/api\/projects\/dispatch\/auto/);
        // Review finding: counting any resolved fetch as armed overstated
        // the count on a non-2xx response. Only res.ok may count as armed,
        // and a failure (network throw or a bad HTTP status alike) is
        // reported by name rather than folded into "armed" or "gated".
        assert.match(body, /res\.ok/);
        assert.match(body, /failed/);
    });
});

// --- Fix allowlist: the drift a project cannot notice on its own ---
//
// The deny list is read from THIS repository's settings at generation time,
// never copied, so a project generated before a deny entry existed keeps the
// older list forever. These cover the board seeing that, and the one intent
// that is allowed to close it.

const { allowlistFor, detectRunner } = require('../lib/allowlist-template');

// A settings.json that is a real allowlist but predates part of the template.
function settingsMissing(dir, { dropAllow = 0, dropDeny = 0 } = {}) {
    const want = allowlistFor(detectRunner(dir)).permissions;
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    const settings = {
        permissions: {
            allow: want.allow.slice(dropAllow),
            deny: want.deny.slice(dropDeny)
        }
    };
    // Keep it a real allowlist even when everything generated was dropped.
    if (!settings.permissions.allow.length) settings.permissions.allow = ['Bash(echo operator-owned)'];
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'),
        JSON.stringify(settings, null, 2) + '\n');
    return path.join(dir, '.claude', 'settings.json');
}

const projectOf = async (base, dir) =>
    (await (await fetch(`${base}/api/status?project=${encodeURIComponent(dir)}`)).json()).projects[0];

test('status reports no allowlistDrift for a complete allowlist', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    settingsMissing(dir);
    await withServer(ws, async base => {
        const proj = await projectOf(base, dir);
        assert.equal(proj.allowlistDrift, null);
        assert.equal(proj.canCreateAllowlist, false);
    });
});

test('status reports what an incomplete allowlist is missing', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    settingsMissing(dir, { dropDeny: 2 });
    await withServer(ws, async base => {
        const proj = await projectOf(base, dir);
        assert.ok(proj.allowlistDrift, 'the board must be able to offer the fix');
        assert.equal(proj.allowlistDrift.total, 2);
        assert.equal(proj.allowlistDrift.missingDeny.length, 2);
        assert.deepEqual(proj.allowlistDrift.missingAllow, []);
    });
});

test('an operator addition is never reported as drift', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    const settingsPath = settingsMissing(dir);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings.permissions.allow.push('Bash(docker compose up:*)');
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    await withServer(ws, async base => {
        assert.equal((await projectOf(base, dir)).allowlistDrift, null);
    });
});

test('fix: true adds the missing entries and keeps everything else', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    const settingsPath = settingsMissing(dir, { dropDeny: 2 });
    const before = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    before.permissions.allow.push('Bash(docker compose up:*)');
    before.enabledPlugins = { 'something@somewhere': true };
    fs.writeFileSync(settingsPath, JSON.stringify(before, null, 2) + '\n');

    await withServer(ws, async base => {
        const res = await post(base, '/api/projects/allowlist', { projectPath: dir, fix: true });
        assert.equal(res.status, 200);

        const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        const want = allowlistFor(detectRunner(dir)).permissions;
        for (const entry of want.deny) assert.ok(after.permissions.deny.includes(entry), `deny ${entry}`);
        assert.ok(after.permissions.allow.includes('Bash(docker compose up:*)'),
            "the operator's own entry survives");
        assert.deepEqual(after.enabledPlugins, { 'something@somewhere': true },
            'unrelated keys in the file are untouched');
        assert.equal(new Set(after.permissions.deny).size, after.permissions.deny.length,
            'no duplicates');

        assert.equal((await projectOf(base, dir)).allowlistDrift, null, 'the button goes away');
    });
});

test('fix: true on a complete allowlist changes nothing', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    const settingsPath = settingsMissing(dir);
    const original = fs.readFileSync(settingsPath, 'utf8');
    await withServer(ws, async base => {
        assert.equal((await post(base, '/api/projects/allowlist', { projectPath: dir, fix: true })).status, 200);
        assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))),
            JSON.stringify(JSON.parse(original)), 'idempotent');
    });
});

test('without fix: true an existing allowlist is still refused', async () => {
    // The blind create keeps its 409: completing a file the operator wrote,
    // without their having asked for exactly that, is not Meridian's call.
    const { ws, dir } = workspaceWith(TASKS);
    const settingsPath = settingsMissing(dir, { dropDeny: 2 });
    const original = fs.readFileSync(settingsPath, 'utf8');
    await withServer(ws, async base => {
        const res = await post(base, '/api/projects/allowlist', { projectPath: dir });
        assert.equal(res.status, 409);
        assert.equal(fs.readFileSync(settingsPath, 'utf8'), original);
    });
});

test('fix: true still refuses a malformed settings.json', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    fs.writeFileSync(settingsPath, '{ not json');
    await withServer(ws, async base => {
        const res = await post(base, '/api/projects/allowlist', { projectPath: dir, fix: true });
        assert.equal(res.status, 409);
        assert.equal(fs.readFileSync(settingsPath, 'utf8'), '{ not json');
        assert.equal((await projectOf(base, dir)).allowlistDrift, null,
            'nothing is missing from a file nobody can read');
    });
});
