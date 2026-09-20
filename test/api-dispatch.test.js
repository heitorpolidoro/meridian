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
