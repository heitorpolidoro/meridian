const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeDispatchLock, pidIsAlive } = require('../lib/dispatch-lock');

// Integration coverage for the stale-`running` detection exposed on
// GET /api/status, and for the PUT guard that lets the board clear it.
// The pure decision itself is unit-tested in test/stale-running.test.js —
// this file only checks that server.js wires it up correctly end to end.

const PORT_BASE = 3900;
let nextPort = PORT_BASE;

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

// A PATH containing exactly one executable: node. Copied from
// test/api-dispatch.test.js — see its comment for why this is the reliable
// way to make `claude agents --json` unreachable (ENOENT) rather than a
// test-only switch in server.js. That failure reads as "no live session
// anywhere", which is exactly the case this suite wants held constant so
// only the dispatch lock decides whether a task is claimed.
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

const put = (base, dir, taskId, body) => fetch(`${base}/api/projects/tasks/${taskId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: dir, ...body })
});

const statusFor = async (base, dir) => {
    const res = await (await fetch(`${base}/api/status?project=${encodeURIComponent(dir)}`)).json();
    return res.projects[0];
};

const TASKS = [
    { id: 'TST-1', title: 'stuck', status: 'in_progress', running: true, created_at: '2026-01-01T00:00:00Z' },
    { id: 'TST-2', title: 'idle', status: 'backlog', running: false, created_at: '2026-01-02T00:00:00Z' }
];

test('a running: true task with no dispatch lock and no live session reads as staleRunning', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    await withServer(ws, async (base) => {
        const proj = await statusFor(base, dir);
        const t1 = proj.tasks.find(t => t.id === 'TST-1');
        const t2 = proj.tasks.find(t => t.id === 'TST-2');
        assert.equal(t1.staleRunning, true, 'running with nothing behind it is stale');
        assert.equal(t2.staleRunning, false, 'a task that is not running is never stale');
    });
});

test('a dispatch lock naming the task with a live pid means it is claimed, not stale', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    // This test process is unambiguously alive, so the lock reads as held.
    writeDispatchLock(dir, { pid: process.pid, taskId: 'TST-1', startedAt: new Date().toISOString() });
    await withServer(ws, async (base) => {
        const proj = await statusFor(base, dir);
        const t1 = proj.tasks.find(t => t.id === 'TST-1');
        assert.equal(t1.staleRunning, false);
    });
});

test('a lock left by a dead process does not claim the task — still stale', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    let deadPid = 60000;
    while (pidIsAlive(deadPid)) deadPid++;
    writeDispatchLock(dir, { pid: deadPid, taskId: 'TST-1', startedAt: new Date().toISOString() });
    await withServer(ws, async (base) => {
        const proj = await statusFor(base, dir);
        const t1 = proj.tasks.find(t => t.id === 'TST-1');
        assert.equal(t1.staleRunning, true);
    });
});

test('the clear-stale PUT succeeds on a genuinely stale task and clears running', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    await withServer(ws, async (base) => {
        const res = await put(base, dir, 'TST-1', { running: false, clearStale: true });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.task.running, false);

        const proj = await statusFor(base, dir);
        const t1 = proj.tasks.find(t => t.id === 'TST-1');
        assert.equal(t1.running, false);
    });
});

test('the clear-stale PUT refuses when the task is claimed by a live dispatch lock', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    writeDispatchLock(dir, { pid: process.pid, taskId: 'TST-1', startedAt: new Date().toISOString() });
    await withServer(ws, async (base) => {
        const res = await put(base, dir, 'TST-1', { running: false, clearStale: true });
        assert.equal(res.status, 409);
        const body = await res.json();
        assert.match(body.error, /TST-1/);

        // The flag must be left exactly as it was — refused, not partially applied.
        const proj = await statusFor(base, dir);
        const t1 = proj.tasks.find(t => t.id === 'TST-1');
        assert.equal(t1.running, true);
    });
});

test('clearStale without running: false is refused with a 400, not silently accepted', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    await withServer(ws, async (base) => {
        const res = await put(base, dir, 'TST-1', { running: true, clearStale: true });
        assert.equal(res.status, 400);
    });
});

test('an ordinary running: false write (no clearStale) is unaffected by the guard', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    // Even claimed by a live lock, a plain write must go through — this is
    // the plugin's own stop hook's path, which never sends clearStale.
    writeDispatchLock(dir, { pid: process.pid, taskId: 'TST-1', startedAt: new Date().toISOString() });
    await withServer(ws, async (base) => {
        const res = await put(base, dir, 'TST-1', { running: false });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.task.running, false);
    });
});

// --- running_session: recorded with the flag, honoured by the verdict ---
//
// The `claude agents --json` probe is unreachable in this suite (see
// NODE_ONLY_BIN above), which now reads as "the probe failed", NOT as "no
// sessions exist". That distinction is the point of these tests: a task that
// names its owning session must not be declared stale on evidence the server
// could not gather.

test('a PUT recording running_session stores it, and running: false drops it', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    await withServer(ws, async (base) => {
        const set = await put(base, dir, 'TST-2', { running: true, running_session: 'sess-xyz' });
        assert.equal(set.status, 200);
        assert.equal((await set.json()).task.running_session, 'sess-xyz');

        // It must survive a write that does not mention it.
        const touch = await put(base, dir, 'TST-2', { priority: 'high' });
        assert.equal((await touch.json()).task.running_session, 'sess-xyz');

        // Clearing the flag clears its owner; an orphan id would be read by
        // the next setter that forgets to send one.
        const clear = await put(base, dir, 'TST-2', { running: false });
        assert.equal((await clear.json()).task.running_session, undefined);
    });
});

test('a non-string running_session is refused rather than silently ignored', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    await withServer(ws, async (base) => {
        const res = await put(base, dir, 'TST-2', { running: true, running_session: 42 });
        assert.equal(res.status, 400);
        assert.match((await res.json()).error, /running_session/);
    });
});

test('a task naming a session is not stale while the probe cannot see the session list', async () => {
    const tasks = [{ ...TASKS[0], running_session: 'sess-abc' }, TASKS[1]];
    const { ws, dir } = workspaceWith(tasks);
    await withServer(ws, async (base) => {
        const proj = await statusFor(base, dir);
        assert.equal(proj.tasks.find(t => t.id === 'TST-1').staleRunning, false,
            'a failed probe is not evidence the session ended');

        // And the guard on the clear button agrees, so the flag cannot be
        // cleared out from under a session the server merely failed to see.
        const res = await put(base, dir, 'TST-1', { running: false, clearStale: true });
        assert.equal(res.status, 409);
    });
});

test('running_agent is stored with the session and dropped with it', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    await withServer(ws, async (base) => {
        const set = await put(base, dir, 'TST-2', {
            running: true, running_session: 'conv-1', running_agent: 'agy'
        });
        const body = await set.json();
        assert.equal(body.task.running_agent, 'agy');

        // Owned by a harness the server cannot enumerate, so no verdict.
        const proj = await statusFor(base, dir);
        assert.equal(proj.tasks.find(t => t.id === 'TST-2').staleRunning, false);

        const cleared = await put(base, dir, 'TST-2', { running: false });
        const after = (await cleared.json()).task;
        assert.equal(after.running_agent, undefined);
        assert.equal(after.running_session, undefined);
    });
});

test('an owner cannot outlive the session id it belongs to', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    await withServer(ws, async (base) => {
        await put(base, dir, 'TST-2', { running: true, running_session: 'conv-1', running_agent: 'agy' });
        const res = await put(base, dir, 'TST-2', { running: true, running_session: '' });
        const task = (await res.json()).task;
        assert.equal(task.running_session, undefined);
        assert.equal(task.running_agent, undefined, 'naming a harness for a session that is gone says nothing');
    });
});

test('a non-string running_agent is refused', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    await withServer(ws, async (base) => {
        const res = await put(base, dir, 'TST-2', { running: true, running_agent: 7 });
        assert.equal(res.status, 400);
        assert.match((await res.json()).error, /running_agent/);
    });
});

// --- the Clear button for a harness Meridian cannot check ---

test('an agy flag quiet for hours is offered, and can be cleared', async () => {
    const quiet = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const { ws, dir } = workspaceWith([
        { id: 'TST-1', title: 'agy work', status: 'in_progress', running: true,
          running_session: 'conv-1', running_agent: 'agy',
          created_at: '2026-01-01T00:00:00Z', updated_at: quiet },
        TASKS[1]
    ]);
    await withServer(ws, async (base) => {
        const t1 = (await statusFor(base, dir)).tasks.find(t => t.id === 'TST-1');
        assert.equal(t1.staleRunning, false, 'never claims the session is dead');
        assert.ok(t1.unverifiableRunning, 'but does offer the choice');
        assert.equal(t1.unverifiableRunning.agent, 'agy');

        // The same button the stale case uses, through the same guard.
        const res = await put(base, dir, 'TST-1', { running: false, clearStale: true });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).task.running, false);
    });
});

test('a fresh agy flag is neither offered nor clearable', async () => {
    const { ws, dir } = workspaceWith([
        { id: 'TST-1', title: 'agy work', status: 'in_progress', running: true,
          running_session: 'conv-1', running_agent: 'agy',
          created_at: '2026-01-01T00:00:00Z', updated_at: new Date().toISOString() },
        TASKS[1]
    ]);
    await withServer(ws, async (base) => {
        const t1 = (await statusFor(base, dir)).tasks.find(t => t.id === 'TST-1');
        assert.equal(t1.unverifiableRunning, null);

        // The guard refuses: work that recent is probably in flight.
        const res = await put(base, dir, 'TST-1', { running: false, clearStale: true });
        assert.equal(res.status, 409);
    });
});
