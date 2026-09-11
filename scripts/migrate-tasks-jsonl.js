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
 * Rodar com o servidor parado — o script recusa rodar se o pid em
 * meridian-server.pid ainda existe. `--dry-run` faz tudo menos aposentar o
 * original; `--registry <caminho>` aponta a run para outro projects.json.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { saveTasks, assertSafeId } = require('../lib/tasks');

const PROJECTS_JSON_PATH = path.join(__dirname, '..', '..', '.meridian', 'projects.json');
const PID_FILE_PATH = path.join(__dirname, '..', 'meridian-server.pid');

// Um argv desconhecido não pode cair no caminho destrutivo: `--dryrun` ou
// `--dry-run=true` são jeitos plausíveis de escrever "não escreva nada", e um
// includes('--dry-run') os trata como uma migração de verdade.
function parseArgs(argv) {
    const options = { dryRun: false, registry: PROJECTS_JSON_PATH };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--dry-run') {
            options.dryRun = true;
        } else if (arg === '--registry') {
            const value = argv[i + 1];
            if (value === undefined || value.startsWith('--')) {
                throw new Error('--registry requires a path to a projects.json');
            }
            options.registry = value;
            i++;
        } else {
            throw new Error(`unknown argument '${arg}'. Usage: migrate-tasks-jsonl.js [--dry-run] [--registry <path>]`);
        }
    }
    return options;
}

// O pid do servidor, se ele ainda estiver de pé. Um servidor vivo carrega o
// código antigo: qualquer escrita dele entre a leitura do original e o rename
// de tasks.json cai no arquivo que a migração aposenta logo depois, e some sem
// falhar verificação nenhuma — a verificação compara com o que foi lido antes.
// Um pid file obsoleto (processo inexistente) não bloqueia nada.
function runningServerPid(pidPath) {
    let raw;
    try {
        raw = fs.readFileSync(pidPath, 'utf8').trim();
    } catch (err) {
        return null; // sem pid file: nada a checar
    }
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
        process.kill(pid, 0);
        return pid;
    } catch (err) {
        // ESRCH: não existe, pid file obsoleto. EPERM: existe, é de outro
        // usuário — está rodando, e é exatamente o caso que precisa barrar.
        return err.code === 'EPERM' ? pid : null;
    }
}

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

// getTasks prefers tasks.jsonl the instant it exists (lib/tasks.js), so any
// path that leaves one on disk without finishing the migration makes the
// board start serving it — a dry-run "just to check" or an aborted
// verification would migrate the project for real, silently. Every non-final
// return past saveTasks must undo exactly what this run wrote: the jsonl
// line file and the detail files for the ids it touched. tasks.json and its
// .bak are never part of this cleanup — they stay untouched throughout.
function cleanupPartialOutput(meridianDir, tasks) {
    fs.rmSync(path.join(meridianDir, 'tasks.jsonl'), { force: true });
    const tasksDir = path.join(meridianDir, 'tasks');
    for (const task of tasks) {
        if (!task) continue;
        // Só ids que detailPathFor aceitaria podem ter virado arquivo —
        // saveTasks lança nos outros antes de escrever qualquer coisa. Filtrar
        // pela mesma regra mantém a limpeza honesta: nada a mais, nada a menos.
        let name;
        try {
            name = `${assertSafeId(task.id)}.json`;
        } catch (err) {
            continue;
        }
        fs.rmSync(path.join(tasksDir, name), { force: true });
    }
    // Only remove the directory if it is now empty: a project pre-migration
    // never has one (detail files are a new-format artifact), but blindly
    // rmdir -rf'ing it would risk taking detail files that aren't ours on a
    // rerun after a manual partial repair.
    try {
        fs.rmdirSync(tasksDir);
    } catch (err) { /* not empty, or never existed */ }
}

