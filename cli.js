#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ensureMeridianIgnored } = require('./lib/gitignore');

const args = process.argv.slice(2);
const RUNNING_DIR = process.env.MERIDIAN_RUNNING_DIR || process.cwd();

function findWorkspaceRoot(startDir) {
    let currentDir = startDir;
    while (currentDir !== '/') {
        if (fs.existsSync(path.join(currentDir, '.meridian', 'projects.json'))) {
            return currentDir;
        }
        currentDir = path.dirname(currentDir);
    }
    return startDir; // fallback to where it was run if not found
}

const WORKSPACE_DIR = findWorkspaceRoot(RUNNING_DIR);
const PROJECTS_JSON_PATH = path.join(WORKSPACE_DIR, '.meridian', 'projects.json');

const cmd = args[0] || 'start';
const PORT = process.env.PORT || 3333;
// Overridable so tests never touch the real one. The default is shared by
// every project on the machine, which is exactly why `start` must not kill it.
const PID_FILE = process.env.MERIDIAN_PID_FILE || path.join(__dirname, 'meridian-server.pid');

function recordedPid() {
    if (!fs.existsSync(PID_FILE)) return null;
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function alive(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

// Answering on the port is the only proof that matters. A recorded pid may be
// stale, or recycled by an unrelated process.
async function serverAnswering() {
    try {
        const res = await fetch(`http://localhost:${PORT}/api/status`, {
            signal: AbortSignal.timeout(2000)
        });
        return res.ok;
    } catch { return false; }
}

function spawnServer() {
    const out = fs.openSync(path.join(__dirname, 'meridian-out.log'), 'a');
    const err = fs.openSync(path.join(__dirname, 'meridian-err.log'), 'a');
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
        detached: true,
        stdio: ['ignore', out, err],
        env: { ...process.env, MERIDIAN_RUNNING_DIR: WORKSPACE_DIR }
    });
    fs.writeFileSync(PID_FILE, child.pid.toString(), 'utf8');
    child.unref();
    console.log(`🚀 Meridian Dashboard started in background! (PID: ${child.pid})`);
    console.log(`📡 Monitoring directory: ${WORKSPACE_DIR}`);
    console.log(`🌐 Open http://localhost:${PORT} in your browser.`);
}

function stopServer() {
    const pid = recordedPid();
    if (pid === null) {
        console.log('Meridian server is not currently running.');
        return false;
    }
    try {
        process.kill(pid, 'SIGTERM');
        console.log(`🛑 Meridian Dashboard stopped (PID: ${pid}).`);
    } catch (e) {
        console.log(`Meridian server is not running (PID ${pid} not found).`);
    }
    fs.unlinkSync(PID_FILE);
    return true;
}

if (cmd === 'start' || cmd === 'restart') {
    (async () => {
        // `start` never kills anything. The pid file is shared by every project
        // on this machine, so a blind SIGTERM here takes down whatever board the
        // operator happens to be running. Killing is `restart`, and only when
        // asked for by name.
        if (cmd === 'restart') {
            stopServer();
            await new Promise(r => setTimeout(r, 300));
            spawnServer();
            process.exit(0);
        }

        if (await serverAnswering()) {
            console.log(`✅ Meridian is already running on http://localhost:${PORT} — nothing to do.`);
            process.exit(0);
        }

        const pid = recordedPid();
        if (pid !== null && alive(pid)) {
            console.error(`Process ${pid} from meridian-server.pid is alive, but nothing answers on port ${PORT}.`);
            console.error(`Not killing it — it may be a server on another port, or an unrelated process that reused the pid.`);
            console.error(`Run 'meridian restart' if you want it replaced, or 'meridian stop' first.`);
            process.exit(1);
        }

        spawnServer();
        process.exit(0);
    })();
} else if (cmd === 'stop') {
    stopServer();
    process.exit(0);
} else if (cmd === 'add') {
    const projPath = args[1];
    if (!projPath || projPath.startsWith('-')) {
        console.error("Usage: meridian add <path>");
        process.exit(1);
    }
    
    // Resolve relative to where the command was run
    const absolutePath = path.resolve(RUNNING_DIR, projPath);
    const projName = path.basename(absolutePath);

    const fsDir = path.dirname(PROJECTS_JSON_PATH);
    if (!fs.existsSync(fsDir)) {
        fs.mkdirSync(fsDir, { recursive: true });
    }

    let projectsList = { projects: [] };
    if (fs.existsSync(PROJECTS_JSON_PATH)) {
        try {
            projectsList = JSON.parse(fs.readFileSync(PROJECTS_JSON_PATH, 'utf8'));
        } catch(e) {
            console.error("Error reading projects.json:", e.message);
            process.exit(1);
        }
    }

    if (projectsList.projects.find(p => p.path === absolutePath)) {
        console.error(`Project at ${absolutePath} is already added.`);
        process.exit(1);
    }

    projectsList.projects.push({
        name: projName,
        path: absolutePath,
        stack: "",
        purpose: ""
    });

    fs.writeFileSync(PROJECTS_JSON_PATH, JSON.stringify(projectsList, null, 2), 'utf8');
    console.log(`✅ Added project '${projName}' (${absolutePath})`);

    // Add .meridian to .gitignore
    try {
        if (ensureMeridianIgnored(absolutePath)) {
            console.log(`🔒 Added .meridian/ to .gitignore`);
        }
    } catch(e) {
        console.error("Could not update .gitignore:", e.message);
    }

    process.exit(0);
} else {
    console.error(`Unknown command: ${cmd}`);
    console.error(`Available commands: start, restart, stop, add <path>`);
    process.exit(1);
}
