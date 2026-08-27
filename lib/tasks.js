'use strict';

const fs = require('node:fs');
const path = require('node:path');

function deriveKey(name) {
    const words = name.trim().split(/[\s_\-]+/).filter(Boolean);
    if (words.length === 1) {
        return words[0].substring(0, 5).toUpperCase();
    }
    return words.map(w => w[0]).join('').toUpperCase();
}

function nextTaskId(tasks, key) {
    const prefix = key + '-';
    let max = 0;
    for (const t of tasks) {
        if (typeof t.id === 'string' && t.id.startsWith(prefix)) {
            const n = parseInt(t.id.slice(prefix.length), 10);
            if (!isNaN(n) && n > max) max = n;
        }
    }
    return `${key}-${max + 1}`;
}

function backfillCompletedAt(tasks) {
    for (const task of tasks) {
        if (task.status === 'done' && task.completed_at === undefined) {
            task.completed_at = task.updated_at || null;
        }
    }
    return tasks;
}

// Thrown when tasks.json exists but cannot be understood. Callers must NOT fall
// back to an empty list: the read-modify-write cycle would then persist that
// empty list over the user's backlog. .meridian/ is gitignored, so there is no
// recovery from that.
class MalformedTasksError extends Error {
    constructor(tasksPath, cause) {
        super(`Malformed tasks.json at ${tasksPath}: ${cause}`);
        this.name = 'MalformedTasksError';
        this.tasksPath = tasksPath;
    }
}

function getTasks(projPath) {
    const tasksPath = path.join(projPath, '.meridian', 'tasks.json');
    if (!fs.existsSync(tasksPath)) {
        return { tasks: [] };
    }
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
    } catch (e) {
        throw new MalformedTasksError(tasksPath, e.message);
    }
    if (Array.isArray(parsed)) {
        return { tasks: backfillCompletedAt(parsed) };
    }
    if (parsed && typeof parsed === 'object' && (parsed.tasks === undefined || Array.isArray(parsed.tasks))) {
        return { tasks: backfillCompletedAt(parsed.tasks || []) };
    }
    throw new MalformedTasksError(tasksPath, 'expected an array of tasks');
}

// Atomic write: serialize first, land it on a sibling temp file, then rename.
// rename(2) within a directory is atomic, so a crash or a concurrent reader can
// never observe a half-written tasks.json — the failure mode that produces the
// malformed files getTasks now refuses to overwrite.
function saveTasks(projPath, tasksData) {
    const localMeridianDir = path.join(projPath, '.meridian');
    if (!fs.existsSync(localMeridianDir)) {
        fs.mkdirSync(localMeridianDir, { recursive: true });
    }
    const target = path.join(localMeridianDir, 'tasks.json');
    const payload = JSON.stringify(tasksData.tasks, null, 2);
    const tmp = path.join(localMeridianDir, `.tasks.json.${process.pid}.${Date.now()}.tmp`);
    try {
        fs.writeFileSync(tmp, payload, 'utf8');
        fs.renameSync(tmp, target);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch (e) { /* nothing to clean up */ }
        throw err;
    }
}

function stampNewTask(task) {
    const now = new Date().toISOString();
    task.created_at = now;
    task.moved_at = now;
    task.updated_at = now;
    return task;
}

function stampTaskUpdate(task, prevStatus) {
    const now = new Date().toISOString();
    task.updated_at = now;
    if (task.status !== prevStatus) {
        task.moved_at = now;
        if (task.status === 'done') {
            task.completed_at = now;
        } else if (prevStatus === 'done') {
            task.completed_at = null;
        }
    }
    return task;
}

module.exports = { deriveKey, nextTaskId, getTasks, saveTasks, stampNewTask, stampTaskUpdate, MalformedTasksError };
