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
// Two pieces of evidence decide it, both already read elsewhere:
//   - `lock`: this project's dispatch lock, as
//     lib/dispatch-lock.js#readDispatchLock returns it — null when the
//     project is free (no lock file, or the pid it named is dead).
//   - `sessions`: the parsed `claude agents --json` array, every kind
//     included (not just `background` — see lib/dispatch-sessions.js for why
//     that file filters to background only; this check deliberately does
//     not, per the second bullet below).
//
// A task is CLAIMED, not stale, when the lock names this task id: something
// Meridian itself dispatched is still alive and working it. Otherwise, a
// session that is actually WORKING in this project's directory blocks the
// verdict: a human may be on this task by hand, outside the dispatch
// machinery, and there is no way to tell from here whether it is this task or
// another one. Being wrong in that direction costs nothing — the task stays
// undispatchable one more cycle, exactly as untidy as it already was — while
// wrongly clearing a live worker's flag would let a second agent land on top
// of it.
//
// "Working" is the load-bearing word, and it did not used to be: the first
// version of this check blocked on ANY live session in the directory. That
// makes the whole feature dead on the machine it runs on, because operators
// keep a Claude Desktop session parked in each project all day. An idle
// session has nothing in flight and cannot be mid-task, so it is not
// evidence. A session whose `status` the CLI does not report is counted as
// working — an older CLI should lose the feature, not misfire it.
//
// The lock's own pid is excluded too. A dispatch this server started shows up
// in that list as a busy `interactive` session, and it is already accounted
// for by the lock: without this, one running dispatch would suppress the
// stale verdict for every OTHER task in the same project.
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

    // A session busy in this project's directory might be a human working
    // this task by hand. `sessions` is null/undefined when the
    // `claude agents --json` probe failed, which reads the same as an empty
    // list: no visible session, never a manufactured stale positive from a
    // probe failure alone (the missing-lock case above already covers that).
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
