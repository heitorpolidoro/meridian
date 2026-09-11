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

// A task, and a detail file, must be a JSON object. Anything else — `null`,
// `42`, a bare array — parses fine and then fails deep inside the read path as
// a raw TypeError, which reaches the caller as a meaningless 500. Checked at
// the parse site so the error can name the line, or the file.
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
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

// O único campo que mora fora da linha: dominava o payload do board e nenhum
// consumidor daquela rota o lia — todo mundo pega uma task por vez, no dispatch.
const DETAIL_FIELD = 'expected_results';

function detailDir(projPath) {
    return path.join(projPath, '.meridian', 'tasks');
}

// Ids come from the request path and from whatever a board already holds, and
// they are interpolated straight into a filename. `../escaped` would write
// outside .meridian/tasks/ — deeper, outside the project. This is the single
// chokepoint every detail reader and writer goes through, so the assertion
// lives here rather than at each call site.
const SAFE_ID = /^[A-Za-z0-9_.-]+$/;

function assertSafeId(id) {
    if (typeof id !== 'string' || !SAFE_ID.test(id) || id === '.' || id === '..') {
        throw new Error(`Invalid task id ${JSON.stringify(id)}: a task id must be a non-empty string of letters, digits, '_', '.' or '-'`);
    }
    return id;
}

function detailPathFor(projPath, id) {
    return path.join(detailDir(projPath), `${assertSafeId(id)}.json`);
}

function writeAtomic(targetPath, payload) {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
    try {
        fs.writeFileSync(tmp, payload, 'utf8');
        fs.renameSync(tmp, targetPath);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch (e) { /* nothing to clean up */ }
        throw err;
    }
}

function deleteTaskDetail(projPath, id) {
    try {
        fs.unlinkSync(detailPathFor(projPath, id));
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
}

function readTaskDetail(projPath, id) {
    const p = detailPathFor(projPath, id);
    if (!fs.existsSync(p)) return [];
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
        throw new MalformedTasksError(p, e.message);
    }
    if (!isPlainObject(parsed)) {
        throw new MalformedTasksError(p, `expected an object with ${DETAIL_FIELD}, got ${Array.isArray(parsed) ? 'an array' : typeof parsed}`);
    }
    return Array.isArray(parsed[DETAIL_FIELD]) ? parsed[DETAIL_FIELD] : [];
}

function getTask(projPath, id) {
    const task = getTasks(projPath).tasks.find(t => t.id === id);
    if (!task) return null;
    task[DETAIL_FIELD] = readTaskDetail(projPath, id);
    return task;
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
        if (!isPlainObject(parsed)) {
            throw new MalformedTasksError(tasksPath, `line ${i + 1}: expected a task object, got ${Array.isArray(parsed) ? 'an array' : typeof parsed}`);
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
    // Detalhe primeiro, linha depois. Um crash no intervalo deixa um detalhe
    // adiantado, que é inerte — a linha é o que faz a task existir. A ordem
    // inversa deixaria resultados defasados numa task viva, e resultado
    // defasado é o erro que o QA não percebe.
    const lines = [];
    for (const task of tasksData.tasks) {
        const results = task[DETAIL_FIELD];
        if (results !== undefined) {
            // Ausente ≠ vazio: getTasks devolve tasks sem o campo, e tratar
            // ausência como vazio apagaria todo detalhe no primeiro save.
            if (Array.isArray(results) && results.length > 0) {
                writeAtomic(detailPathFor(projPath, task.id), JSON.stringify({ [DETAIL_FIELD]: results }));
            } else {
                deleteTaskDetail(projPath, task.id);
            }
        }
        const line = { ...task };
        delete line[DETAIL_FIELD];
        lines.push(JSON.stringify(line));
    }
    writeAtomic(tasksPathFor(projPath), lines.join('\n') + '\n');
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

module.exports = { deriveKey, nextTaskId, getTasks, saveTasks, getTask, deleteTaskDetail, stampNewTask, stampTaskUpdate, normalizeStatus, detailPathFor, assertSafeId, MalformedTasksError, LegacyTasksFileError };
