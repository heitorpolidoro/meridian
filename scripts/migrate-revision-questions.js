#!/usr/bin/env node
/**
 * Meridian — repair the operator revision entries in `questions`.
 *
 * The board's Request AI Revision used to store the operator's feedback the
 * wrong way round: the constant string "Operator Revision Request" in
 * `question`, and the operator's own words in `answer`. The board renders
 * `question` as the message and `answer` as the other side's reply, so those
 * entries showed the operator's text under the label "AI Answer:".
 *
 * public/app.js now writes the correct shape and references/schema.md states
 * the rule. This converts the entries written before that.
 *
 * .meridian/ is gitignored, so each project is backed up before it is written
 * and the write is verified by re-reading; a mismatch restores the backup.
 * Run with the server stopped. `--dry-run` reports without writing.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getTasks, saveTasks } = require('../lib/tasks');
const { runningServerPid } = require('./migrate-tasks-jsonl');

const PROJECTS_JSON_PATH = path.join(__dirname, '..', '..', '.meridian', 'projects.json');
const PID_FILE_PATH = path.join(__dirname, '..', 'meridian-server.pid');

// The only safe marker. A revision entry is identified by this exact label in
// `question` — never by its `rev-` id prefix, which nothing guarantees, and
// never by "an operator entry whose answer is filled", which is what a normal
// answered question looks like.
const REVISION_LABEL = 'Operator Revision Request';

// ─── The transform ───────────────────────────────────────────────────────────

function fixRevisionEntries(questions) {
    if (!Array.isArray(questions)) return { questions, changed: 0 };
    let changed = 0;
    const fixed = questions.map(q => {
        if (!q || typeof q !== 'object') return q;
        if (String(q.question || '').trim() !== REVISION_LABEL) return q;
        // Nothing to move: converting would leave an empty question, which
        // renders as a blank card. Leave it for a human to look at.
        if (!String(q.answer || '').trim()) return q;
        changed += 1;
        return { ...q, question: q.answer, answer: '' };
    });
    return { questions: changed ? fixed : questions, changed };
}

// ─── Verification ────────────────────────────────────────────────────────────

// Compares what was written against what came back off disk, field by field,
// in order. Deliberately strict: same length, same ids in the same positions,
// and every key of the expected task present and deep-equal.
function sameTasks(expected, actual) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return false;
    if (expected.length !== actual.length) return false;
    for (let i = 0; i < expected.length; i++) {
        const a = expected[i];
        const b = actual[i];
        if (!b || a.id !== b.id) return false;
        for (const key of Object.keys(a)) {
            if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false;
        }
    }
    return true;
}

// ─── Per project ─────────────────────────────────────────────────────────────

function migrateProject(projPath, options) {
    const dryRun = Boolean(options && options.dryRun);
    const id = path.basename(projPath);
    const meridianDir = path.join(projPath, '.meridian');
    const tasksPath = path.join(meridianDir, 'tasks.jsonl');

    if (!fs.existsSync(tasksPath)) {
        return { id, ok: true, changed: 0, reason: 'no tasks.jsonl' };
    }

    let data;
    try {
        data = getTasks(projPath);
    } catch (err) {
        return { id, ok: false, changed: 0, reason: `unreadable board: ${err.message}` };
    }

    let changed = 0;
    const tasks = data.tasks.map(task => {
        const result = fixRevisionEntries(task.questions);
        if (!result.changed) return task;
        changed += result.changed;
        return { ...task, questions: result.questions };
    });

    if (changed === 0) return { id, ok: true, changed: 0, reason: 'nothing to fix' };
    if (dryRun) return { id, ok: true, changed, reason: `dry-run: would fix ${changed} entr${changed === 1 ? 'y' : 'ies'}` };

    const backup = path.join(meridianDir, `tasks.jsonl.bak.${Date.now()}`);
    try {
        fs.copyFileSync(tasksPath, backup);
    } catch (err) {
        return { id, ok: false, changed: 0, reason: `backup failed, nothing written: ${err.message}` };
    }

    try {
        // The tasks came from getTasks, so none of them carries
        // expected_results; saveTasks leaves every detail file alone.
        saveTasks(projPath, { tasks });
    } catch (err) {
        fs.copyFileSync(backup, tasksPath);
        return { id, ok: false, changed: 0, reason: `write failed, backup restored: ${err.message}` };
    }

    let roundTrip;
    try {
        roundTrip = getTasks(projPath).tasks;
    } catch (err) {
        fs.copyFileSync(backup, tasksPath);
        return { id, ok: false, changed: 0, reason: `verification could not re-read, backup restored: ${err.message}` };
    }
    if (!sameTasks(tasks, roundTrip)) {
        fs.copyFileSync(backup, tasksPath);
        return { id, ok: false, changed: 0, reason: 'verification mismatch, backup restored' };
    }

    return { id, ok: true, changed, reason: `fixed ${changed} entr${changed === 1 ? 'y' : 'ies'}` };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const options = { dryRun: false, registry: PROJECTS_JSON_PATH };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--dry-run') options.dryRun = true;
        else if (arg === '--registry') {
            const value = argv[++i];
            if (!value) throw new Error('--registry needs a path');
            options.registry = value;
        } else throw new Error(`unknown argument: ${arg}`);
    }
    return options;
}

function main() {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
    } catch (err) {
        console.error(`${err.message}\nusage: migrate-revision-questions.js [--dry-run] [--registry <path>]`);
        return 2;
    }

    const pid = runningServerPid(PID_FILE_PATH);
    if (pid !== null) {
        console.error(`Meridian server is running (pid ${pid}). Stop it before migrating: its writes would be lost.`);
        return 1;
    }

    const registry = JSON.parse(fs.readFileSync(options.registry, 'utf8'));
    let failed = 0;
    let total = 0;
    for (const proj of registry.projects || []) {
        const result = migrateProject(proj.path, options);
        if (!result.ok) failed++;
        total += result.changed;
        console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.id}: ${result.reason}`);
    }
    console.log(`\n${total} entr${total === 1 ? 'y' : 'ies'} ${options.dryRun ? 'would be' : ''} fixed.`);
    if (failed > 0) {
        console.error(`${failed} project(s) failed; their backups were restored.`);
        return 1;
    }
    return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { fixRevisionEntries, sameTasks, migrateProject, parseArgs, main };
