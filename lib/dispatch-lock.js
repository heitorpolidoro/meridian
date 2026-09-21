'use strict';

// The half of the one-run-per-repository lock that survives a server restart.
//
// lib/dispatch-sessions.js derives a lock from `claude agents --json`, but it
// counts only `kind: "background"` — and a dispatch spawns `claude -p`, which
// that list reports as `kind: "interactive"`, indistinguishable from the
// terminal the operator is sitting in. Dropping the kind filter is not the
// fix: it would let the operator's own open session lock the board out, which
// is exactly what that module's comment refuses. So our own runs need a mark
// of their own, and this is it.
//
// Still derived, not stored, in the sense that matters: the file names a pid,
// and the lock is live only while that pid is. A server killed mid-run leaves
// the file behind, and the next reader finds a pid nobody answers to,
// declares the repo free and deletes it. Nothing has to be cleaned up by hand
// — which was the spec's whole reason for choosing a derived lock over a
// stored flag, and the lesson the orphaned `running` flag already taught.

const fs = require('node:fs');
const path = require('node:path');

const LOCK_NAME = '.dispatch.lock';

// Beside the run logs: one directory holds everything a run leaves behind.
// The leading dot keeps it out of listRunLogs, which matches `<id>-*.log`.
function dispatchLockPath(projectPath) {
    return path.join(projectPath, '.meridian', 'runs', LOCK_NAME);
}

// The default liveness probe. Signal 0 delivers nothing; it only asks whether
// the process exists and is signallable. EPERM means it exists and belongs to
// someone else, which still counts as alive.
function pidIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === 'EPERM';
    }
}

function writeDispatchLock(projectPath, { pid, taskId, startedAt }) {
    const file = dispatchLockPath(projectPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid, taskId, startedAt }) + '\n', 'utf8');
    return file;
}

function clearDispatchLock(projectPath) {
    try {
        fs.unlinkSync(dispatchLockPath(projectPath));
        return true;
    } catch (err) {
        // Already gone is the normal case on the second call, and a lock we
        // cannot delete is not worth throwing out of a `close` handler for.
        return false;
    }
}

// Returns the live lock, or null. Every not-locked answer also removes the
// file, so a stale lock never has to be cleaned up by hand.
//
// `isAlive` is injectable only so the tests can describe a dead pid without
// racing the operating system's pid reuse; production always uses the real
// signal probe.
function readDispatchLock(projectPath, isAlive = pidIsAlive) {
    const file = dispatchLockPath(projectPath);
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
        // No file at all: the repository is free. Not an error — this is the
        // answer on every project that has never dispatched.
        return null;
    }

    let parsed = null;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        parsed = null;
    }
    const pid = parsed && Number(parsed.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
        // A truncated or hand-edited file names no process, so it can hold
        // nothing. Throwing here would take down a dispatch pass over a
        // corrupt byte; deleting it restores the repository to a known state.
        clearDispatchLock(projectPath);
        return null;
    }

    if (!isAlive(pid)) {
        clearDispatchLock(projectPath);
        return null;
    }

    return {
        pid,
        taskId: typeof parsed.taskId === 'string' ? parsed.taskId : null,
        startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null
    };
}

module.exports = {
    dispatchLockPath, writeDispatchLock, clearDispatchLock, readDispatchLock,
    pidIsAlive
};
