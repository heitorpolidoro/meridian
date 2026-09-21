const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Verifies CHANGE 1: every dispatch refusal — not just the last one before a
// pass ends — is appended to .meridian/events.jsonl. Reuses the harness from
// test/api-dispatch.test.js: a real server, pointed at a scratch workspace
// via MERIDIAN_RUNNING_DIR, with `claude` made unreachable or replaced by a
// scripted stand-in so no real CLI is ever spawned.

const PORT_BASE = 3760;
let nextPort = PORT_BASE;

function workspaceWith(tasks) {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-refusal-ws-'));
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

function withAllowlist(dir) {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, '.claude', 'settings.json'),
        JSON.stringify({ permissions: { allow: ['Bash(npm test:*)'] } })
    );
}

// A PATH containing exactly one executable named `claude` (a Node script,
// so no shell is needed to run it), copied from test/api-dispatch.test.js's
// NODE_ONLY_BIN idea. Unlike that file's plain node-only PATH, this `claude`
// answers `auth status --json` and `agents --json` itself, so dispatch
// eligibility can reach past the environment checks in a controlled way —
// without ever running a real CLI or touching the operator's machine.
//
// It never runs the actual `/meridian:work` prompt: every scenario in this
// file is built so no candidate is ever left eligible, so the dispatch
// branch below is spawned in name only and its result is irrelevant to what
// is being asserted.
function fakeClaudeBin() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-fakecli-'));
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
    type: 'result', is_error: false, result: 'ok',
    permission_denials: [], terminal_reason: 'completed'
}) + '\\n');
process.exit(0);
`;
    const target = path.join(dir, 'claude');
    fs.writeFileSync(target, script, { mode: 0o755 });
    // The server itself is spawned via `spawn('node', ['server.js'], {env:
    // {PATH: ...}})` in withServer below, so `node` must resolve from the
    // very PATH this directory becomes — otherwise the harness can't start
    // the server at all, before the test gets anywhere near a refusal.
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
        proc.kill('SIGKILL');
    }
}

const json = (base, p) => fetch(`${base}${p}`).then(r => r.json());
const post = (base, p, body) => fetch(`${base}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});
const projectIn = (body, dir) => body.projects.find(p => p.path === dir);

async function settled(base, dir) {
    for (let i = 0; i < 200; i++) {
        const p = projectIn(await json(base, '/api/status'), dir);
        if (p.lastRun) break;
        await new Promise(r => setTimeout(r, 50));
    }
    await new Promise(r => setTimeout(r, 300));
    return projectIn(await json(base, '/api/status'), dir);
}

function readRefusalLines(dir) {
    const file = path.join(dir, '.meridian', 'events.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').trim().split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l))
        .filter(e => e.type === 'dispatch_refused');
}

const TASKS = [
    { id: 'TST-1', title: 'one', status: 'ready_todo', created_at: '2026-01-01T00:00:00Z' }
];

test('a single refusal appends exactly one dispatch_refused line with task, reason, scope and a timestamp', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    // No PATH override: the real environment's `claude`, if any, is left
    // reachable normally in test/api-dispatch.test.js by pointing PATH at a
    // node-only directory. Do the same here, so the refusal is the ordinary
    // "CLI not authenticated" environment refusal — no scripted CLI needed.
    const nodeOnly = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-nodeonly-'));
    fs.symlinkSync(process.execPath, path.join(nodeOnly, 'node'));
    await withServer(ws, { PATH: nodeOnly }, async base => {
        await post(base, '/api/projects/dispatch', { projectPath: dir, taskId: 'TST-1', tool: 'claude' });
        const p = await settled(base, dir);
        assert.equal(p.lastRun.ok, false);

        const lines = readRefusalLines(dir);
        assert.equal(lines.length, 1, 'exactly one refusal line');
        const [line] = lines;
        assert.equal(line.task, 'TST-1');
        assert.match(line.reason, /authenticated/);
        assert.equal(line.scope, 'environment');
        assert.ok(!Number.isNaN(Date.parse(line.at)), 'at is a parseable timestamp');
    });
});

test('several refusals in one auto-dispatch pass append one line each', async () => {
    // Three workable tasks: the first two can never become eligible (each
    // blocked by an id that is not on the board at all), the third has no
    // obstruction and is left dangling as `running: true` so it refuses the
    // same task-scoped way rather than actually spawning the scripted CLI's
    // dispatch branch — keeping this test about the refusal log, not about
    // a fabricated "successful run".
    const tasks = [
        { id: 'TST-1', title: 'one', status: 'ready_todo', created_at: '2026-01-01T00:00:00Z', blockedBy: ['GHOST-1'] },
        { id: 'TST-2', title: 'two', status: 'ready_todo', created_at: '2026-01-02T00:00:00Z', blockedBy: ['GHOST-2'] },
        { id: 'TST-3', title: 'three', status: 'ready_todo', created_at: '2026-01-03T00:00:00Z', running: true }
    ];
    const { ws, dir } = workspaceWith(tasks);
    withAllowlist(dir);
    const fakeBin = fakeClaudeBin();
    await withServer(ws, { PATH: fakeBin }, async base => {
        await post(base, '/api/projects/dispatch/auto', { projectPath: dir, enabled: true });

        // All three candidates refuse (task-scoped), so the pass ends with
        // no dispatch ever spawned. Poll status until lastRun.refusals
        // shows every one of them, the way the exhausted-candidates branch
        // (server.js, dispatchOnePass) records it.
        let p;
        for (let i = 0; i < 200; i++) {
            p = projectIn(await json(base, '/api/status'), dir);
            if (p.lastRun && Array.isArray(p.lastRun.refusals) && p.lastRun.refusals.length >= 3) break;
            await new Promise(r => setTimeout(r, 50));
        }
        await new Promise(r => setTimeout(r, 300));

        const lines = readRefusalLines(dir);
        assert.equal(lines.length, 3, 'one events.jsonl line per refused candidate');
        const byTask = Object.fromEntries(lines.map(l => [l.task, l]));
        assert.match(byTask['TST-1'].reason, /GHOST-1/);
        assert.match(byTask['TST-2'].reason, /GHOST-2/);
        assert.match(byTask['TST-3'].reason, /already being worked on/);
        for (const l of lines) assert.equal(l.scope, 'task');
    });
});

test('a successful dispatch appends no dispatch_refused line', async () => {
    const { ws, dir } = workspaceWith(TASKS);
    withAllowlist(dir);
    const fakeBin = fakeClaudeBin();
    await withServer(ws, { PATH: fakeBin }, async base => {
        await post(base, '/api/projects/dispatch', { projectPath: dir, taskId: 'TST-1', tool: 'claude' });
        const p = await settled(base, dir);
        assert.equal(p.lastRun.ok, true, 'the scripted CLI reports success');
        assert.equal(readRefusalLines(dir).length, 0);
    });
});
