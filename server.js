const express = require('express');
const fs = require('fs');
const path = require('path');
const { deriveKey, nextTaskId, getTasks, getTask, saveTasks, deleteTaskDetail, stampNewTask, stampTaskUpdate, normalizeStatus, MalformedTasksError, LegacyTasksFileError } = require('./lib/tasks');
const { ensureMeridianIgnored } = require('./lib/gitignore');
const { registerProject } = require('./lib/projects');
const { appendEvent } = require('./lib/events');
const { computeProjectStats, computeWorkspaceStats } = require('./lib/stats');

const app = express();
const PORT = process.env.PORT || 3333;
function findWorkspaceRoot(startDir) {
    let currentDir = startDir;
    while (currentDir !== '/') {
        if (fs.existsSync(path.join(currentDir, '.meridian', 'projects.json'))) {
            return currentDir;
        }
        currentDir = path.dirname(currentDir);
    }
    return startDir;
}

const RUNNING_DIR = process.env.MERIDIAN_RUNNING_DIR || process.cwd();
const WORKSPACE_DIR = findWorkspaceRoot(RUNNING_DIR);
const PROJECTS_JSON_PATH = path.join(WORKSPACE_DIR, '.meridian', 'projects.json');

function getBoilerplate() {
    return fs.readFileSync(path.join(__dirname, 'prompts', 'boilerplate.txt'), 'utf8');
}

// Os agentes do pipeline (pm, developer, qa, spec-generator, spec-reviewer,
// code-reviewer) são entregues pelo plugin Meridian, e só por ele. O servidor
// já gerou cópias deles em cada projeto a partir de templates locais; essa
// entrega foi aposentada porque duas fontes para o mesmo agente divergem — a
// do plugin dizia que o pm nunca despacha subagentes enquanto a gerada dizia
// que ele orquestra o pipeline. Quem orquestra é a skill `meridian:work`.

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Migrate from old projects.json to new decentralized architecture
function migrateProjects() {
    if (fs.existsSync(PROJECTS_JSON_PATH)) {
        try {
            const raw = fs.readFileSync(PROJECTS_JSON_PATH, 'utf8');
            let parsed = JSON.parse(raw);
            let migrated = false;
            let newProjectsList = { projects: [] };

            for (let proj of parsed.projects || []) {
                newProjectsList.projects.push({ path: proj.path });

                // If old properties exist (name, stack, purpose), it means it needs migration
                if (proj.name || proj.purpose) {
                    migrated = true;
                    const meridianDir = path.join(proj.path, '.meridian');
                    if (!fs.existsSync(meridianDir)) {
                        fs.mkdirSync(meridianDir, { recursive: true });
                    }
                    const infoPath = path.join(meridianDir, 'project-info.json');
                    
                    let info = {};
                    if (fs.existsSync(infoPath)) {
                        info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
                    }
                    
                    // Only overwrite if info doesn't have a name yet
                    if (!info.name) {
                        info.name = proj.name;
                        info.description = proj.purpose || info.description || '';
                        info.stack = proj.stack || info.stack || [];
                        fs.writeFileSync(infoPath, JSON.stringify(info, null, 2), 'utf8');
                    }
                }
            }

            if (migrated) {
                fs.writeFileSync(PROJECTS_JSON_PATH, JSON.stringify(newProjectsList, null, 2), 'utf8');
                console.log('Migrated old projects.json to decentralized architecture.');
            }
        } catch (err) {
            console.error('Error during migration:', err.message);
        }
    }
}

// Run migration on startup
migrateProjects();

const VALID_STATUSES = [
    'backlog', 'spec_review', 'ready_todo', 'in_progress', 'code_review',
    'qa_review', 'blocked', 'done', 'nope'
];
const PRIORITY_ORDER = ['critical', 'high', 'medium', 'low'];
const DEFAULT_PRIORITY = 'medium';

// An unknown priority must not out-rank `critical`, which is what a raw
// indexOf() miss (-1) would do. Anything unrecognised reads as the default.
function priorityRank(priority) {
    const idx = PRIORITY_ORDER.indexOf(priority);
    return idx === -1 ? PRIORITY_ORDER.indexOf(DEFAULT_PRIORITY) : idx;
}

