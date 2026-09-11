#!/usr/bin/env node
/**
 * Meridian — migração de tasks.json para tasks.jsonl.
 *
 * Por projeto: copia tasks.json para tasks.json.bak.<timestamp>, escreve
 * tasks.jsonl + tasks/<id>.json, relê e compara task a task com o original, e
 * só então aposenta tasks.json como tasks.json.migrated.
 *
 * .meridian/ é gitignored: um erro aqui é irrecuperável, por isso o backup vem
 * antes de qualquer escrita e a verificação vem antes de aposentar o original.
 *
 * Rodar com o servidor parado. `--dry-run` faz tudo menos aposentar o original.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { saveTasks } = require('../lib/tasks');

const PROJECTS_JSON_PATH = path.join(__dirname, '..', '..', '.meridian', 'projects.json');

function readLegacy(tasksPath) {
    const parsed = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.tasks)) return parsed.tasks;
    throw new Error('expected an array of tasks');
}

// Releitura crua, sem passar por lib/tasks: a migração precisa conferir o que
// está no disco, não confiar no mesmo código que escreveu.
function readMigrated(meridianDir) {
    const raw = fs.readFileSync(path.join(meridianDir, 'tasks.jsonl'), 'utf8');
    return raw.split('\n').filter(l => l.trim()).map(line => {
        const task = JSON.parse(line);
        const detail = path.join(meridianDir, 'tasks', `${task.id}.json`);
        task.expected_results = fs.existsSync(detail)
            ? JSON.parse(fs.readFileSync(detail, 'utf8')).expected_results
            : [];
        return task;
    });
}

function sameTask(before, after) {
    const a = { ...before, expected_results: before.expected_results || [] };
    const b = { ...after };
    return JSON.stringify(Object.keys(a).sort().map(k => [k, a[k]]))
        === JSON.stringify(Object.keys(a).sort().map(k => [k, b[k]]));
}

function migrateProject(projPath, options) {
    const dryRun = Boolean(options && options.dryRun);
    const id = path.basename(projPath);
    const meridianDir = path.join(projPath, '.meridian');
    const legacyPath = path.join(meridianDir, 'tasks.json');

    if (fs.existsSync(path.join(meridianDir, 'tasks.jsonl'))) {
        return { id, ok: true, reason: 'already on tasks.jsonl' };
    }
    if (!fs.existsSync(legacyPath)) {
        return { id, ok: true, reason: 'no tasks.json to migrate' };
    }

    let original;
    try {
        original = readLegacy(legacyPath);
    } catch (err) {
        return { id, ok: false, reason: `unreadable tasks.json: ${err.message}` };
    }

    const backup = path.join(meridianDir, `tasks.json.bak.${Date.now()}`);
    try {
        fs.copyFileSync(legacyPath, backup);
    } catch (err) {
        return { id, ok: false, reason: `backup failed, nothing written: ${err.message}` };
    }

    try {
        saveTasks(projPath, { tasks: original.map(t => ({ ...t })) });
    } catch (err) {
        return { id, ok: false, reason: `write failed: ${err.message}` };
    }

    let roundTrip;
    try {
        roundTrip = readMigrated(meridianDir);
    } catch (err) {
        return { id, ok: false, reason: `verification failed to re-read: ${err.message}` };
    }
    if (roundTrip.length !== original.length) {
        return { id, ok: false, reason: `verification mismatch: ${original.length} tasks in, ${roundTrip.length} out` };
    }
    for (let i = 0; i < original.length; i++) {
        if (!sameTask(original[i], roundTrip[i])) {
            return { id, ok: false, reason: `verification mismatch on ${original[i].id}` };
        }
    }

    if (!dryRun) {
        fs.renameSync(legacyPath, path.join(meridianDir, 'tasks.json.migrated'));
    }
    return { id, ok: true, reason: dryRun ? 'dry-run verified' : `migrated ${original.length} tasks` };
}

function main() {
    const dryRun = process.argv.includes('--dry-run');
    const registry = JSON.parse(fs.readFileSync(PROJECTS_JSON_PATH, 'utf8'));
    let failed = 0;
    for (const proj of registry.projects || []) {
        const result = migrateProject(proj.path, { dryRun });
        if (!result.ok) failed++;
        console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.id}: ${result.reason}`);
    }
    if (failed > 0) {
        console.error(`\n${failed} project(s) failed. The .bak copy and tasks.json are intact for those.`);
        process.exitCode = 1;
    }
}

if (require.main === module) main();

module.exports = { migrateProject };
