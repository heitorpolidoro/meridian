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

function getTasks(projPath) {
    const tasksPath = path.join(projPath, '.meridian', 'tasks.json');
    if (fs.existsSync(tasksPath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
            if (Array.isArray(parsed)) {
                return { tasks: parsed };
            }
            return { tasks: parsed.tasks || [] };
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
    tasksData.lastUpdated = new Date().toISOString();
    fs.writeFileSync(path.join(localMeridianDir, 'tasks.json'), JSON.stringify(tasksData, null, 2), 'utf8');
}

module.exports = { deriveKey, nextTaskId, getTasks, saveTasks };
