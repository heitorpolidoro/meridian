#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

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

if (cmd === 'start') {
    const PID_FILE = path.join(__dirname, 'meridian-server.pid');
    if (fs.existsSync(PID_FILE)) {
        const pid = fs.readFileSync(PID_FILE, 'utf8').trim();
        if (pid) {
            try {
                process.kill(parseInt(pid), 'SIGTERM');
                console.log(`Stopped existing Meridian server (PID: ${pid}).`);
            } catch (e) {
                // Process likely already dead
            }
        }
    }

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
    console.log(`🌐 Open http://localhost:3333 in your browser.`);
    process.exit(0);
} else if (cmd === 'stop') {
    const PID_FILE = path.join(__dirname, 'meridian-server.pid');
    if (fs.existsSync(PID_FILE)) {
        const pid = fs.readFileSync(PID_FILE, 'utf8').trim();
        if (pid) {
            try {
                process.kill(parseInt(pid), 'SIGTERM');
                console.log(`🛑 Meridian Dashboard stopped (PID: ${pid}).`);
            } catch (e) {
                console.log(`Meridian server is not running (PID ${pid} not found).`);
            }
        }
        fs.unlinkSync(PID_FILE);
    } else {
        console.log(`Meridian server is not currently running.`);
    }
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
    const gitignorePath = path.join(absolutePath, '.gitignore');
    try {
        let giContent = '';
        if (fs.existsSync(gitignorePath)) {
            giContent = fs.readFileSync(gitignorePath, 'utf8');
        }
        if (!giContent.includes('.meridian')) {
            const nl = giContent.length > 0 && !giContent.endsWith('\n') ? '\n' : '';
            fs.appendFileSync(gitignorePath, nl + '.meridian/\n', 'utf8');
            console.log(`🔒 Added .meridian/ to .gitignore`);
        }
    } catch(e) {
        console.error("Could not update .gitignore:", e.message);
    }

    process.exit(0);
} else {
    console.error(`Unknown command: ${cmd}`);
    console.error(`Available commands: start, add <path>`);
    process.exit(1);
}
