const express = require('express');
const fs = require('fs');
const path = require('path');
const { deriveKey, nextTaskId, getTasks, getTask, saveTasks, deleteTaskDetail, stampNewTask, stampTaskUpdate, normalizeStatus, MalformedTasksError, LegacyTasksFileError } = require('./lib/tasks');
const { TOOLS, PROBES, AGY_INSTALL_DIR, parsePluginState, parseReadiness, isCliMissing, nextAction, commandFor, ptyWrap, needsPty } = require('./lib/tooling');
const { comparePluginTrees, readInstalledVersion } = require('./lib/plugin-sync');
const { ensureMeridianIgnored } = require('./lib/gitignore');
const { registerProject } = require('./lib/projects');
const { appendEvent } = require('./lib/events');
const { computeProjectStats, computeWorkspaceStats } = require('./lib/stats');
const {
    createDispatchState, enqueue, dequeue, pullNext, requeueFront, queueFor, setAuto, isAuto
} = require('./lib/dispatch-queue');
const { backgroundSessionFor } = require('./lib/dispatch-sessions');
const { dispatchCommand, DISPATCH_TIMEOUT_MS } = require('./lib/dispatch-command');
const { dispatchEligibility, NO_ALLOWLIST_REASON } = require('./lib/dispatch-eligibility');
const { dispatchOutcome } = require('./lib/dispatch-outcome');
const { runLogPath, appendRunLog } = require('./lib/run-log');
const { detectRunner, allowlistFor } = require('./lib/allowlist-template');

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
    'backlog', 'spec_review', 'spec_approval', 'ready_todo', 'in_progress', 'code_review',
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
    if (body.questions !== undefined && !Array.isArray(body.questions)) {
        return `Invalid questions: expected an array, got ${body.questions === null ? 'null' : typeof body.questions}. Omit the field to leave it unchanged.`;
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

// Whether `projectPath` has a `.claude/settings.json` declaring at least one
// `permissions.allow` entry, and whether that file exists at all. The two
// are kept apart because the UI's "Create allowlist" button must never
// appear over a file the operator wrote themselves — only true absence of
// the file offers it, even when that file's `permissions.allow` is empty or
// missing.
function projectAllowlist(projectPath) {
    const settingsPath = path.join(projectPath, '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) return { hasFile: false, hasAllow: false };
    try {
        const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        const allow = parsed && parsed.permissions && Array.isArray(parsed.permissions.allow)
            ? parsed.permissions.allow : [];
        return { hasFile: true, hasAllow: allow.length > 0 };
    } catch (err) {
        // Malformed JSON is a file the operator wrote and got wrong, not one
        // Meridian may overwrite or pretend does not exist.
        return { hasFile: true, hasAllow: false };
    }
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

                const allowlist = projectAllowlist(projPath);

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
                    missingDescription: !info.description || info.description.trim() === '',
                    queue: queueFor(dispatchState, projPath),
                    autoDispatch: isAuto(dispatchState, projPath),
                    dispatchBlockedReason: running.has(projPath)
                        ? `a run is in flight (${running.get(projPath).taskId})`
                        : (allowlist.hasAllow ? null : NO_ALLOWLIST_REASON),
                    // Only true absence of the file offers to create one — a
                    // file the operator wrote with an empty or missing
                    // `permissions.allow` is not ours to complete.
                    canCreateAllowlist: !allowlist.hasFile,
                    lastRun: lastRun.get(projPath) || null
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

// The plugin directory the Antigravity install command points at. Resolved
// here rather than sent by the client: the client names an action, never a
// path, and never a command.
const PLUGIN_DIR = path.join(__dirname, 'plugin', 'plugins', 'meridian');

// Runs one of the fixed probe commands and hands back its stdout and exit
// code. A CLI that is not installed at all rejects with ENOENT, which reads
// as "not installed / not ready" rather than crashing the request.
function runTooling(argv, timeoutMs = 20000, onChunk = null) {
    return new Promise(resolve => {
        const child = require('child_process').spawn(argv[0], argv.slice(1), {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let out = '', err = '', timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
        }, timeoutMs);
        const take = (buf, isErr) => {
            const text = buf.toString();
            if (isErr) err += text; else out += text;
            if (onChunk) onChunk(text);
        };
        child.stdout.on('data', d => take(d, false));
        child.stderr.on('data', d => take(d, true));
        child.on('error', e => { clearTimeout(timer); resolve({ stdout: '', stderr: e.message, code: 127, timedOut }); });
        child.on('close', code => { clearTimeout(timer); resolve({ stdout: out, stderr: err, code, timedOut }); });
    });
}

// The live background session for a project, or null. Derived on demand from
// the CLI rather than tracked, so a process that died releases the lock by
// disappearing.
async function liveSessionFor(projectPath) {
    const probe = await runTooling(['claude', 'agents', '--json'], 10000);
    return backgroundSessionFor(probe.stdout, projectPath);
}

// Pushes a chunk of a running tooling command to every connected board, so the
// settings screen can show the login URL while the command is still waiting
// for its callback rather than only after it returns.
function broadcastToolingOutput(cli, chunk) {
    const payload = `data: ${JSON.stringify({ type: 'tooling-output', cli, chunk })}\n\n`;
    clients.forEach(c => { try { c.write(payload); } catch (e) { /* client went away */ } });
}

// Claude reports where it put the copy; Antigravity always uses one path.
// A null means the copy cannot be located, and the screen then says nothing
// about drift rather than guessing.
function installedPluginDir(cli, pluginListStdout) {
    if (cli === 'agy') return AGY_INSTALL_DIR;
    try {
        const entry = JSON.parse(pluginListStdout).find(p => String(p.id).split('@')[0] === 'meridian');
        return entry && entry.installPath ? entry.installPath : null;
    } catch (err) {
        return null;
    }
}

// REST API: what the settings screen shows for each CLI — whether the plugin
// is installed, whether the CLI could actually run a dispatch, and the single
// action that follows from that, rendered as the exact command it will run.
app.get('/api/tooling', async (req, res) => {
    try {
        const tools = [];
        for (const [cli, meta] of Object.entries(TOOLS)) {
            const probes = PROBES[cli];
            const [pluginOut, readyOut] = await Promise.all([
                runTooling(probes.plugin),
                runTooling(probes.ready)
            ]);
            // A CLI that is not on this machine is its own state. Without it
            // the screen reports "plugin not installed" and prints the spawn
            // error as a readiness reason, and the button offers an action
            // against a binary that does not exist.
            const missing = isCliMissing(pluginOut, readyOut);
            const plugin = parsePluginState(cli, pluginOut.stdout);
            const readiness = missing
                ? { ready: false, reason: null }
                : parseReadiness(cli, readyOut.stdout || readyOut.stderr, readyOut.code);

            // Neither CLI reports a version that moves when a file changes, so
            // "is it current" is answered by comparing content with this repo.
            let sync = { current: null, drifted: 0 };
            // The version the CLI reports is not the one the plugin declares:
            // Antigravity reports none and Claude reports the revision it
            // installed from. The copy's own manifest is the honest answer.
            let declaredVersion = null;
            if (plugin.installed && !missing) {
                const installedDir = installedPluginDir(cli, pluginOut.stdout);
                if (installedDir) {
                    const cmp = comparePluginTrees(PLUGIN_DIR, installedDir);
                    sync = { current: cmp.current, drifted: cmp.differing.length + cmp.missing.length };
                    declaredVersion = readInstalledVersion(installedDir);
                }
            }

            const action = nextAction(cli, {
                present: !missing, installed: plugin.installed, ready: readiness.ready, current: sync.current
            });
            const command = commandFor(cli, action, { pluginDir: PLUGIN_DIR });
            tools.push({
                cli,
                label: meta.label,
                icon: meta.icon,
                present: !missing,
                installUrl: meta.installUrl,
                installed: plugin.installed,
                version: declaredVersion || plugin.version,
                ready: readiness.ready,
                reason: readiness.reason,
                current: sync.current,
                drifted: sync.drifted,
                action,
                command: command ? command.display : null
            });
        }
        res.json({ tools, generatedAt: new Date().toISOString() });
    } catch (err) {
        console.error('Error reading tooling state:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Runs one of the fixed actions. The body names `cli` and `action`; anything
// that does not resolve in the command table is refused, which is what keeps
// this endpoint from being a shell.
app.post('/api/tooling/:cli/:action', async (req, res) => {
    const { cli, action } = req.params;
    const command = commandFor(cli, action, { pluginDir: PLUGIN_DIR });
    if (!command) {
        return res.status(400).json({ error: `Unknown action ${cli}/${action}` });
    }
    // Login needs a real terminal — a plain spawn hands it pipes and it will
    // not proceed — and it waits for a browser callback, so it gets a pty, a
    // longer leash, and its output streamed while it waits. Meridian still
    // never sees a credential: the CLI opens the browser and stores its own
    // token.
    const pty = needsPty(action);
    const argv = pty ? ptyWrap(command.argv) : command.argv;
    const timeoutMs = pty ? 300000 : 120000;
    try {
        const result = await runTooling(argv, timeoutMs, pty ? chunk => broadcastToolingOutput(cli, chunk) : null);
        const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
        res.json({
            ok: result.code === 0 && !result.timedOut,
            code: result.code,
            command: command.display,
            timedOut: Boolean(result.timedOut),
            output: result.timedOut ? `${output}\n\n[timed out after ${Math.round(timeoutMs / 1000)}s]`.trim() : output
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Dispatch: the client names a project, a task and a tool. It never sends a
// command — lib/dispatch-command.js owns that, the same way lib/tooling.js
// owns the settings screen's commands.
//
// Registration is checked with isRegisteredProject (defined below, hoisted)
// rather than a second copy of the same lookup.
//
// isRegisteredProject calls path.resolve on whatever it is given, which
// throws a TypeError on anything but a string. Every route below must refuse
// a missing or non-string project value before it reaches that call, not
// after — this one guard is shared so a future endpoint cannot forget it.
function missingProjectReason(field, value) {
    if (typeof value !== 'string' || !value) return `${field} is required`;
    return null;
}

app.post('/api/projects/dispatch', (req, res) => {
    const { projectPath, taskId, tool } = req.body || {};
    const projectError = missingProjectReason('projectPath', projectPath);
    if (projectError) {
        return res.status(400).json({ error: projectError });
    }
    if (!taskId || !tool) {
        return res.status(400).json({ error: 'projectPath, taskId and tool are required' });
    }
    if (!isRegisteredProject(projectPath)) {
        return res.status(400).json({ error: `Unknown project ${projectPath}` });
    }
    // Validating here rather than at spawn time means an unknown tool or a
    // malformed id is rejected before it can sit in the queue.
    if (!dispatchCommand(tool, taskId)) {
        return res.status(400).json({ error: `Cannot dispatch ${taskId} with ${tool}` });
    }

    // The queue stores the task id alone. It becomes { taskId, tool } once a
    // tool selector lands in the UI; today every run uses `claude`, so the
    // validated-but-unused `tool` above is intentionally dropped here rather
    // than threaded through for a picker that does not exist yet.
    const added = enqueue(dispatchState, projectPath, taskId);
    broadcastUpdate();
    runDispatchLoop(projectPath);
    res.json({ ok: true, added, queue: queueFor(dispatchState, projectPath) });
});

app.delete('/api/projects/dispatch/:taskId', (req, res) => {
    const projectPath = req.query.project;
    const projectError = missingProjectReason('project', projectPath);
    if (projectError) {
        return res.status(400).json({ error: projectError });
    }
    if (!isRegisteredProject(projectPath)) {
        return res.status(400).json({ error: `Unknown project ${projectPath}` });
    }
    const removed = dequeue(dispatchState, projectPath, req.params.taskId);
    broadcastUpdate();
    res.json({ ok: true, removed, queue: queueFor(dispatchState, projectPath) });
});

app.post('/api/projects/dispatch/auto', (req, res) => {
    const { projectPath, enabled } = req.body || {};
    const projectError = missingProjectReason('projectPath', projectPath);
    if (projectError) {
        return res.status(400).json({ error: projectError });
    }
    if (!isRegisteredProject(projectPath)) {
        return res.status(400).json({ error: `Unknown project ${projectPath}` });
    }
    // Disabling clears the queue — `Stop queue` discards rather than suspends.
    setAuto(dispatchState, projectPath, Boolean(enabled));
    broadcastUpdate();
    if (enabled) runDispatchLoop(projectPath);
    res.json({ ok: true, autoDispatch: isAuto(dispatchState, projectPath) });
});

app.post('/api/projects/dispatch/stop', async (req, res) => {
    const { projectPath } = req.body || {};
    const projectError = missingProjectReason('projectPath', projectPath);
    if (projectError) {
        return res.status(400).json({ error: projectError });
    }
    if (!isRegisteredProject(projectPath)) {
        return res.status(400).json({ error: `Unknown project ${projectPath}` });
    }
    const { stopped, reason } = await stopDispatch(projectPath);
    broadcastUpdate();
    res.json({ ok: true, stopped, reason });
});

// Writes a starting-point `.claude/settings.json` for a registered project
// that has none. Meridian writes the file and stops there: it does not
// `git add` it, does not commit it, and does not tell the operator it has
// been committed — that stays a step the operator takes themselves.
app.post('/api/projects/allowlist', (req, res) => {
    const { projectPath } = req.body || {};
    const projectError = missingProjectReason('projectPath', projectPath);
    if (projectError) {
        return res.status(400).json({ error: projectError });
    }
    if (!isRegisteredProject(projectPath)) {
        return res.status(400).json({ error: `Unknown project ${projectPath}` });
    }
    const settingsDir = path.join(projectPath, '.claude');
    const settingsPath = path.join(settingsDir, 'settings.json');
    // Never overwrite. This is not an edge case to tolerate, it is the
    // point: a file the operator already wrote is theirs, not ours to
    // replace.
    if (fs.existsSync(settingsPath)) {
        return res.status(409).json({ error: '.claude/settings.json already exists' });
    }
    const runner = detectRunner(projectPath);
    const settings = allowlistFor(runner);
    try {
        fs.mkdirSync(settingsDir, { recursive: true });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
    broadcastUpdate();
    res.json({ ok: true, path: settingsPath, runner });
});

// One in-flight run per project: { child, taskId, tool, startedAt, logFile }.
const running = new Map();

// A pass that has begun but has not yet spawned anything. `running` cannot
// carry this: it is only filled after two awaited probes, and two clicks
// arriving inside that window would otherwise start two passes, pull two
// tasks and spawn two children for one repository.
const startingDispatch = new Set();

// SIGTERM lets the CLI end its session, which fires SessionEnd, which runs
// running-flag.sh, which clears `running` on the task and leaves a
// resume_context note. That is the same observable result as interrupting a
// session by hand — the behaviour the operator already knows. SIGKILL is
// strictly worse: no hook, so `running` stays stuck and no note is left. It
// is the fallback only.
const SIGKILL_GRACE_MS = 10000;

// Stops the run Meridian started for this project, and nothing else.
//
// A session this server did not start — one the operator launched from their
// own terminal, which liveSessionFor reports and which already blocks
// dispatch — is deliberately left alone: killing a process the operator is
// sitting in front of is not something a button on a board may do. The
// honest answer goes back to the caller as a reason, so the button explains
// itself instead of silently doing nothing.
//
// Returns { stopped, reason }.
async function stopDispatch(projectPath) {
    const run = running.get(projectPath);
    if (!run) {
        const session = await liveSessionFor(projectPath);
        if (session) {
            return {
                stopped: false,
                reason: 'a session is running in this repository that Meridian did not start — stop it where it was started'
            };
        }
        return { stopped: false, reason: null };
    }
    try {
        run.child.kill('SIGTERM');
    } catch (err) {
        return { stopped: false, reason: `could not signal the run: ${err.message}` };
    }
    setTimeout(() => {
        if (running.get(projectPath) === run) {
            try { run.child.kill('SIGKILL'); } catch (e) { /* already gone */ }
        }
    }, SIGKILL_GRACE_MS);
    return { stopped: true, reason: null };
}

// Appends to the run's log, and never lets that kill anything.
//
// Every caller is inside an EventEmitter listener, where a throw is an
// uncaught exception and this process is a long-lived server. The log is
// valuable — it is the only thing that answers "what did it do at 3am" —
// but it is never worth the server for: a write that fails degrades this
// run to streaming only, which continues regardless, and the operator still
// sees every chunk over SSE. mkdirSync already heals a directory that went
// missing; a permission or disk-space error does not heal, so it is
// reported once per run rather than once per chunk, which on a full disk
// would be once per line of agent output.
function logRun(run, text) {
    if (run.logBroken) return;
    try {
        appendRunLog(run.logFile, text);
    } catch (err) {
        run.logBroken = true;
        console.error(`Run log for ${run.taskId} disabled (${run.logFile}): ${err.message}`);
    }
}

function sendDispatch(payload) {
    const line = `data: ${JSON.stringify({ type: 'dispatch', ...payload })}\n\n`;
    clients.forEach(c => { try { c.write(line); } catch (e) { /* gone */ } });
}

function refuseDispatch(projectPath, taskId, reason) {
    // Discarded with a visible reason, never re-queued at the back: a task
    // whose blocker never lands would spin forever, and re-enqueueing is
    // one click.
    lastRun.set(projectPath, { taskId, ok: false, reason, endedAt: new Date().toISOString() });
    sendDispatch({ projectPath, taskId, state: 'refused', reason });
    broadcastUpdate();
}

// Pulls one task and runs it. Returns true when the caller should try again
// straight away — see the refusal below for the one case where that is safe.
async function dispatchOnePass(projectPath) {
    const authProbe = await runTooling(PROBES.claude.ready, 10000);
    const authenticated = parseReadiness('claude', authProbe.stdout || authProbe.stderr, authProbe.code).ready;
    const liveSession = await liveSessionFor(projectPath);

    let taskId = pullNext(dispatchState, projectPath);
    // Where the task came from decides what a refusal may do below, so it is
    // recorded here rather than inferred later from the queue's contents —
    // by then the queue has already been changed by this very pull.
    let fromQueue = taskId !== null;
    if (!taskId && isAuto(dispatchState, projectPath)) {
        // Pulled at dispatch time, not snapshotted when auto was armed: a
        // task created a minute ago has to be able to join.
        const { tasks } = getTasks(projectPath);
        taskId = (workableTasks(tasks).find(t => !t.skip_auto_dispatch) || {}).id || null;
        fromQueue = false;
    }
    if (!taskId) return false;

    const { tasks } = getTasks(projectPath);
    const allowlist = projectAllowlist(projectPath).hasAllow;
    const verdict = dispatchEligibility({ taskId, tasks, authenticated, liveSession, allowlist });
    if (!verdict.ok) {
        if (verdict.scope === 'environment') {
            // Transient and global: a logged-out CLI or a session holding
            // the repository says nothing about this task and applies
            // identically to every other one queued behind it. It lifts for
            // the whole queue at once — one `claude auth login`, or the
            // running session ending — so the queue the operator built is
            // kept exactly as it was. pullNext already took this task, so
            // put it back at the front rather than at the back: its
            // position was the operator's decision too.
            if (fromQueue) requeueFront(dispatchState, projectPath, taskId);
            refuseDispatch(projectPath, taskId, verdict.reason);
            // Never retry here. Nothing the next pass would read has
            // changed — with the task restored, it would pull the same one,
            // refuse it the same way and recurse forever, for a queued task
            // just as much as for an auto-pulled one.
            return false;
        }
        refuseDispatch(projectPath, taskId, verdict.reason);
        // Task-scoped: this one task may never become eligible, so it stays
        // discarded with its reason visible, and the pass moves on.
        //
        // Retry immediately ONLY for a queued task. pullNext has already
        // removed it, so the next pass sees a strictly shorter queue and the
        // chain is bounded by the queue's length.
        //
        // A task the auto mode picked is in no queue: refusing it changes
        // nothing that the next selection reads, so the same task would be
        // chosen again, refused again, and the loop would never end — it
        // would hang the server on its own stack. A `backlog` task with an
        // unmet blockedBy reaches exactly this path today, because
        // workableTasks() excludes `blocked` by status and nothing else.
        // Ending the pass is correct: the next broadcastUpdate, enqueue or
        // auto toggle starts a fresh one, by which time the board may have
        // changed. Do not "simplify" this back into an unconditional retry.
        return fromQueue;
    }

    const tool = 'claude';
    const command = dispatchCommand(tool, taskId);
    if (!command) {
        // Only reachable through the auto path: the endpoints validate the
        // id before it can be queued, but a board may hold an id that is not
        // safe to put in an argv or a filename. Refuse it the same way
        // rather than let runLogPath throw inside the loop.
        refuseDispatch(projectPath, taskId, `${taskId} cannot be dispatched with ${tool}`);
        return fromQueue;
    }
    const startedAt = new Date();
    const logFile = runLogPath(projectPath, taskId, startedAt);

    // argv, no shell: the task id never reaches a shell to be interpreted.
    const child = require('child_process').spawn(command.argv[0], command.argv.slice(1), {
        cwd: projectPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0', CI: '1' }
    });

    const run = { child, taskId, tool, startedAt, logFile };
    running.set(projectPath, run);

    let stdout = '';
    const killer = setTimeout(() => stopDispatch(projectPath), DISPATCH_TIMEOUT_MS);

    // Registered before anything that could throw, and before the first log
    // write in particular. The close handler is what deletes this project
    // from `running`; a throw between the spawn and this line would leave an
    // orphaned child, a project marked busy forever and no way back but a
    // restart.
    child.on('error', err => {
        logRun(run, `\n[spawn failed] ${err.message}\n`);
    });

    child.on('close', code => {
        clearTimeout(killer);
        running.delete(projectPath);
        const outcome = dispatchOutcome({ stdout, code });
        logRun(run, `\n[${outcome.ok ? 'ok' : 'failed'}] ${outcome.reason || outcome.summary}\n`);
        lastRun.set(projectPath, {
            taskId, tool,
            startedAt: startedAt.toISOString(),
            endedAt: new Date().toISOString(),
            exitCode: code,
            ok: outcome.ok,
            reason: outcome.reason
        });
        sendDispatch({ projectPath, taskId, state: outcome.ok ? 'done' : 'failed', reason: outcome.reason });
        broadcastUpdate();
        runDispatchLoop(projectPath);
    });

    const take = chunk => {
        const text = chunk.toString();
        stdout += text;
        logRun(run, text);
        sendDispatch({ projectPath, taskId, state: 'output', chunk: text });
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);

    logRun(run, `$ ${command.display}\n\n`);
    sendDispatch({ projectPath, taskId, state: 'started', command: command.display });
    broadcastUpdate();

    // The run owns the repository from here; the next pass starts when the
    // child closes, not now.
    return false;
}

// Runs passes until there is nothing left to do. Re-entrant by design: every
// path that can free the repository calls it, and the guards here make the
// extra calls no-ops.
async function runDispatchLoop(projectPath) {
    if (running.has(projectPath) || startingDispatch.has(projectPath)) return;
    startingDispatch.add(projectPath);
    let again = false;
    try {
        again = await dispatchOnePass(projectPath);
    } catch (err) {
        console.error(`Dispatch loop failed for ${projectPath}:`, err.message);
    } finally {
        // Released before any retry: the guard above would otherwise turn
        // this function's own recursive call into a no-op.
        startingDispatch.delete(projectPath);
    }
    if (again) return runDispatchLoop(projectPath);
}

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

        let spec_content = null;
        let mock_path = task.mock_path || null;
        let has_mock = false;
        const resolvedProject = path.resolve(projectPath);

        if (task.spec_path) {
            try {
                const resolvedSpec = path.isAbsolute(task.spec_path)
                    ? path.resolve(task.spec_path)
                    : path.resolve(resolvedProject, task.spec_path);
                const rel = path.relative(resolvedProject, resolvedSpec);
                if (!rel.startsWith('..') && !path.isAbsolute(rel) && fs.existsSync(resolvedSpec)) {
                    spec_content = fs.readFileSync(resolvedSpec, 'utf8');
                }
            } catch (e) {
                // Ignore failure to read spec
            }
        }

        // Detect mock path
        if (mock_path) {
            const resolvedMock = path.isAbsolute(mock_path)
                ? path.resolve(mock_path)
                : path.resolve(resolvedProject, mock_path);
            const rel = path.relative(resolvedProject, resolvedMock);
            if (!rel.startsWith('..') && !path.isAbsolute(rel) && fs.existsSync(resolvedMock)) {
                has_mock = true;
            }
        } else if (task.spec_path) {
            const candidates = [
                task.spec_path.replace(/-spec\.md$/i, '-mock.html'),
                task.spec_path.replace(/\.md$/i, '-mock.html'),
                task.spec_path.replace(/\.md$/i, '.html')
            ];
            for (const candidate of candidates) {
                if (candidate !== task.spec_path) {
                    const resolvedCand = path.isAbsolute(candidate)
                        ? path.resolve(candidate)
                        : path.resolve(resolvedProject, candidate);
                    const rel = path.relative(resolvedProject, resolvedCand);
                    if (!rel.startsWith('..') && !path.isAbsolute(rel) && fs.existsSync(resolvedCand)) {
                        mock_path = candidate;
                        has_mock = true;
                        break;
                    }
                }
            }
        }

        res.json({ task, spec_content, mock_path, has_mock });
    } catch (err) {
        console.error('Error reading task:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Endpoint to read Markdown spec content safely within the project folder
app.get('/api/projects/spec', (req, res) => {
    try {
        const { projectPath, specPath } = req.query;
        if (!projectPath || !specPath) {
            return res.status(400).json({ error: 'projectPath and specPath are required' });
        }
        const resolvedProject = path.resolve(projectPath);
        const resolvedSpec = path.isAbsolute(specPath)
            ? path.resolve(specPath)
            : path.resolve(resolvedProject, specPath);
        const rel = path.relative(resolvedProject, resolvedSpec);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            return res.status(403).json({ error: 'Access denied: spec path outside project' });
        }
        if (!fs.existsSync(resolvedSpec)) {
            return res.status(404).json({ error: 'Spec file not found' });
        }
        const content = fs.readFileSync(resolvedSpec, 'utf8');
        res.json({ content, path: specPath });
    } catch (err) {
        console.error('Error reading spec:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Endpoint to serve standalone interactive HTML mockup safely
app.get('/api/projects/mock', (req, res) => {
    try {
        const { projectPath, mockPath } = req.query;
        if (!projectPath || !mockPath) {
            return res.status(400).send('projectPath and mockPath are required');
        }
        const resolvedProject = path.resolve(projectPath);
        const resolvedMock = path.isAbsolute(mockPath)
            ? path.resolve(mockPath)
            : path.resolve(resolvedProject, mockPath);
        const rel = path.relative(resolvedProject, resolvedMock);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            return res.status(403).send('Access denied: mock path outside project');
        }
        if (!fs.existsSync(resolvedMock)) {
            return res.status(404).send('Mockup file not found');
        }
        const content = fs.readFileSync(resolvedMock, 'utf8');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(content);
    } catch (err) {
        console.error('Error serving mock:', err.message);
        res.status(500).send(err.message);
    }
});

// Endpoint to serve project images and screenshots safely
app.get('/api/projects/asset', (req, res) => {
    try {
        const { projectPath, assetPath } = req.query;
        if (!projectPath || !assetPath) {
            return res.status(400).json({ error: 'projectPath and assetPath are required' });
        }
        const resolvedProject = path.resolve(projectPath);
        const resolvedAsset = path.isAbsolute(assetPath)
            ? path.resolve(assetPath)
            : path.resolve(resolvedProject, assetPath);
        const rel = path.relative(resolvedProject, resolvedAsset);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            return res.status(403).json({ error: 'Access denied: asset path outside project' });
        }
        if (!fs.existsSync(resolvedAsset)) {
            return res.status(404).json({ error: 'Asset file not found' });
        }

        const ext = path.extname(resolvedAsset).toLowerCase();
        const mimeTypes = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.svg': 'image/svg+xml',
            '.webp': 'image/webp',
            '.gif': 'image/gif',
            '.ico': 'image/x-icon'
        };
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        res.setHeader('Content-Type', contentType);
        fs.createReadStream(resolvedAsset).pipe(res);
    } catch (err) {
        console.error('Error serving asset:', err.message);
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
            ...(req.body.mock_path ? { mock_path: req.body.mock_path } : {}),
            ...(Array.isArray(req.body.questions) ? { questions: req.body.questions } : {}),
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
            'mock_path', 'spec_iterations', 'code_review_iterations', 'qa_iterations',
            'resume_context', 'operator_feedback'
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
        if (req.body.questions !== undefined) {
            task.questions = Array.isArray(req.body.questions) ? req.body.questions : [];
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

// The dispatch queue, the auto flag and the last run per project. All in
// memory: see lib/dispatch-queue.js for why none of it is persisted.
const dispatchState = createDispatchState();
const lastRun = new Map();

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
