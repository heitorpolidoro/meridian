const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    dispatchLockPath, writeDispatchLock, clearDispatchLock, readDispatchLock, pidIsAlive
} = require('../lib/dispatch-lock');

function project() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-lock-'));
    fs.mkdirSync(path.join(dir, '.meridian'), { recursive: true });
    return dir;
}

// A pid nothing answers to. Searched for rather than hard-coded: any number
// picked in advance can be in use on the machine running the suite, and this
// test would then assert the opposite of what it says.
function deadPid() {
    for (let pid = 60000; pid < 90000; pid++) {
        if (!pidIsAlive(pid)) return pid;
    }
    throw new Error('no free pid found to stand in for a dead process');
}

test('the lock sits beside the run logs, hidden from the log listing', () => {
    const dir = project();
    assert.equal(
        dispatchLockPath(dir),
        path.join(dir, '.meridian', 'runs', '.dispatch.lock')
    );
});

// The live case: this very test process is the pid, so it is unambiguously
// alive, and the repository reads as held.
test('a lock naming a live pid reads as locked and keeps its file', () => {
    const dir = project();
    writeDispatchLock(dir, { pid: process.pid, taskId: 'T-1', startedAt: '2026-09-20T10:00:00Z' });

    const held = readDispatchLock(dir);
    assert.ok(held);
    assert.equal(held.pid, process.pid);
    assert.equal(held.taskId, 'T-1');
    assert.equal(held.startedAt, '2026-09-20T10:00:00Z');
    assert.equal(fs.existsSync(dispatchLockPath(dir)), true);
});

// This is what makes the lock derived rather than stored: a server killed
// mid-run leaves the file behind, and the next reader releases it with no
// operator action at all.
test('a lock naming a dead pid reads as unlocked and is cleaned up', () => {
    const dir = project();
    writeDispatchLock(dir, { pid: deadPid(), taskId: 'T-1', startedAt: '2026-09-20T10:00:00Z' });

    assert.equal(readDispatchLock(dir), null);
    assert.equal(fs.existsSync(dispatchLockPath(dir)), false);
});

// The answer on every project that has never dispatched, so it must be the
// quiet one and not an error.
test('a missing lock file reads as unlocked', () => {
    assert.equal(readDispatchLock(project()), null);
});

// A truncated write or a hand edit must not take down a dispatch pass. The
// file names no process, so it can be holding nothing.
test('a malformed lock reads as unlocked rather than throwing', () => {
    const dir = project();
    const file = dispatchLockPath(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"pid": ', 'utf8');

    assert.equal(readDispatchLock(dir), null);
    assert.equal(fs.existsSync(file), false);
});

// Valid JSON that carries no usable pid is the same situation as unparseable
// bytes, and must not be mistaken for a lock held by process 0.
test('a lock with no usable pid reads as unlocked', () => {
    const dir = project();
    for (const body of ['{}', '{"pid":0}', '{"pid":"abc"}', '{"pid":-4}', '[]']) {
        writeRaw(dir, body);
        assert.equal(readDispatchLock(dir), null, `for ${body}`);
        assert.equal(fs.existsSync(dispatchLockPath(dir)), false, `for ${body}`);
    }
});

function writeRaw(dir, body) {
    const file = dispatchLockPath(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, 'utf8');
}

// Deleting a lock that is already gone is the normal second call — the close
// handler runs after a stop that already released it — so it reports false
// instead of throwing.
test('clearing is idempotent', () => {
    const dir = project();
    writeDispatchLock(dir, { pid: process.pid, taskId: 'T-1', startedAt: 'now' });
    assert.equal(clearDispatchLock(dir), true);
    assert.equal(clearDispatchLock(dir), false);
    assert.equal(readDispatchLock(dir), null);
});

// The liveness probe is injectable for the tests alone; production passes
// nothing and gets the real signal.
test('an injected liveness probe decides the verdict', () => {
    const dir = project();
    writeDispatchLock(dir, { pid: process.pid, taskId: 'T-1', startedAt: 'now' });
    assert.equal(readDispatchLock(dir, () => false), null);
    assert.equal(fs.existsSync(dispatchLockPath(dir)), false);
});