// Rejects a write whose status/priority is outside the canonical set. Returns
// an error message, or null when the value is acceptable (absent counts as
// acceptable — the caller decides whether the field is required).
function validateTaskFields(body) {
    if (body.status !== undefined && !VALID_STATUSES.includes(body.status)) {
        return `Invalid status '${body.status}'. Allowed: ${VALID_STATUSES.join(', ')}`;
    }
    if (body.priority !== undefined && !PRIORITY_ORDER.includes(body.priority)) {
        return `Invalid priority '${body.priority}'. Allowed: ${PRIORITY_ORDER.join(', ')}`;
    }
    // Coercing a non-array to [] is not a harmless normalization here: an empty
    // expected_results means "delete the detail file", so `{"expected_results":
    // null}` — a plausible way for an agent to mean "leave it alone" — silently
    // destroyed the results. Absent still means absent; only a present value of
    // the wrong type is refused.
    if (body.expected_results !== undefined && !Array.isArray(body.expected_results)) {
        return `Invalid expected_results: expected an array, got ${body.expected_results === null ? 'null' : typeof body.expected_results}. Omit the field to leave it unchanged.`;
    }
    return null;
}

// Enforces one level of nesting. `taskId` is the id of the task being
// written (null on create, since the id doesn't exist yet — a brand-new
// task can neither be its own parent nor already have children).
// Returns an error message, or null when the value is acceptable.
function validateParentField(parentId, tasks, taskId) {
    if (taskId && parentId === taskId) {
        return 'A task cannot be its own parent';
    }
    const parentTask = tasks.find(t => t.id === parentId);
    if (!parentTask) {
        return `Parent task '${parentId}' does not exist on this board`;
    }
    if (parentTask.parent) {
        return `Parent task '${parentId}' already has a parent; only one level of nesting is allowed`;
    }
    if (taskId && tasks.some(t => t.parent === taskId)) {
        return `Task '${taskId}' already has sub-tasks and cannot be given a parent`;
    }
    return null;
}

// Turns an unreadable tasks.jsonl into a 500 rather than letting the caller
// read-modify-write an empty list over the user's backlog. This is the one
// error whose whole purpose is to stop a human from making it worse, so the
// response carries the instruction and the server keeps its own record.
function handleTaskReadError(err, res) {
    if (err instanceof MalformedTasksError || err instanceof LegacyTasksFileError) {
        console.error(err.message);
        res.status(500).json({ error: `${err.message} — refusing to write; fix the file by hand.` });
        return true;
    }
    return false;
}


// The scoped caller (a meridian:* skill) needs three things the capped task
// list cannot show: totals, tasks nobody is actually working, and dependencies
// that have since been satisfied. Each is an answer over the WHOLE board, and
// fetching the whole board to compute them client-side is how a 63-task project
// turns a status check into a 100 KB payload. The server already holds the
// list; it computes them here instead.

// The selection order meridian:next applies, computed where the data already
// is. Stage first — a task in qa_review is one verdict from shipping, a backlog
// task has not been specced — then priority within a stage, then oldest first.
// Priority deliberately never crosses stages: a critical idea does not outrank
// a low task that is nearly done. done, nope and blocked are not candidates at
// any priority, so they are not returned at all.
const WORKABLE_ORDER = ['qa_review', 'code_review', 'in_progress', 'ready_todo', 'spec_review', 'backlog'];

function workableTasks(tasks) {
    return tasks
        .filter(t => WORKABLE_ORDER.includes(t.status))
        .sort((a, b) => {
            const sa = WORKABLE_ORDER.indexOf(a.status), sb = WORKABLE_ORDER.indexOf(b.status);
            if (sa !== sb) return sa - sb;
            const pa = priorityRank(a.priority), pb = priorityRank(b.priority);
            if (pa !== pb) return pa - pb;
            return String(a.created_at || '').localeCompare(String(b.created_at || ''));
        });
}

function summarizeBoard(tasks) {
    const counts = {};
    const byId = new Map();
    for (const t of tasks) {
        counts[t.status] = (counts[t.status] || 0) + 1;
        byId.set(t.id, t);
    }

    const interrupted = tasks
        .filter(t => t.status === 'in_progress' || t.running === true)
        .map(t => ({ id: t.id, title: t.title, status: t.status, running: t.running === true }));

    // A blocked task whose dependencies are all done is waiting on nothing.
    // An empty blockedBy is a different case — blocked by an iteration cap or a
    // failure — and only a human clears those, so it is not listed here.
    const unblockable = tasks
        .filter(t => t.status === 'blocked'
            && Array.isArray(t.blockedBy) && t.blockedBy.length > 0
            && t.blockedBy.every(id => byId.get(id) && byId.get(id).status === 'done'))
        .map(t => ({ id: t.id, title: t.title, blockedBy: t.blockedBy }));

    return { counts, interrupted, unblockable };
}

