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

// The five compact status names retired by the snake_case rename. Reads
// convert them; writes are normalized by the server through normalizeStatus,
// so sessions started before the rename keep working mid-flight. Remove the
// aliases once no pre-rename session can still be alive.
const STATUS_ALIASES = {
    specreview: 'spec_review',
    readytodo: 'ready_todo',
    inprogress: 'in_progress',
    codereview: 'code_review',
    qareview: 'qa_review'
};

function normalizeStatus(status) {
    return STATUS_ALIASES[status] || status;
}

// Read-path defaults for the fields introduced by the server-schema branch.
// Live files predate them, so every reader would otherwise have to re-implement
// the same defaults. Applied in memory; the next write persists them.
function backfillTasks(tasks) {
    for (const task of tasks) {
        if (task.status !== undefined) task.status = normalizeStatus(task.status);
        if (task.status === 'done' && task.completed_at === undefined) {
            task.completed_at = task.updated_at || null;
        }
        if (task.priority === undefined) {
            task.priority = 'medium';
        }
        if (task.moved_at === undefined && task.updated_at) {
            task.moved_at = task.updated_at;
        }
    }
    return tasks;
}

// Thrown when tasks.jsonl exists but cannot be understood. Callers must NOT fall
// back to an empty list: the read-modify-write cycle would then persist that
// empty list over the user's backlog. .meridian/ is gitignored, so there is no
// recovery from that.
class MalformedTasksError extends Error {
    constructor(tasksPath, cause) {
        super(`Malformed tasks.jsonl at ${tasksPath}: ${cause}`);
        this.name = 'MalformedTasksError';
        this.tasksPath = tasksPath;
    }
}

// Levantado quando só o formato antigo está presente. Um fallback silencioso
// para tasks.json deixaria duas fontes vivas para o mesmo estado, que é como um
// backlog se perde — o operador roda a migração e segue.
class LegacyTasksFileError extends Error {
    constructor(tasksPath) {
        super(`Legacy tasks.json at ${tasksPath}: run scripts/migrate-tasks-jsonl.js to convert this project to tasks.jsonl`);
        this.name = 'LegacyTasksFileError';
        this.tasksPath = tasksPath;
    }
}

function tasksPathFor(projPath) {
    return path.join(projPath, '.meridian', 'tasks.jsonl');
}

function getTasks(projPath) {
    const tasksPath = tasksPathFor(projPath);
    if (!fs.existsSync(tasksPath)) {
        const legacy = path.join(projPath, '.meridian', 'tasks.json');
        if (fs.existsSync(legacy)) throw new LegacyTasksFileError(legacy);
        return { tasks: [] };
    }
    const raw = fs.readFileSync(tasksPath, 'utf8');
    // Um arquivo vazio é indistinguível de uma truncagem — ler como lista vazia é
    // o caminho para sobrescrever o backlog no próximo saveTasks. saveTasks nunca
    // produz 0 bytes (uma lista vazia serializa como "\n", 1 byte). Assim só lança
    // se o arquivo é realmente vazio (0 bytes) ou contém só espaço em branco (não
    // é nem sequer a estrutura "\n" de uma lista vazia válida).
    if (raw === '' || (!raw.trim() && raw !== '\n')) {
        throw new MalformedTasksError(tasksPath, 'file is empty');
    }
    const tasks = [];
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        let parsed;
        try {
            parsed = JSON.parse(line);
        } catch (e) {
            // Aborta a leitura inteira: uma lista parcial seria reescrita por
            // cima do arquivo no próximo save, perdendo a task ilegível.
            throw new MalformedTasksError(tasksPath, `line ${i + 1}: ${e.message}`);
        }
        tasks.push(parsed);
    }
    return { tasks: backfillTasks(tasks) };
}

function saveTasks(projPath, tasksData) {
    const localMeridianDir = path.join(projPath, '.meridian');
    if (!fs.existsSync(localMeridianDir)) {
        fs.mkdirSync(localMeridianDir, { recursive: true });
    }
    const target = tasksPathFor(projPath);
    const payload = tasksData.tasks.map(t => JSON.stringify(t)).join('\n') + '\n';
    const tmp = path.join(localMeridianDir, `.tasks.jsonl.${process.pid}.${Date.now()}.tmp`);
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
    // A task can be created in any of the nine statuses — work that was already
    // finished gets recorded as `done`, not walked through the pipeline. The
    // same rule as stampTaskUpdate applies: entering `done` sets completed_at.
    if (task.status === 'done') task.completed_at = now;
    return task;
}

function stampTaskUpdate(task, prevStatus) {
    const now = new Date().toISOString();
    task.updated_at = now;
    if (task.status !== prevStatus) {
        // A resume note describes the exact point a stage was interrupted at.
        // Once the task moves, that point no longer exists — stale directions
        // are worse than none. A caller setting a fresh note in the same
        // request reapplies it after stamping.
        delete task.resume_context;
        task.moved_at = now;
        if (task.status === 'done') {
            task.completed_at = now;
        } else if (prevStatus === 'done') {
            task.completed_at = null;
        }
    }
    return task;
}

module.exports = { deriveKey, nextTaskId, getTasks, saveTasks, stampNewTask, stampTaskUpdate, normalizeStatus, MalformedTasksError, LegacyTasksFileError };
