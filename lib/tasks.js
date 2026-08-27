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

function getTasks(projPath) {
    const tasksPath = path.join(projPath, '.meridian', 'tasks.json');
    if (fs.existsSync(tasksPath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
            if (Array.isArray(parsed)) {
                return { tasks: backfillCompletedAt(parsed) };
            }
            return { tasks: backfillCompletedAt(parsed.tasks || []) };
        } catch (e) {
            return { tasks: [] };
        }
    }
    return { tasks: [] };
}

function saveTasks(projPath, tasksData) {
    const localMeridianDir = path.join(projPath, '.meridian');
    if (!fs.existsSync(localMeridianDir)) {
        fs.mkdirSync(localMeridianDir, { recursive: true });
    }
    fs.writeFileSync(
        path.join(localMeridianDir, 'tasks.json'),
        JSON.stringify(tasksData.tasks, null, 2),
        'utf8'
    );
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

module.exports = { deriveKey, nextTaskId, getTasks, saveTasks, stampNewTask, stampTaskUpdate };
