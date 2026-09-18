#!/usr/bin/env node
/**
 * Meridian — Task ID Migration Script
 * 
 * 1. Derives a `key` for each project (first 5 letters if single word, initials if compound)
 * 2. Renames all task IDs that don't already match <KEY>-<N> format
 * 3. Updates all blockedBy references to use the new IDs
 * 4. Saves `key` into each project's .meridian/project-info.json
 * 5. Renumbers tasks sequentially from 1 within each project
 */

const fs   = require('fs');
const path = require('path');
const { detailPathFor } = require('../lib/tasks');

// ─── Config ──────────────────────────────────────────────────────────────────

const PROJECTS_JSON = path.join(__dirname, '..', '..', '.meridian', 'projects.json');

// ─── Key derivation ──────────────────────────────────────────────────────────

function deriveKey(name) {
    const words = name.trim().split(/[\s_\-]+/).filter(Boolean);
    if (words.length === 1) {
        return words[0].substring(0, 5).toUpperCase();
    }
    return words.map(w => w[0]).join('').toUpperCase();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readJSON(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJSON(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// Duas fases porque o idMap pode conter ciclos de reuso (renumerar [A-2, A-1]
// produz {A-2: A-1, A-1: A-2}) e fs.renameSync sobrescreve o destino em
// silêncio. Encostar todas as origens num nome temporário antes de assentar
// qualquer destino garante que nenhum destino seja uma origem ainda viva.
function renameTaskDetails(projPath, idMap) {
    const staged = [];
    for (const [oldId, newId] of Object.entries(idMap)) {
        if (oldId === newId) continue;
        const from = detailPathFor(projPath, oldId);
        if (!fs.existsSync(from)) continue;
        const tmp = `${from}.rename.${process.pid}.tmp`;
        fs.renameSync(from, tmp);
        staged.push([tmp, detailPathFor(projPath, newId)]);
    }
    for (const [tmp, to] of staged) {
        fs.renameSync(tmp, to);
    }
}

// ─── Migration per project ────────────────────────────────────────────────────

function migrateProject(projPath, key) {
    const tasksPath = path.join(projPath, '.meridian', 'tasks.json');
    if (!fs.existsSync(tasksPath)) {
        console.log(`  No tasks.json found — skipping task migration.`);
        return;
    }

    let raw = readJSON(tasksPath);
    let tasks = Array.isArray(raw) ? raw : (raw.tasks || []);

    // Build old→new ID mapping, maintaining order
    const idMap = {};   // oldId → newId
    let counter = 1;

    for (const task of tasks) {
        const oldId = task.id;
        const newId = `${key}-${counter}`;
        idMap[oldId] = newId;
        counter++;
    }

    // Rename detail files before rewriting task IDs. The two-phase approach
    // prevents data loss when the idMap contains cycles (renumering [A-2, A-1]
    // produces {A-2: A-1, A-1: A-2}).
    renameTaskDetails(projPath, idMap);

    // Apply new IDs and remap blockedBy
    const updated = tasks.map(task => {
        const newTask = { ...task };
        newTask.id = idMap[task.id] || task.id;
        if (Array.isArray(task.blockedBy)) {
            newTask.blockedBy = task.blockedBy.map(dep => idMap[dep] || dep);
        }
        return newTask;
    });

    const out = Array.isArray(raw)
        ? updated
        : { ...raw, tasks: updated };

    writeJSON(tasksPath, out);

    console.log(`  Migrated ${tasks.length} tasks. ID map:`);
    for (const [oldId, newId] of Object.entries(idMap)) {
        if (oldId !== newId) console.log(`    ${oldId} → ${newId}`);
    }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
    if (!fs.existsSync(PROJECTS_JSON)) {
        console.error('No projects.json found at', PROJECTS_JSON);
        process.exit(1);
    }

    const { projects } = readJSON(PROJECTS_JSON);

    for (const entry of projects) {
        const projPath = entry.path;
        if (!fs.existsSync(projPath)) {
            console.warn(`Project path not found, skipping: ${projPath}`);
            continue;
        }

        const infoPath = path.join(projPath, '.meridian', 'project-info.json');
        let info = { name: path.basename(projPath) };
        if (fs.existsSync(infoPath)) {
            info = readJSON(infoPath);
        }

        const name = info.name || path.basename(projPath);
        const key = info.key || deriveKey(name);

        console.log(`\n[${name}] key = ${key}  (${projPath})`);

        // Persist key into project-info.json
        info.key = key;
        writeJSON(infoPath, info);

        migrateProject(projPath, key);
    }

    console.log('\n✅ Migration complete.');
}

// Guarded: this module is also required for renameTaskDetails, and an
// unguarded call ran a real migration — writes included — on import.
if (require.main === module) main();

module.exports = { renameTaskDetails };