function limitPerStatus(tasks, limit) {
    const byStatus = new Map();
    for (const task of tasks) {
        if (!byStatus.has(task.status)) byStatus.set(task.status, []);
        byStatus.get(task.status).push(task);
    }
    const out = [];
    for (const [status, list] of byStatus) {
        list.sort((a, b) => {
            if (status === 'done') {
                return String(b.completed_at || '').localeCompare(String(a.completed_at || ''));
            }
            const pa = priorityRank(a.priority || DEFAULT_PRIORITY);
            const pb = priorityRank(b.priority || DEFAULT_PRIORITY);
            if (pa !== pb) return pa - pb;
            return String(a.created_at || '').localeCompare(String(b.created_at || ''));
        });
        out.push(...list.slice(0, limit));
    }
    return out;
}

// Helper to fetch aggregated data from decentralized storage
function getStatusData(options = {}) {
    let data = { projects: [], errors: [] };
    try {
        if (fs.existsSync(PROJECTS_JSON_PATH)) {
            const raw = fs.readFileSync(PROJECTS_JSON_PATH, 'utf8');
            let parsed;
            try {
                parsed = JSON.parse(raw);
            } catch (err) {
                data.errors.push({ file: '.meridian/projects.json', message: 'Malformed JSON: ' + err.message });
                return data; // Exit early if we can't parse global projects
            }
            
            let matchedProject = false;
            for (const projEntry of parsed.projects || []) {
                const projPath = projEntry.path;
                if (options.project && path.resolve(projEntry.path) !== path.resolve(options.project)) continue;
                if (options.project) matchedProject = true;
                if (!fs.existsSync(projPath)) {
                    data.errors.push({ file: 'System', message: `Project path not found: ${projPath}` });
                    continue;
                }

                // Read project-info.json
                const infoPath = path.join(projPath, '.meridian', 'project-info.json');
                let info = { name: path.basename(projPath), description: '', stack: [] };
                if (fs.existsSync(infoPath)) {
                    try {
                        info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
                    } catch (err) {
                        data.errors.push({ file: `${info.name} (project-info.json)`, message: 'Malformed JSON: ' + err.message });
                    }
                }

                let tasksData = { tasks: [] };
                try {
                    tasksData = getTasks(projPath);
                } catch (err) {
                    data.errors.push({ file: `${info.name} (tasks.json)`, message: err.message });
                }
                
                const agentsMdPath = path.join(projPath, 'AGENTS.md');
                const hasAgentsMd = fs.existsSync(agentsMdPath);
                
                let missingMeridianRules = false;
                let outdatedMeridianRules = false;
                
                if (hasAgentsMd) {
                    try {
                        const content = fs.readFileSync(agentsMdPath, 'utf8');
                        const startTag = '<!-- MERIDIAN_INSTRUCTIONS_START -->';
                        const endTag = '<!-- MERIDIAN_INSTRUCTIONS_END -->';
                        const startIndex = content.indexOf(startTag);
                        const endIndex = content.indexOf(endTag);
                        
                        if (startIndex === -1 || endIndex === -1) {
                            missingMeridianRules = true;
                        } else {
                            const block = content.substring(startIndex, endIndex + endTag.length);
                            // Compare exact trimmed content without the leading \n\n
                            if (block.trim() !== getBoilerplate().trim()) {
                                outdatedMeridianRules = true;
                            }
                        }
                    } catch (err) {
                        console.error(`Error reading AGENTS.md for ${info.name}:`, err.message);
                    }
                }
                
                const stackArray = Array.isArray(info.stack) ? info.stack : (info.stack ? info.stack.split(',').map(s => s.trim()).filter(Boolean) : []);
                
                const relPath = path.relative(WORKSPACE_DIR, projPath) || path.basename(projPath);

                data.projects.push({
                    name: info.name,
                    key: info.key || '',
                    path: projPath,
                    relativePath: relPath,
                    stack: stackArray,
                    description: info.description,
                    tasks: options.workable ? workableTasks(tasksData.tasks || [])
                        : options.limit ? limitPerStatus(tasksData.tasks || [], options.limit)
                        : (tasksData.tasks || []),
                    ...(options.limit ? { summary: summarizeBoard(tasksData.tasks || []) } : {}),
                    missingAgentsMd: !hasAgentsMd,
                    missingMeridianRules: missingMeridianRules,
                    outdatedMeridianRules: outdatedMeridianRules,
                    missingStack: stackArray.length === 0,
                    missingDescription: !info.description || info.description.trim() === ''
                });
            }

            if (options.project && !matchedProject) {
                data.errors.push({ file: 'System', message: `Project not registered with Meridian: ${options.project}` });
            }
        } else {
             data.errors.push({ file: '.meridian/projects.json', message: 'File not found. Please create it or let Odin initialize it.' });
        }
    } catch (err) {
        console.error('Error fetching status data:', err.message);
        data.errors.push({ file: 'System', message: 'Internal Server Error: ' + err.message });
    }
    return data;
}

