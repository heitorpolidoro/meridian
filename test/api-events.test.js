const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Same fixture pattern as test/api-tasks.test.js: an isolated workspace with
// one registered project, and a server spawned against it via
// MERIDIAN_RUNNING_DIR — never the real board.
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
        stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    try {
        const start = Date.now();
        let ready = false;
        // Server startup budget: generous 25 seconds. These tests spawn a real server process,
        // node --test runs files in parallel, and several servers starting at once can exceed 5s.
        // The budget is a ceiling, not a delay; servers answering in 200ms still take 200ms.
        for (let i = 0; i < 250; i++) {
            try { await fetch(`http://localhost:${port}/api/status`); ready = true; break; }
            catch { await new Promise(r => setTimeout(r, 100)); }
        }
        if (!ready) {
            throw new Error(
                `Server on port ${port} did not respond after ${Date.now() - start}ms.\n` +
                `stderr:\n${stderr || '(empty)'}`
            );
        }
        await fn(`http://localhost:${port}`);
    } finally {
        proc.kill('SIGKILL');
    }
}

async function seed(base, dir, body) {
    const res = await fetch(`${base}/api/projects/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: dir, title: 'seed', ...body })
    });
    return (await res.json()).task;
}

async function put(base, dir, id, body) {
    return fetch(`${base}/api/projects/tasks/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: dir, ...body })
    });
}

function eventsLines(dir) {
    const p = path.join(dir, '.meridian', 'events.jsonl');
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

test('POST /api/projects/tasks appends one status event with from:null', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const task = await seed(base, dir, { status: 'ready_todo' });
        const lines = eventsLines(dir);
        assert.equal(lines.length, 1);
        assert.deepEqual(
            { task: lines[0].task, field: lines[0].field, from: lines[0].from, to: lines[0].to },
            { task: task.id, field: 'status', from: null, to: 'ready_todo' }
        );
        assert.ok(lines[0].at);
    });
});

test('creating multiple tasks appends one status event per task', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        await seed(base, dir);
        await seed(base, dir);
        await seed(base, dir);
        const lines = eventsLines(dir);
        assert.equal(lines.length, 3);
        assert.ok(lines.every(l => l.field === 'status' && l.from === null));
    });
});

test('PUT changing only status appends one status line', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const task = await seed(base, dir);
        await put(base, dir, task.id, { status: 'in_progress' });
        const lines = eventsLines(dir);
        assert.equal(lines.length, 2); // create + this update
        const last = lines[lines.length - 1];
        assert.deepEqual(
            { field: last.field, from: last.from, to: last.to },
            { field: 'status', from: 'backlog', to: 'in_progress' }
        );
    });
});

test('PUT changing only running appends one running line', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const task = await seed(base, dir);
        await put(base, dir, task.id, { running: true });
        const lines = eventsLines(dir);
        assert.equal(lines.length, 2);
        const last = lines[lines.length - 1];
        assert.deepEqual(
            { field: last.field, from: last.from, to: last.to },
            { field: 'running', from: false, to: true }
        );
    });
});

test('PUT changing both status and running appends two lines', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const task = await seed(base, dir);
        await put(base, dir, task.id, { status: 'in_progress', running: true });
        const lines = eventsLines(dir);
        assert.equal(lines.length, 3); // create + status + running
        const fields = lines.slice(1).map(l => l.field).sort();
        assert.deepEqual(fields, ['running', 'status']);
    });
});

test('PUT changing neither status nor running appends no new line', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const task = await seed(base, dir);
        const before = eventsLines(dir).length;
        await put(base, dir, task.id, { title: 'renamed' });
        assert.equal(eventsLines(dir).length, before);
    });
});

test('events.jsonl grows monotonically across repeated create/update writes', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        let prevCount = 0;
        for (let i = 0; i < 4; i++) {
            const task = await seed(base, dir);
            let lines = eventsLines(dir);
            assert.ok(lines.length > prevCount);
            prevCount = lines.length;
            await put(base, dir, task.id, { status: 'in_progress' });
            lines = eventsLines(dir);
            assert.ok(lines.length > prevCount);
            // Earlier lines are untouched.
            for (let j = 0; j < prevCount; j++) {
                assert.ok(lines[j].task, 'earlier line still parses and has its original task field');
            }
            prevCount = lines.length;
        }
    });
});

test('POST /api/projects/events with agent returns 201 and appends a matching line', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const res = await fetch(`${base}/api/projects/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                projectPath: dir, task: 'TST-1', type: 'dispatch_tokens',
                agent: 'developer', output_tokens: 1234, context_tokens: 58000
            })
        });
        assert.equal(res.status, 201);
        const lines = eventsLines(dir);
        assert.equal(lines.length, 1);
        assert.deepEqual(
            { task: lines[0].task, type: lines[0].type, agent: lines[0].agent, output_tokens: lines[0].output_tokens, context_tokens: lines[0].context_tokens },
            { task: 'TST-1', type: 'dispatch_tokens', agent: 'developer', output_tokens: 1234, context_tokens: 58000 }
        );
        assert.ok(lines[0].at);
    });
});

test('POST /api/projects/events without agent returns 201 and omits it', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const res = await fetch(`${base}/api/projects/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                projectPath: dir, task: 'TST-1', type: 'dispatch_tokens',
                output_tokens: 10, context_tokens: 20
            })
        });
        assert.equal(res.status, 201);
        const lines = eventsLines(dir);
        assert.equal(lines.length, 1);
        assert.equal(lines[0].agent, undefined);
    });
});

test('POST /api/projects/events rejects an unregistered projectPath', async () => {
    const { ws } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const res = await fetch(`${base}/api/projects/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                projectPath: '/not/registered', task: 'TST-1', type: 'dispatch_tokens',
                output_tokens: 10, context_tokens: 20
            })
        });
        assert.equal(res.status, 400);
    });
});

test('POST /api/projects/events rejects a missing or blank task', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        for (const task of [undefined, '', '   ']) {
            const res = await fetch(`${base}/api/projects/events`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projectPath: dir, task, type: 'dispatch_tokens',
                    output_tokens: 10, context_tokens: 20
                })
            });
            assert.equal(res.status, 400, `task=${JSON.stringify(task)} should be rejected`);
        }
    });
});

test('POST /api/projects/events rejects a type other than dispatch_tokens', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        for (const type of [undefined, 'status', 'something_else']) {
            const res = await fetch(`${base}/api/projects/events`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projectPath: dir, task: 'TST-1', type,
                    output_tokens: 10, context_tokens: 20
                })
            });
            assert.equal(res.status, 400, `type=${JSON.stringify(type)} should be rejected`);
        }
    });
});

test('POST /api/projects/events rejects non-numeric output_tokens or context_tokens', async () => {
    const { ws, dir } = workspaceWith('Test Project');
    await withServer(ws, async (base) => {
        const bad = [
            { output_tokens: 'ten', context_tokens: 20 },
            { output_tokens: 10, context_tokens: 'twenty' },
            { output_tokens: null, context_tokens: 20 },
            { output_tokens: 10, context_tokens: undefined }
        ];
        for (const overrides of bad) {
            const res = await fetch(`${base}/api/projects/events`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projectPath: dir, task: 'TST-1', type: 'dispatch_tokens', ...overrides
                })
            });
            assert.equal(res.status, 400, `${JSON.stringify(overrides)} should be rejected`);
        }
    });
});
