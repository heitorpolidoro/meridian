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
