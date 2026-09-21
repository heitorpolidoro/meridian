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

test('a generated 135KB stream-json log round-trips intact through the endpoint', async () => {
    // Generate a synthetic log file instead of reading from a real project's directory.
    // This test must be hermetic (work on any machine) and the repository must not
    // carry personal filesystem paths or real incident transcripts. A realistically
    // shaped, self-contained 135KB+ log exercises the same code paths as the real one.

    const { ws, dir } = workspaceWith(TASKS);

    // Build a synthetic newline-delimited JSON log, at least 135KB.
    const logLines = [];

    // System init message
    logLines.push(JSON.stringify({
        type: 'system',
        subtype: 'init',
        timestamp: '2026-09-20T15:29:06Z',
        version: '1.0'
    }));

    // Many assistant messages with realistic content to reach 135KB
    const baseMessage = 'This is a realistic long message from the model response. It contains varied text and explanations. ';
    for (let i = 0; i < 800; i++) {
        logLines.push(JSON.stringify({
            type: 'assistant',
            message: {
                content: baseMessage.repeat(6) + `Message sequence ${i}: Additional context and padding. `.repeat(3)
            },
            timestamp: `2026-09-20T15:29:${String(i % 60).padStart(2, '0')}Z`,
            index: i
        }));
    }

    // Add tool use and tool result blocks to exercise renderer branches
    for (let i = 0; i < 40; i++) {
        logLines.push(JSON.stringify({
            type: 'tool_use',
            tool_id: 'tool_' + i,
            tool_name: 'search_api',
            input: { query: 'search query ' + i, parameters: { limit: 10, offset: 0 } },
            timestamp: `2026-09-20T15:30:${String(i % 60).padStart(2, '0')}Z`
        }));

        logLines.push(JSON.stringify({
            type: 'tool_result',
            tool_id: 'tool_' + i,
            result: { success: true, data: 'Result data '.repeat(20), count: 5 },
            timestamp: `2026-09-20T15:30:${String(i % 60).padStart(2, '0')}Z`
        }));
    }

    // Final result message
    logLines.push(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        timestamp: '2026-09-20T15:31:00Z'
    }));

    const body = logLines.join('\n') + '\n';

    // Verify we have enough bytes
    assert.ok(body.length >= 135000, `Generated log is ${body.length} bytes, need 135KB+`);

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
