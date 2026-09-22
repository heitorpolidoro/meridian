const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Coverage for how sparingly GET /api/status calls `claude agents --json`
// (server.js#liveSessionsListCached / getStatusData's pre-scan): the probe
// costs ~240ms against a ~5ms getStatusData without it (see the fix-round-1
// section of the report), and every fs.watch event during a live run calls
// getStatusData via broadcastUpdate, so it must not run unconditionally.

// 4100, not 3950: that range collided with test/cli.test.js's old
// random-port draws (see test/port-windows.test.js) — moved out of the way
// rather than fixing the collision from this side twice.
const PORT_BASE = 4100;
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

// A `claude` stand-in that answers `agents --json` with an empty list and
// appends one line to `logFile` per invocation, so tests can count exactly
// how many times the probe actually ran. Modeled on the fake CLI in
// test/dispatch-retry.test.js.
function fakeClaudeBin(logFile) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-fakecli-probe-'));
    const script = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'agents') {
    try { fs.appendFileSync(${JSON.stringify(logFile)}, 'x\\n'); } catch (e) { /* ignore */ }
}
process.stdout.write('[]\\n');
process.exit(0);
`;
    fs.writeFileSync(path.join(dir, 'claude'), script, { mode: 0o755 });
    fs.symlinkSync(process.execPath, path.join(dir, 'node'));
    return dir;
}

async function withServer(ws, bin, envOverrides, fn) {
    const port = nextPort++;
    const proc = require('node:child_process').spawn('node', ['server.js'], {
        env: { ...process.env, PATH: bin, PORT: String(port), MERIDIAN_RUNNING_DIR: ws, ...envOverrides },
        cwd: path.join(__dirname, '..'),
        stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    proc.stderr.on('data', chunk => { stderr += chunk; });
    try {
        let ready = false;
        for (let i = 0; i < 250; i++) {
            // `/` (the static index page) rather than `/api/status`: the
            // latter is exactly what this file counts probe calls against,
            // and a readiness poll against it would spend one of those
            // calls — or a cache hit — before the test gets to make any on
            // purpose.
            try { await fetch(`http://localhost:${port}/`); ready = true; break; }
            catch { await new Promise(r => setTimeout(r, 100)); }
        }
        if (!ready) throw new Error(`Server did not start.\nstderr:\n${stderr || '(empty)'}`);
        await fn(`http://localhost:${port}`);
    } finally {
        proc.kill('SIGKILL');
    }
}

function probeCount(logFile) {
    if (!fs.existsSync(logFile)) return 0;
    return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).length;
}

const NOT_RUNNING = [
    { id: 'TST-1', title: 'idle', status: 'backlog', running: false, created_at: '2026-01-01T00:00:00Z' },
    { id: 'TST-2', title: 'also idle', status: 'ready_todo', created_at: '2026-01-02T00:00:00Z' }
];

const ONE_RUNNING = [
    { id: 'TST-1', title: 'stuck', status: 'in_progress', running: true, created_at: '2026-01-01T00:00:00Z' },
    { id: 'TST-2', title: 'idle', status: 'backlog', running: false, created_at: '2026-01-02T00:00:00Z' }
];

test('no task marked running: GET /api/status never spawns the agents probe', async () => {
    const { ws, dir } = workspaceWith(NOT_RUNNING);
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-log-')), 'calls.log');
    const bin = fakeClaudeBin(logFile);
    await withServer(ws, bin, {}, async (base) => {
        await fetch(`${base}/api/status?project=${encodeURIComponent(dir)}`);
        await fetch(`${base}/api/status?project=${encodeURIComponent(dir)}`);
        assert.equal(probeCount(logFile), 0, 'no running task anywhere: the probe must not run at all');
    });
});

test('a running task triggers the probe, and a second call inside the cache window reuses it', async () => {
    const { ws, dir } = workspaceWith(ONE_RUNNING);
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-log-')), 'calls.log');
    const bin = fakeClaudeBin(logFile);
    await withServer(ws, bin, {}, async (base) => {
        await fetch(`${base}/api/status?project=${encodeURIComponent(dir)}`);
        assert.equal(probeCount(logFile), 1, 'a running task needs the probe once');
        await fetch(`${base}/api/status?project=${encodeURIComponent(dir)}`);
        assert.equal(probeCount(logFile), 1, 'a second call inside the cache window reuses the first answer');
    });
});

test('the cache refreshes once its window elapses', async () => {
    const { ws, dir } = workspaceWith(ONE_RUNNING);
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-log-')), 'calls.log');
    const bin = fakeClaudeBin(logFile);
    // A short window, only for this test, so the suite does not have to
    // wait out the real 5s production cache to prove it expires.
    await withServer(ws, bin, { MERIDIAN_SESSION_CACHE_MS: '100' }, async (base) => {
        await fetch(`${base}/api/status?project=${encodeURIComponent(dir)}`);
        assert.equal(probeCount(logFile), 1);
        await new Promise(r => setTimeout(r, 200));
        await fetch(`${base}/api/status?project=${encodeURIComponent(dir)}`);
        assert.equal(probeCount(logFile), 2, 'past the window, the next call probes again');
    });
});

test('the clear-stale PUT probes fresh, ignoring whatever the GET cache holds', async () => {
    const { ws, dir } = workspaceWith(ONE_RUNNING);
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-log-')), 'calls.log');
    const bin = fakeClaudeBin(logFile);
    await withServer(ws, bin, {}, async (base) => {
        // Populate the GET cache first.
        await fetch(`${base}/api/status?project=${encodeURIComponent(dir)}`);
        assert.equal(probeCount(logFile), 1);

        // Immediately after, well inside the 5s cache window: the clear
        // path must still spawn its own probe rather than trust the cache.
        const res = await fetch(`${base}/api/projects/tasks/TST-1`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: dir, running: false, clearStale: true })
        });
        assert.equal(res.status, 200);
        assert.equal(probeCount(logFile), 2, 'the clear path made its own fresh call, not a cache hit');
    });
});