// REST API for initial load
app.get('/api/status', (req, res) => {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
    res.json(getStatusData({
        project: req.query.project,
        workable: req.query.workable === '1' || undefined,
        limit: Number.isInteger(limit) && limit > 0 ? limit : undefined
    }));
});

// REST API: on-demand stats aggregated from events.jsonl. Never cached —
// every request re-reads and re-aggregates the file from scratch.
app.get('/api/stats', (req, res) => {
    const projectPath = req.query.project;

    // No `project` key at all -> workspace-wide aggregate across every
    // registered project. A present-but-blank `?project=` still 400s, same
    // as today - only true absence of the query param changes meaning.
    if (projectPath === undefined) {
        const { tasks, stages, errors } = computeWorkspaceStats(WORKSPACE_DIR);
        return res.json({ project: null, generatedAt: new Date().toISOString(), tasks, stages, errors });
    }

    if (typeof projectPath !== 'string' || !projectPath.trim()) {
        return res.status(400).json({ error: 'project is required' });
    }
    if (!isRegisteredProject(projectPath)) {
        return res.json({
            project: projectPath,
            generatedAt: new Date().toISOString(),
            tasks: {},
            stages: {},
            errors: [{ file: 'System', message: `Project not registered with Meridian: ${projectPath}` }]
        });
    }
    const { tasks, stages } = computeProjectStats(projectPath);
    res.json({ project: projectPath, generatedAt: new Date().toISOString(), tasks, stages, errors: [] });
});

