const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Same fixture/server harness as test/api-dispatch.test.js:11-71, with its
// own port range so the two files' servers never collide.
const PORT_BASE = 3800;
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
    { id: 'TST-1', title: 'one', status: 'ready_todo', created_at: '2026-01-01T00:00:00Z' }
];

function runsDir(dir) {
    return path.join(dir, '.meridian', 'runs');
}

function writeRunLog(dir, taskId, stamp, body) {
    fs.mkdirSync(runsDir(dir), { recursive: true });
    const file = path.join(runsDir(dir), `${taskId}-${stamp}.log`);
    fs.writeFileSync(file, body);
    return file;
}

test('a task with no run logs returns an empty list, not an error', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    await withServer(ws, async base => {
        const res = await fetch(`${base}/api/projects/runs/TST-1?project=${encodeURIComponent(dir)}`);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { runs: [] });
    });
});

test('returns run logs newest first, with the file body attached', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    writeRunLog(dir, 'TST-1', '2026-09-20T10-00-00', 'first run\n');
    writeRunLog(dir, 'TST-1', '2026-09-20T11-00-00', 'second run\n');
    await withServer(ws, async base => {
        const res = await fetch(`${base}/api/projects/runs/TST-1?project=${encodeURIComponent(dir)}`);
        const data = await res.json();
        assert.equal(data.runs.length, 2);
        assert.equal(data.runs[0].name, 'TST-1-2026-09-20T11-00-00.log');
        assert.equal(data.runs[0].body, 'second run\n');
        assert.equal(data.runs[1].name, 'TST-1-2026-09-20T10-00-00.log');
    });
});

test('caps at the five most recent runs', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    for (let i = 0; i < 7; i++) {
        writeRunLog(dir, 'TST-1', `2026-09-20T10-0${i}-00`, `run ${i}\n`);
    }
    await withServer(ws, async base => {
        const res = await fetch(`${base}/api/projects/runs/TST-1?project=${encodeURIComponent(dir)}`);
        const data = await res.json();
        assert.equal(data.runs.length, 5);
        assert.equal(data.runs[0].body, 'run 6\n');
    });
});

test('a real, large run log (135KB of stream-json) round-trips intact', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    const fixture = '~/workspace/example_project/.meridian/runs/EX-18-2026-09-20T15-29-06.log';
    // Skip gracefully if this machine does not have the incident fixture —
    // the fixture is evidence from a real incident and is never modified or
    // copied into the repo, only read from in place.
    if (!fs.existsSync(fixture)) return;
    const body = fs.readFileSync(fixture, 'utf8');
    writeRunLog(dir, 'TST-1', '2026-09-20T15-29-06', body);
    await withServer(ws, async base => {
        const res = await fetch(`${base}/api/projects/runs/TST-1?project=${encodeURIComponent(dir)}`);
        const data = await res.json();
        assert.equal(data.runs.length, 1);
        assert.equal(data.runs[0].body.length, body.length);
        assert.equal(data.runs[0].body, body);
    });
});

test('an unregistered project is refused with 400', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    await withServer(ws, async base => {
        const res = await fetch(`${base}/api/projects/runs/TST-1?project=${encodeURIComponent(dir + '-nope')}`);
        assert.equal(res.status, 400);
        const data = await res.json();
        assert.match(data.error, /Unknown project/);
    });
});

test('a missing project query param is refused with 400, not a crash', async () => {
    const { ws } = workspaceWith(TASKS);
    await withServer(ws, async base => {
        const res = await fetch(`${base}/api/projects/runs/TST-1`);
        assert.equal(res.status, 400);
        const data = await res.json();
        assert.match(data.error, /project is required/);
    });
});

test('an unsafe task id yields no runs rather than a filesystem escape', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    await withServer(ws, async base => {
        // A character outside isSafeTaskId's allowed set (letters, digits,
        // '_', '.', '-'). A literal '..' segment gets collapsed by URL
        // normalization before it reaches the route at all, so this is the
        // case that actually exercises listRunLogs's own guard.
        const res = await fetch(`${base}/api/projects/runs/${encodeURIComponent('TST-1; rm -rf')}?project=${encodeURIComponent(dir)}`);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { runs: [] });
    });
});
