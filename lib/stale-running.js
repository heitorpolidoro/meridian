'use strict';

// Whether a task's `running: true` flag is stale — nothing is actually
// working it. That flag is meant to be cleared by the plugin's stop hook
// when the agent session that set it ends, but a run that dies without the
// hook firing (killed, or the server restarted mid-run) leaves it behind
// with no process on the other end. Once dispatchEligibility refuses any
// task with `running: true` (see lib/dispatch-eligibility.js), a stale flag
// makes that task permanently undispatchable — detecting it is what lets
// the board offer a way out.
//
// The evidence, in order of strength:
//
//   - `task.running_session`: the id of the session that SET the flag,
//     recorded by the plugin's pre hook (plugin/.../scripts/running-flag.sh),
//     which already knows it — it names its own ledger after it. When a task
//     carries this, the question stops being a guess: the flag is stale when
//     that exact session is gone from the live list, and not stale while it
//     is there, idle or busy. Nothing else needs to be inferred.
//   - `lock`: this project's dispatch lock, as
//     lib/dispatch-lock.js#readDispatchLock returns it — null when the
//     project is free (no lock file, or the pid it named is dead).
//   - `sessions`: the parsed `claude agents --json` array, every kind
//     included (not just `background` — see lib/dispatch-sessions.js for why
//     that file filters to background only; this check deliberately does
//     not). `null` means the probe itself failed.
//
// A task with no `running_session` falls back to a heuristic, and the
// heuristic is the reason this file has a history worth reading. It first
// blocked the verdict while ANY session was live in the project directory —
// which is permanently true for an operator who keeps a session parked in
// each project, so the verdict could never fire at all. Narrowing it to a
// BUSY session fixed that and broke the other end: a session between turns
// reads idle, so a task being actively worked by hand reads stale. Neither
// is right, because neither can tell WHICH task a session is on. Only the
// recorded id can, which is why it is preferred whenever present; the
// heuristic survives for tasks whose flag was set before this was recorded,
// and for harnesses whose hook does not report a session id.
const path = require('node:path');

function normalisePath(dir) {
    if (typeof dir !== 'string' || !dir) return null;
    return path.normalize(dir).replace(/\/+$/, '') || '/';
}

function isRunningStale(task, { lock, sessions, projectPath } = {}) {
    if (!task || task.running !== true) return false;

    // Claimed by our own dispatch lock: a live pid this server (or a
    // previous instance of it) started for this exact task.
    if (lock && lock.taskId === task.id) return false;

    // The session that set the flag, when we know it. Present in the live
    // list — whatever its status — means it is still there to clear the flag
    // itself, and an idle session between turns is the ordinary case, not a
    // dead one. Gone from the list means nothing can ever clear it: stale,
    // with no inference involved.
    const marked = typeof task.running_session === 'string' && task.running_session
        ? task.running_session : null;
    if (marked) {
        // The probe failed, so the list proves nothing. Refusing to call it
        // stale is the only safe read: a probe that cannot see a session is
        // not evidence the session ended.
        if (!Array.isArray(sessions)) return false;
        return !sessions.some(s => s && s.sessionId === marked);
    }

    // No recorded session: fall back to the heuristic. A session busy in this
    // project's directory might be a human working this task by hand.
    // `sessions` null/undefined reads as an empty list here, preserving the
    // behaviour this path always had.
    const want = normalisePath(projectPath);
    const lockPid = lock && Number.isInteger(lock.pid) ? lock.pid : null;
    const hasBusySessionHere = Array.isArray(sessions) && sessions.some(
        s => s && want !== null
            && normalisePath(s.cwd) === want
            && s.status !== 'idle'
            && !(lockPid !== null && s.pid === lockPid)
    );
    if (hasBusySessionHere) return false;

    return true;
}

module.exports = { isRunningStale };
