const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'cli.js');

// Never the checkout's own pid file: it is shared by every project on this
// machine, and an earlier run of this very suite killed the operator's live
// board through it. Each test gets its own.
function pidFile() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-pid-')), 'server.pid');
}

// A fixture workspace outside ~/workspace, so findWorkspaceRoot
// cannot walk up into the operator's real registry.
function fixture() {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-cli-'));
    fs.mkdirSync(path.join(ws, '.meridian'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.meridian', 'projects.json'), JSON.stringify({ projects: [] }));
    return ws;
}

function runCli(args, ws, port, pf) {
    return execFileSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8',
        env: { ...process.env, MERIDIAN_RUNNING_DIR: ws, PORT: String(port), MERIDIAN_PID_FILE: pf }
    });
}

function alive(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

async function upOn(port) {
    // Server startup budget: generous 25 seconds. These tests spawn a real server process,
    // node --test runs files in parallel, and several servers starting at once can exceed 5s.
    // The budget is a ceiling, not a delay; servers answering in 200ms still take 200ms.
    for (let i = 0; i < 250; i++) {
        try { await fetch(`http://localhost:${port}/api/status`); return true; }
        catch { await new Promise(r => setTimeout(r, 100)); }
    }
    return false;
}

test('start is idempotent: a second start does not kill the first server', async () => {
    const ws = fixture();
    const PF = pidFile();
    const port = 3910 + Math.floor(Math.random() * 40);
    let pid = null;
    {
        try {
            const first = runCli(['start'], ws, port, PF);
            pid = parseInt(fs.readFileSync(PF, 'utf8').trim(), 10);
            assert.ok(pid > 0, 'first start recorded a pid');
            assert.ok(await upOn(port), 'first server answered');
            assert.match(first, /started/i);

            const second = runCli(['start'], ws, port, PF);
            assert.match(second, /already running/i, 'second start reports the existing server');
            assert.ok(alive(pid), 'the first server is still alive');
            assert.equal(
                parseInt(fs.readFileSync(PF, 'utf8').trim(), 10), pid,
                'the pid file still points at the first server'
            );
        } finally {
            if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
        }
    }
});

test('restart replaces a running server with a new one', async () => {
    const ws = fixture();
    const PF = pidFile();
    const port = 3950 + Math.floor(Math.random() * 40);
    let first = null, second = null;
    {
        try {
            runCli(['start'], ws, port, PF);
            first = parseInt(fs.readFileSync(PF, 'utf8').trim(), 10);
            assert.ok(await upOn(port));

            runCli(['restart'], ws, port, PF);
            second = parseInt(fs.readFileSync(PF, 'utf8').trim(), 10);
            assert.notEqual(second, first, 'restart produced a different process');
            assert.ok(await upOn(port), 'the replacement answers');
        } finally {
            for (const p of [first, second]) if (p && alive(p)) process.kill(p, 'SIGKILL');
        }
    }
});

test('add registers a project the same way the API does', async () => {
    const ws = fixture();
    const proj = path.join(ws, 'Audio Transcriber');
    fs.mkdirSync(proj, { recursive: true });

    const out = runCli(['add', proj], ws, 3999, pidFile());
    assert.match(out, /Added project/);

    const registry = JSON.parse(fs.readFileSync(path.join(ws, '.meridian', 'projects.json'), 'utf8'));
    assert.deepEqual(registry.projects, [{ path: proj }], 'registry holds the path and nothing else');

    const info = JSON.parse(fs.readFileSync(path.join(proj, '.meridian', 'project-info.json'), 'utf8'));
    assert.equal(info.key, 'AT', 'a key was derived, so ids are not TASK-N');
    assert.equal(info.name, 'Audio Transcriber');
    assert.deepEqual(info.stack, []);
});

test('add refuses a project that is already registered', async () => {
    const ws = fixture();
    const proj = path.join(ws, 'dup');
    fs.mkdirSync(proj, { recursive: true });
    runCli(['add', proj], ws, 3999, pidFile());
    assert.throws(() => runCli(['add', proj], ws, 3999, pidFile()), /already added|Command failed/);
});
