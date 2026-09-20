const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

// A PATH that finds node and nothing else that matters: `claude` and `agy`
// must be unreachable from the server these tests spawn.
//
// These tests drive the real dispatch endpoints, and those start the real
// loop, which probes the CLI and — on a machine where `claude` is installed
// and authenticated — would spawn an actual agent run inside the temp
// fixture project. Today the suite only escapes that by winning a race: the
// probes take about a second and the server is killed first. Making the CLI
// unreachable is the only thing that prevents it reliably, and it does so
// without a test-only switch in server.js: the production path still runs,
// the probes fail with ENOENT, readiness reads false and eligibility
// refuses.
//
// The cost is that the authenticated branch of the loop is not covered here.
// It is not covered anywhere: the spawn, the signalling and the UI are
// verified by hand against a scratch board in the last task of this plan.
const NO_CLI_PATH = [
    path.dirname(process.execPath),
    '/usr/bin', '/bin', '/usr/sbin', '/sbin'
].join(path.delimiter);

async function withServer(ws, fn) {
    const port = nextPort++;
    const proc = require('node:child_process').spawn('node', ['server.js'], {
        env: { ...process.env, PATH: NO_CLI_PATH, PORT: String(port), MERIDIAN_RUNNING_DIR: ws },
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
// "nothing stopped". With no CLI reachable there is no live session to
// report either, so the reason is empty rather than invented.
test('stop with nothing running answers honestly rather than pretending', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    await withServer(ws, async base => {
        const body = await (await post(base, '/api/projects/dispatch/stop', { projectPath: dir })).json();
        assert.equal(body.ok, true);
        assert.equal(body.stopped, false);
        assert.equal(body.reason, null);
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