function migrateProject(projPath, options) {
    const dryRun = Boolean(options && options.dryRun);
    const id = path.basename(projPath);
    const meridianDir = path.join(projPath, '.meridian');
    const legacyPath = path.join(meridianDir, 'tasks.json');
    const jsonlPath = path.join(meridianDir, 'tasks.jsonl');

    const jsonlExists = fs.existsSync(jsonlPath);
    const legacyExists = fs.existsSync(legacyPath);
    if (jsonlExists && legacyExists) {
        // getTasks is already serving tasks.jsonl here, but tasks.json was
        // never retired — the signature of an interrupted prior run. Treating
        // this as "already migrated" would report ok without re-verifying
        // anything and the operator would never learn tasks.json survived.
        // Neither file is ours to pick between blindly: this needs a human.
        return { id, ok: false, reason: 'partially migrated: both tasks.jsonl and tasks.json exist — needs manual inspection' };
    }
    if (jsonlExists) {
        return { id, ok: true, reason: 'already on tasks.jsonl' };
    }
    if (!legacyExists) {
        return { id, ok: true, reason: 'no tasks.json to migrate' };
    }

    let original;
    try {
        original = readLegacy(legacyPath);
    } catch (err) {
        return { id, ok: false, reason: `unreadable tasks.json: ${err.message}` };
    }

    // Antes do backup, porque nada deve ser escrito: uma task sem id vira
    // tasks/undefined.json, que getTask nunca alcança (ele casa por id), e um
    // id com separador escreve fora de .meridian/tasks/. Board assim precisa
    // de conserto manual, não de migração.
    for (let i = 0; i < original.length; i++) {
        const task = original[i];
        if (!task || typeof task !== 'object' || Array.isArray(task)) {
            return { id, ok: false, reason: `entry #${i + 1} is not a task object — nothing written` };
        }
        try {
            assertSafeId(task.id);
        } catch (err) {
            return { id, ok: false, reason: `${err.message} (entry #${i + 1}) — nothing written` };
        }
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
        cleanupPartialOutput(meridianDir, original);
        return { id, ok: false, reason: `write failed, partial output removed: ${err.message}` };
    }

    let roundTrip;
    try {
        roundTrip = readMigrated(meridianDir);
    } catch (err) {
        cleanupPartialOutput(meridianDir, original);
        return { id, ok: false, reason: `verification failed to re-read, partial output removed: ${err.message}` };
    }
    if (roundTrip.length !== original.length) {
        cleanupPartialOutput(meridianDir, original);
        return { id, ok: false, reason: `verification mismatch: ${original.length} tasks in, ${roundTrip.length} out — partial output removed` };
    }
    for (let i = 0; i < original.length; i++) {
        if (!sameTask(original[i], roundTrip[i])) {
            cleanupPartialOutput(meridianDir, original);
            return { id, ok: false, reason: `verification mismatch on ${original[i].id} — partial output removed` };
        }
    }

    if (dryRun) {
        // Verification passed, but a dry-run promises to leave the project
        // exactly as it found it — undo the same output a real run would
        // have kept, so tasks.jsonl never exists without the migration
        // actually having committed to it.
        cleanupPartialOutput(meridianDir, original);
        return { id, ok: true, reason: `dry-run verified ${original.length} tasks, no trace left` };
    }

    fs.renameSync(legacyPath, path.join(meridianDir, 'tasks.json.migrated'));
    return { id, ok: true, reason: `migrated ${original.length} tasks` };
}

// Devolve o exit code em vez de mexer em process.exitCode: assim dá para
// exercitar a run inteira contra um registry de fixture, que é o que faltava
// para main() ter teste.
function main(argv, env) {
    const pidPath = (env && env.pidPath) || PID_FILE_PATH;
    let options;
    try {
        options = parseArgs(argv || process.argv.slice(2));
    } catch (err) {
        console.error(err.message);
        return 2;
    }

    const pid = runningServerPid(pidPath);
    if (pid !== null) {
        console.error(`Meridian server is running (pid ${pid}). Stop it before migrating — a live server holds pre-migration code and its writes would be renamed away silently.`);
        return 1;
    }

    const registry = JSON.parse(fs.readFileSync(options.registry, 'utf8'));
    let failed = 0;
    for (const proj of registry.projects || []) {
        const result = migrateProject(proj.path, { dryRun: options.dryRun });
        if (!result.ok) failed++;
        console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.id}: ${result.reason}`);
    }
    if (failed > 0) {
        console.error(`\n${failed} project(s) failed. The .bak copy and tasks.json are intact for those.`);
        return 1;
    }
    return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { migrateProject, parseArgs, runningServerPid, main };
