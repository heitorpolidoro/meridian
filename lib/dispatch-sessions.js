'use strict';

// The one-session-per-repository lock, derived from `claude agents --json`
// rather than stored.
//
// Derived matters: a process that died is gone from that list on its own, so
// the lock cannot stick the way a stored flag would. This is the same lesson
// the orphaned `running` flag taught.
//
// Only `kind: "background"` counts. The operator's own interactive session in
// the repo is not a lock — locking the board out because a terminal is open
// would make the feature useless on the machine it runs on.

const path = require('node:path');

function normalise(dir) {
    if (typeof dir !== 'string' || !dir) return null;
    return path.normalize(dir).replace(/\/+$/, '') || '/';
}

function backgroundSessionFor(agentsJson, projectPath) {
    const want = normalise(projectPath);
    if (!want) return null;

    let list;
    try {
        list = JSON.parse(agentsJson);
    } catch (err) {
        // Absent CLI, a banner, a partial write. No session, not a lock.
        return null;
    }
    if (!Array.isArray(list)) return null;

    // Exact cwd only. Prefix matching would let a session in one subfolder
    // lock the parent repository out of dispatching.
    const hit = list.find(s =>
        s && s.kind === 'background' && normalise(s.cwd) === want);

    return hit ? { pid: hit.pid, sessionId: hit.sessionId } : null;
}

module.exports = { backgroundSessionFor };
