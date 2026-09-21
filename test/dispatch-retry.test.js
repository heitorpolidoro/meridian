const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Verifies CHANGE 3's runner wiring: a run that fails on OAuth token
// refresh contention is not reported as an ordinary failure — it is left
// pending a retry, with the project still reading as busy, using lastRun,
// the SSE channel and the existing `running` map exactly as the brief
// asked, rather than a new mechanism.
//
// What this file deliberately does NOT do: wait out the real ~30s retry
// delay to watch the second attempt happen. That timing is not seamed for
// testability in production code (per the task), so it is not asserted
// here — every check below runs well inside that window, and the server is
// killed in `withServer`'s `finally` long before the retry could fire.

const PORT_BASE = 3780;
let nextPort = PORT_BASE;

const OAUTH_MESSAGE = 'Failed to refresh OAuth token: another Claude Code process is refreshing it '
    + 'or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close '
    + 'other Claude Code processes or sign in again';

function workspaceWith(tasks) {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-retry-ws-'));
    const dir = path.join(ws, 'fixture-project');
    fs.mkdirSync(path.join(dir, '.meridian'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.meridian', 'project-info.json'),
        JSON.stringify({ name: 'Fixture', key: 'TST', stack: [], description: 'x' }));
    fs.writeFileSync(path.join(dir, '.meridian', 'tasks.jsonl'),
        tasks.map(t => JSON.stringify(t)).join('\n') + '\n');
    fs.mkdirSync(path.join(ws, '.meridian'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.meridian', 'projects.json'),
        JSON.stringify({ projects: [{ path: dir }] }));
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, '.claude', 'settings.json'),
        JSON.stringify({ permissions: { allow: ['Bash(npm test:*)'] } })
    );
    return { ws, dir };
}

// A `claude` stand-in that always reports the OAuth-contention failure for
// a dispatch invocation, and reports ready/no-sessions for the probes the
// eligibility checks need. It never has to behave differently on a second
// call in this file, because no test here waits long enough to see one.
function fakeClaudeBin() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-fakecli-retry-'));
    const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'status') {
    process.stdout.write(JSON.stringify({ loggedIn: true }) + '\\n');
    process.exit(0);
}
if (args[0] === 'agents') {
    process.stdout.write('[]\\n');
    process.exit(0);
}
process.stdout.write(JSON.stringify({
    type: 'result', is_error: true, result: ${JSON.stringify(OAUTH_MESSAGE)},
    permission_denials: [], terminal_reason: 'error'
}) + '\\n');
process.exit(0);
`;
    fs.writeFileSync(path.join(dir, 'claude'), script, { mode: 0o755 });
    fs.symlinkSync(process.execPath, path.join(dir, 'node'));
    return dir;
}

async function withServer(ws, envOverrides, fn) {
    const port = nextPort++;
    const proc = require('node:child_process').spawn('node', ['server.js'], {
        env: { ...process.env, PORT: String(port), MERIDIAN_RUNNING_DIR: ws, ...envOverrides },
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
        // Long before RETRY_DELAY_MS (~30s): the pending retry this test
        // provokes never gets a chance to actually fire.
        proc.kill('SIGKILL');
    }
}

const json = (base, p) => fetch(`${base}${p}`).then(r => r.json());
const post = (base, p, body) => fetch(`${base}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});
const projectIn = (body, dir) => body.projects.find(p => p.path === dir);

async function untilLastRun(base, dir) {
    for (let i = 0; i < 200; i++) {
        const p = projectIn(await json(base, '/api/status'), dir);
        if (p.lastRun) return p;
        await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('the loop never recorded a run');
}

const TASKS = [
    { id: 'TST-1', title: 'one', status: 'ready_todo', created_at: '2026-01-01T00:00:00Z' },
    { id: 'TST-2', title: 'two', status: 'ready_todo', created_at: '2026-01-02T00:00:00Z' }
];

test('a run failing on OAuth token refresh contention is left pending a retry, not reported as failed', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    const fakeBin = fakeClaudeBin();
    await withServer(ws, { PATH: fakeBin }, async base => {
        await post(base, '/api/projects/dispatch', { projectPath: dir, taskId: 'TST-1', tool: 'claude' });
        const p = await untilLastRun(base, dir);

        assert.equal(p.lastRun.taskId, 'TST-1');
        assert.equal(p.lastRun.ok, false);
        assert.equal(p.lastRun.retryPending, true, 'the operator must see a retry is pending, not a plain failure');
        assert.match(p.lastRun.reason, /transient/i);
        assert.ok(!Number.isNaN(Date.parse(p.lastRun.retryAt)), 'retryAt is a parseable timestamp');
        assert.ok(Date.parse(p.lastRun.retryAt) > Date.now(), 'retryAt is in the future at the moment of failure');
    });
});

test('the project still reads as busy while a retry is pending, so nothing else is dispatched into it', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    const fakeBin = fakeClaudeBin();
    await withServer(ws, { PATH: fakeBin }, async base => {
        await post(base, '/api/projects/dispatch', { projectPath: dir, taskId: 'TST-1', tool: 'claude' });
        await untilLastRun(base, dir);

        const p = projectIn(await json(base, '/api/status'), dir);
        assert.match(p.dispatchBlockedReason, /retrying/i);
        assert.match(p.dispatchBlockedReason, /TST-1/);

        // A second task queued now must sit untouched: runDispatchLoop's
        // busy guard (server.js) must treat a pending retry exactly like a
        // live run, not let it slip through as "nothing running".
        await post(base, '/api/projects/dispatch', { projectPath: dir, taskId: 'TST-2', tool: 'claude' });
        await new Promise(r => setTimeout(r, 400));
        const after = projectIn(await json(base, '/api/status'), dir);
        assert.deepEqual(after.queue, ['TST-2'], 'queued behind the pending retry, not pulled early');
        assert.equal(after.lastRun.taskId, 'TST-1', 'the pending retry is still the last recorded run');
    });
});

test('Stop cancels a pending retry and reports the run as failed rather than doing nothing', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    const fakeBin = fakeClaudeBin();
    await withServer(ws, { PATH: fakeBin }, async base => {
        await post(base, '/api/projects/dispatch', { projectPath: dir, taskId: 'TST-1', tool: 'claude' });
        await untilLastRun(base, dir);

        const stopBody = await (await post(base, '/api/projects/dispatch/stop', { projectPath: dir })).json();
        assert.equal(stopBody.stopped, true);

        const p = projectIn(await json(base, '/api/status'), dir);
        assert.equal(p.lastRun.ok, false);
        assert.equal(p.lastRun.retryPending, undefined, 'the cancelled retry no longer reads as pending');
        assert.match(p.lastRun.reason, /stopped before its retry ran/);
        assert.equal(p.dispatchBlockedReason, null, 'the project is free again once the retry is cancelled');
    });
});
