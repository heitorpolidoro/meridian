'use strict';

// Run output is written to a file as well as streamed.
//
// Streaming alone answers "what is it doing"; only a file answers "what did
// it do at 3am", and an operator opening the modal mid-run has already missed
// the beginning. Sits next to the existing .meridian/reports/ precedent.

const fs = require('node:fs');
const path = require('node:path');

// This id becomes a filename. The rule itself is owned by lib/tasks.js —
// isSafeTaskId is the single definition of what a task id may contain, and it
// rejects '.' and '..' on top of the character class. This module is the
// layer that keeps a traversal from landing outside .meridian/runs; it must
// not carry a second copy of the rule that could drift from the first.
const { isSafeTaskId } = require('./tasks');

function runsDir(projectPath) {
    return path.join(projectPath, '.meridian', 'runs');
}

// Colons are legal on the filesystems this runs on but make the name awkward
// to type and to complete, so the timestamp uses dashes throughout.
function stamp(now) {
    return now.toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-');
}

function runLogPath(projectPath, taskId, now) {
    if (!isSafeTaskId(taskId)) {
        throw new Error(`Unsafe task id for a run log: ${taskId}`);
    }
    return path.join(runsDir(projectPath), `${taskId}-${stamp(now)}.log`);
}

function appendRunLog(file, chunk) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, chunk);
}

// Newest first: the operator almost always wants the last run.
function listRunLogs(projectPath, taskId) {
    if (!isSafeTaskId(taskId)) return [];
    let names;
    try {
        names = fs.readdirSync(runsDir(projectPath));
    } catch (err) {
        return [];
    }
    return names
        .filter(n => n.startsWith(`${taskId}-`) && n.endsWith('.log'))
        .sort()
        .reverse()
        .map(n => path.join(runsDir(projectPath), n));
}

module.exports = { runLogPath, appendRunLog, listRunLogs };