// REST API to list subdirectories in RUNNING_DIR
app.get('/api/directories', (req, res) => {
    try {
        const items = fs.readdirSync(RUNNING_DIR, { withFileTypes: true });
        
        // Load existing projects to filter them out
        let existingPaths = new Set();
        if (fs.existsSync(PROJECTS_JSON_PATH)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(PROJECTS_JSON_PATH, 'utf8'));
                (parsed.projects || []).forEach(p => existingPaths.add(p.path));
            } catch (e) {
                // Ignore parse errors here, let the status API handle reporting
            }
        }

        const dirs = items
            .filter(item => item.isDirectory() && !item.name.startsWith('.'))
            .filter(item => !existingPaths.has(path.resolve(RUNNING_DIR, item.name)))
            .map(item => item.name);
            
        res.json({ directories: dirs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// REST API to add a project
app.post('/api/projects', (req, res) => {
    try {
        const { name, path: rawPath, stack, description } = req.body;
        if (!name || !rawPath) {
            return res.status(400).json({ error: 'Name and path are required' });
        }

        const projPath = path.resolve(RUNNING_DIR, rawPath);

        const { registered } = registerProject({
            registryPath: PROJECTS_JSON_PATH, projPath, name, stack, description
        });
        if (!registered) {
            return res.status(409).json({ error: 'Project already exists' });
        }

        res.status(201).json({ success: true });
    } catch (err) {
        console.error('Error adding project:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// REST API to edit a project
app.put('/api/projects', (req, res) => {
    try {
        const { originalPath, name, stack, description, key } = req.body;
        if (!originalPath || !name) {
            return res.status(400).json({ error: 'Original path and name are required' });
        }

        let projectsList = { projects: [] };
        if (fs.existsSync(PROJECTS_JSON_PATH)) {
            projectsList = JSON.parse(fs.readFileSync(PROJECTS_JSON_PATH, 'utf8'));
        }

        const projIndex = projectsList.projects.findIndex(p => p.path === originalPath);
        if (projIndex === -1) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const projPath = projectsList.projects[projIndex].path;
        const localMeridianDir = path.join(projPath, '.meridian');
        if (!fs.existsSync(localMeridianDir)) {
            fs.mkdirSync(localMeridianDir, { recursive: true });
        }
        
        const infoPath = path.join(localMeridianDir, 'project-info.json');
        let infoData = { name: path.basename(projPath), stack: [], description: '' };
        if (fs.existsSync(infoPath)) {
            infoData = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
        }
        
        infoData.name = name;
        infoData.key = key && key.trim() ? key.trim().toUpperCase() : (infoData.key || deriveKey(name));
        infoData.stack = stack || [];
        infoData.description = description || '';
        
        fs.writeFileSync(infoPath, JSON.stringify(infoData, null, 2), 'utf8');

        res.json({ success: true, key: infoData.key });
    } catch (err) {
        console.error('Error editing project:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// O irmão hidratado de /api/status. O board não precisa de expected_results e
// não os recebe; quem despacha developer ou QA pega uma task por aqui.
app.get('/api/projects/tasks/:taskId', (req, res) => {
    try {
        const projectPath = req.query.project;
        if (!projectPath) {
            return res.status(400).json({ error: 'project is required' });
        }
        let task;
        try {
            task = getTask(projectPath, req.params.taskId);
        } catch (err) {
            if (handleTaskReadError(err, res)) return;
            throw err;
        }
        if (!task) {
            return res.status(404).json({ error: 'Task not found' });
        }
        res.json({ task });
    } catch (err) {
        console.error('Error reading task:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// REST API to add a task
app.post('/api/projects/tasks', (req, res) => {
    try {
        const { projectPath, title, status, blockedBy, expected_results, priority, justification } = req.body;
        if (!projectPath || !title) {
            return res.status(400).json({ error: 'projectPath and title are required' });
        }

        if (req.body && req.body.status) req.body.status = normalizeStatus(req.body.status);
        const invalid = validateTaskFields(req.body);
        if (invalid) {
            return res.status(400).json({ error: invalid });
        }

        let tasksData;
        try {
            tasksData = getTasks(projectPath);
        } catch (err) {
            if (handleTaskReadError(err, res)) return;
            throw err;
        }

        if (req.body.parent !== undefined && req.body.parent !== null) {
            const invalidParent = validateParentField(req.body.parent, tasksData.tasks, null);
            if (invalidParent) {
                return res.status(400).json({ error: invalidParent });
            }
        }

        // Derive key from project-info.json
        const infoPath = path.join(projectPath, '.meridian', 'project-info.json');
        let key = 'TASK';
        if (fs.existsSync(infoPath)) {
            try {
                const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
                key = info.key || deriveKey(info.name || path.basename(projectPath));
            } catch (e) { /* keep default */ }
        }

        const newTask = stampNewTask({
            id: nextTaskId(tasksData.tasks, key),
            title,
            status: normalizeStatus(status) || 'backlog',
            justification: justification || '',
            priority: priority || DEFAULT_PRIORITY,
            expected_results: Array.isArray(expected_results) ? expected_results : [],
            running: false,
            blockedBy: Array.isArray(blockedBy) ? blockedBy : [],
            ...(req.body.parent !== undefined && req.body.parent !== null ? { parent: req.body.parent } : {})
        });

        tasksData.tasks.push(newTask);
        saveTasks(projectPath, tasksData);

        appendEvent(projectPath, {
            task: newTask.id, field: 'status', from: null, to: newTask.status, at: newTask.created_at
        });

        res.status(201).json({ success: true, task: newTask });
    } catch (err) {
        console.error('Error adding task:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// REST API to update a task. Accepts the full task schema: status, title,
// justification, priority, spec_path, spec_iterations, code_review_iterations,
// qa_iterations, blockedBy, expected_results, last_review_findings, running.
// Timestamps (updated_at, moved_at, completed_at) are server-owned.
app.put('/api/projects/tasks/:taskId', (req, res) => {
    try {
        const { projectPath } = req.body;
        const taskId = req.params.taskId;

        if (!projectPath) {
            return res.status(400).json({ error: 'projectPath is required' });
        }

        if (req.body && req.body.status) req.body.status = normalizeStatus(req.body.status);
        const invalid = validateTaskFields(req.body);
        if (invalid) {
            return res.status(400).json({ error: invalid });
        }

        let tasksData;
        try {
            tasksData = getTasks(projectPath);
        } catch (err) {
            if (handleTaskReadError(err, res)) return;
            throw err;
        }
        const taskIndex = tasksData.tasks.findIndex(t => t.id === taskId);

        if (taskIndex === -1) {
            return res.status(404).json({ error: 'Task not found' });
        }

        const task = tasksData.tasks[taskIndex];
        const prevStatus = task.status;
        const prevRunning = task.running === true;

        if (req.body.parent !== undefined && req.body.parent !== null) {
            const invalidParent = validateParentField(req.body.parent, tasksData.tasks, taskId);
            if (invalidParent) {
                return res.status(400).json({ error: invalidParent });
            }
        }

        const scalarFields = [
            'status', 'justification', 'title', 'priority', 'spec_path',
            'spec_iterations', 'code_review_iterations', 'qa_iterations',
            'resume_context'
        ];
        for (const field of scalarFields) {
            if (req.body[field] !== undefined) task[field] = req.body[field];
        }
        if (req.body.blockedBy !== undefined) {
            task.blockedBy = Array.isArray(req.body.blockedBy) ? req.body.blockedBy : [];
        }
        if (req.body.expected_results !== undefined) {
            // validateTaskFields already refused a non-array: an empty one here
            // is a deliberate "delete the detail file", not a coercion accident.
            task.expected_results = req.body.expected_results;
        }
        if (req.body.last_review_findings !== undefined) {
            task.last_review_findings = Array.isArray(req.body.last_review_findings) ? req.body.last_review_findings : [];
        }
        if (req.body.parent === null) {
            delete task.parent;
        } else if (req.body.parent !== undefined) {
            task.parent = req.body.parent;
        }
        if (req.body.running !== undefined) task.running = Boolean(req.body.running);

        stampTaskUpdate(task, prevStatus);
        // The stamp clears resume_context on a status change; a note provided
        // in this same request is deliberate for the new position — keep it.
        if (req.body.resume_context !== undefined) task.resume_context = req.body.resume_context;

        saveTasks(projectPath, tasksData);

        if (task.status !== prevStatus) {
            appendEvent(projectPath, { task: task.id, field: 'status', from: prevStatus, to: task.status, at: task.moved_at });
        }
        const newRunning = task.running === true;
        if (newRunning !== prevRunning) {
            appendEvent(projectPath, { task: task.id, field: 'running', from: prevRunning, to: newRunning, at: task.updated_at });
        }

        res.json({ success: true, task: tasksData.tasks[taskIndex] });
    } catch (err) {
        console.error('Error updating task:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// REST API to delete a task
app.delete('/api/projects/tasks/:taskId', (req, res) => {
    try {
        const { projectPath } = req.body;
        const taskId = req.params.taskId;
        
        if (!projectPath) {
            return res.status(400).json({ error: 'projectPath is required' });
        }
        
        let tasksData;
        try {
            tasksData = getTasks(projectPath);
        } catch (err) {
            if (handleTaskReadError(err, res)) return;
            throw err;
        }
        const initialLen = tasksData.tasks.length;
        tasksData.tasks = tasksData.tasks.filter(t => t.id !== taskId);
        
        if (tasksData.tasks.length === initialLen) {
            return res.status(404).json({ error: 'Task not found' });
        }
        
        saveTasks(projectPath, tasksData);
        // The line is already gone: the delete succeeded. An orphan detail file
        // is inert on read and gets overwritten the next time that id is reused
        // (POST always writes expected_results), so it is not worth turning a
        // successful delete into a 500 — it is worth a line on stderr.
        try {
            deleteTaskDetail(projectPath, taskId);
        } catch (err) {
            console.error(`Task ${taskId} deleted, but its detail file could not be removed: ${err.message}`);
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting task:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// True when projectPath resolves to an entry already in PROJECTS_JSON_PATH's
// registry — the same comparison getStatusData uses for options.project.
function isRegisteredProject(projectPath) {
    if (!fs.existsSync(PROJECTS_JSON_PATH)) return false;
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(PROJECTS_JSON_PATH, 'utf8'));
    } catch (err) {
        return false;
    }
    return (parsed.projects || []).some(p => path.resolve(p.path) === path.resolve(projectPath));
}

// REST API to log a per-dispatch token usage event. Unlike the task CRUD
// routes, this endpoint has no other integrity check on what it appends to
// events.jsonl, so it rejects an unregistered projectPath outright.
app.post('/api/projects/events', (req, res) => {
    try {
        const { projectPath, task, type, agent, output_tokens, context_tokens } = req.body;

        if (typeof projectPath !== 'string' || !projectPath) {
            return res.status(400).json({ error: 'projectPath is required' });
        }
        if (!isRegisteredProject(projectPath)) {
            return res.status(400).json({ error: `Project not registered with Meridian: ${projectPath}` });
        }
        if (typeof task !== 'string' || !task.trim()) {
            return res.status(400).json({ error: 'task is required' });
        }
        if (type !== 'dispatch_tokens') {
            return res.status(400).json({ error: `Invalid type '${type}'. Allowed: dispatch_tokens` });
        }
        if (typeof output_tokens !== 'number' || !Number.isFinite(output_tokens)) {
            return res.status(400).json({ error: 'output_tokens must be a finite number' });
        }
        if (typeof context_tokens !== 'number' || !Number.isFinite(context_tokens)) {
            return res.status(400).json({ error: 'context_tokens must be a finite number' });
        }
        if (agent !== undefined && typeof agent !== 'string') {
            return res.status(400).json({ error: 'agent must be a string' });
        }

        const event = {
            task,
            type: 'dispatch_tokens',
            output_tokens,
            context_tokens,
            at: new Date().toISOString()
        };
        if (typeof agent === 'string') event.agent = agent;
        appendEvent(projectPath, event);

        res.status(201).json({ success: true });
    } catch (err) {
        console.error('Error logging dispatch_tokens event:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// REST API to fix project issues with AI
app.post('/api/fix-with-ai', (req, res) => {
    try {
        const { projectPath, tool = 'agy', fixes } = req.body;
        const selectedTool = tool || 'agy';
        if (!projectPath || !fixes || !Array.isArray(fixes)) {
            return res.status(400).json({ error: 'projectPath and fixes array are required' });
        }

        // Validate it's a known project
        let projectsList = { projects: [] };
        if (fs.existsSync(PROJECTS_JSON_PATH)) {
            projectsList = JSON.parse(fs.readFileSync(PROJECTS_JSON_PATH, 'utf8'));
        }
        if (!projectsList.projects.find(p => p.path === projectPath)) {
            return res.status(404).json({ error: 'Project not found' });
        }
        
        // Return immediately so UI doesn't block
        res.status(202).json({ success: true, message: 'Fixes started' });

        const { spawn } = require('child_process');
        
        // Send a specific progress update via SSE
        const sendProgress = (msg, percent, type = 'progress') => {
            const payload = `data: ${JSON.stringify({ type: 'fix-progress', projectPath, data: { status: type, message: msg, percent } })}\n\n`;
            clients.forEach(c => c.write(payload));
        };
        
        const runFix = async (fixName, index, total) => {
            return new Promise((resolve, reject) => {
                const percent = Math.round((index / total) * 100);
                
                let promptTemplatePath = '';
                let defaultPromptText = '';
                let cmdString = '';

                if (fixName === 'meridian-rules') {
                    sendProgress('Updating Meridian Rules (System)...', percent);
                    try {
                        const agentsPath = path.join(projectPath, 'AGENTS.md');
                        if (!fs.existsSync(agentsPath)) {
                            fs.writeFileSync(agentsPath, '# AGENTS.md\n', 'utf8');
                        }
                        let content = fs.readFileSync(agentsPath, 'utf8');
                        
                        const startTag = '<!-- MERIDIAN_INSTRUCTIONS_START -->';
                        const endTag = '<!-- MERIDIAN_INSTRUCTIONS_END -->';
                        const startIndex = content.indexOf(startTag);
                        const endIndex = content.indexOf(endTag);
                        
                        if (startIndex !== -1 && endIndex !== -1) {
                            // Replace old rules
                            content = content.substring(0, startIndex) + content.substring(endIndex + endTag.length);
                        }
                        content += getBoilerplate();
                        
                        fs.writeFileSync(agentsPath, content, 'utf8');
                        sendProgress('Meridian Rules injected successfully! 🚀\n', percent, 'log');
                        return resolve();
                    } catch (e) {
                        return reject(new Error('Failed to update Meridian Rules: ' + e.message));
                    }
                } else if (fixName === 'agents') {
                    sendProgress('Generating AGENTS.md...', percent);
                    promptTemplatePath = path.join(__dirname, 'prompts', 'agents.txt');
                    defaultPromptText = `Write an AGENTS.md file in the root directory detailing the project context, architecture, stack, and domain concepts. Write the final output ONLY to AGENTS.md.`;
                } else if (fixName === 'stack') {
                    sendProgress('Analyzing stack...', percent);
                    promptTemplatePath = path.join(__dirname, 'prompts', 'stack.txt');
                    defaultPromptText = `Analyze this codebase and determine the core technologies, languages, and frameworks used.\nRewrite the 'stack' field in the \`.meridian/project-info.json\` file with a JSON array of strings containing these technologies.\nDo not change any other fields in the JSON. Write the updated JSON back to the file.`;
                } else if (fixName === 'description') {
                    sendProgress('Analyzing description...', percent);
                    promptTemplatePath = path.join(__dirname, 'prompts', 'description.txt');
                    defaultPromptText = `Analyze this codebase and write a concise, one-sentence description of the project's purpose.\nRewrite the 'description' field in the \`.meridian/project-info.json\` file with this text.\nDo not change any other fields in the JSON. Write the updated JSON back to the file.`;
                } else {
                    return resolve(); // Unknown fix
                }

                let promptText = '';
                if (fs.existsSync(promptTemplatePath)) {
                    promptText = fs.readFileSync(promptTemplatePath, 'utf8');
                } else {
                    promptText = defaultPromptText;
                }

                promptText += `\n\nCRITICAL INSTRUCTION: You are analyzing the project located EXACTLY in "${projectPath}". You MUST NOT scan, read, or infer context from parent directories. Limit your analysis ONLY to the contents of the current working directory. You MUST NOT execute shell/terminal commands (e.g. ls, git, cd). Use file reading and editing tools ONLY.`;

                if (tool === 'claude') {
                    cmdString = `claude -p "$PROMPT" --tools "Edit,Read,Write,Glob,Grep" --permission-mode acceptEdits`;
                } else if (tool === 'agy') {
                    cmdString = `agy -p "$PROMPT" --mode accept-edits --sandbox`;
                }

                const child = spawn(cmdString, { 
                    cwd: projectPath, 
                    shell: true,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env: {
                        ...process.env,
                        FORCE_COLOR: '1',
                        CI: '1',
                        PROMPT: promptText
                    }
                });

                child.stdout.on('data', (data) => {
                    sendProgress(data.toString(), percent, 'log');
                });

                child.stderr.on('data', (data) => {
                    sendProgress(data.toString(), percent, 'log');
                });

                child.on('error', (err) => {
                    reject(new Error(`Failed to start subprocess: ${err.message}`));
                });

                child.on('close', (code) => {
                    if (code !== 0) {
                        reject(new Error(`Process exited with code ${code}`));
                    } else {
                        if (fixName === 'agents') {
                            const agentsPath = path.join(projectPath, 'AGENTS.md');
                            if (fs.existsSync(agentsPath)) {
                                let content = fs.readFileSync(agentsPath, 'utf8');
                                // if it already has rules, skip or replace. for simplicity, append if missing
                                if (!content.includes('MERIDIAN_INSTRUCTIONS_START')) {
                                    fs.appendFileSync(agentsPath, getBoilerplate(), 'utf8');
                                }
                            }
                        }
                        resolve();
                    }
                });
            });
        };

        // Run sequentially
        (async () => {
            try {
                for (let i = 0; i < fixes.length; i++) {
                    await runFix(fixes[i], i, fixes.length);
                }
                sendProgress('All fixes complete! ✨', 100, 'complete');
                broadcastUpdate(); // refresh UI
            } catch (err) {
                console.error('Error running fixes:', err.message);
                sendProgress(err.message, 100, 'error');
                broadcastUpdate();
            }
        })();

    } catch (err) {
        console.error('Error starting fixes:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// SSE Setup
let clients = [];

app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    clients.push(res);
    
    res.write(`data: ${JSON.stringify({ type: 'init', data: getStatusData() })}\n\n`);

    req.on('close', () => {
        clients = clients.filter(client => client !== res);
    });
});

let debounceTimer = null;
function broadcastUpdate() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        const data = getStatusData();
        const payload = `data: ${JSON.stringify({ type: 'update', data })}\n\n`;
        clients.forEach(client => client.write(payload));
    }, 100);
}

// File watching logic
const watchers = new Map();

function setupWatchers() {
    // Clear old watchers
    for (const [key, watcher] of watchers.entries()) {
        try { watcher.close(); } catch (e) {}
    }
    watchers.clear();

    const watchPath = (targetPath, isDir = false) => {
        if (fs.existsSync(targetPath) && !watchers.has(targetPath)) {
            try {
                const watcher = fs.watch(targetPath, { recursive: isDir }, (eventType, filename) => {
                    broadcastUpdate();
                    // If projects.json changes or a directory changes, refresh watchers
                    if (targetPath === PROJECTS_JSON_PATH || isDir) {
                        setTimeout(setupWatchers, 300);
                    }
                });
                watchers.set(targetPath, watcher);
            } catch (err) {
                console.error(`Error watching ${targetPath}:`, err.message);
            }
        }
    };

    // Watch projects.json
    watchPath(PROJECTS_JSON_PATH);

    // Watch all project directories and their .meridian folders
    try {
        if (fs.existsSync(PROJECTS_JSON_PATH)) {
            const raw = fs.readFileSync(PROJECTS_JSON_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            (parsed.projects || []).forEach(proj => {
                const meridianDir = path.join(proj.path, '.meridian');
                if (!fs.existsSync(meridianDir)) {
                    try { fs.mkdirSync(meridianDir, { recursive: true }); } catch (e) {}
                }
                watchPath(meridianDir, true);
                
                const agentsMdPath = path.join(proj.path, 'AGENTS.md');
                watchPath(agentsMdPath);
            });
        }
    } catch (err) {
        console.error('Failed to setup task watchers:', err.message);
    }
}

// Initialize watchers
setupWatchers();

// SPA Fallback Route: Serve index.html for non-API GET routes
app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/')) {
        return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
    next();
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Meridian Dashboard running on http://localhost:${PORT}`);
        console.log(`Monitoring directory: ${RUNNING_DIR}`);
    });
}

module.exports = app;
