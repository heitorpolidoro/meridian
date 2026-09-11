const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrateProject } = require('../scripts/migrate-tasks-jsonl');

function legacyProject(tasks) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-mig-'));
    fs.mkdirSync(path.join(dir, '.meridian'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, '.meridian', 'tasks.json'),
        JSON.stringify(tasks, null, 2)
    );
    return dir;
}

const TASKS = [
    { id: 'A-1', title: 'um', status: 'done', priority: 'high', expected_results: ['r1', 'r2'], completed_at: '2026-01-01T00:00:00.000Z' },
    { id: 'A-2', title: 'dois', status: 'backlog', priority: 'medium', expected_results: [] }
];

test('migrateProject: converts, verifies and retires the legacy file', () => {
    const dir = legacyProject(TASKS);
    const result = migrateProject(dir, { dryRun: false });
    assert.equal(result.ok, true);

    const lines = fs.readFileSync(path.join(dir, '.meridian', 'tasks.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.ok(!lines[0].includes('expected_results'));
    assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(dir, '.meridian', 'tasks', 'A-1.json'), 'utf8')),
        { expected_results: ['r1', 'r2'] }
    );
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks', 'A-2.json')), false);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks.json')), false);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks.json.migrated')), true);
    assert.ok(fs.readdirSync(path.join(dir, '.meridian')).some(f => f.startsWith('tasks.json.bak.')));
});

test('migrateProject: dry-run leaves the legacy file in place', () => {
    const dir = legacyProject(TASKS);
    const result = migrateProject(dir, { dryRun: true });
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks.json')), true);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks.json.migrated')), false);
});

test('migrateProject: dry-run leaves no trace behind after a successful verification', () => {
    // getTasks prefers tasks.jsonl the instant it exists, so a dry-run that
    // left one behind would migrate the board for real, silently, the moment
    // someone ran "just to check". A dry-run must leave the project exactly
    // as it found it.
    const dir = legacyProject(TASKS);
    const result = migrateProject(dir, { dryRun: true });
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks.jsonl')), false);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks')), false);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks.json')), true);
});

test('migrateProject: both tasks.jsonl and tasks.json present is refused, not silently skipped', () => {
    // This shape means a prior run wrote tasks.jsonl but never retired
    // tasks.json — getTasks is already serving the new file. Treating it as
    // "already migrated" would report ok without re-verifying anything, and
    // the operator would never learn tasks.json was left behind.
    const dir = legacyProject(TASKS);
    fs.writeFileSync(path.join(dir, '.meridian', 'tasks.jsonl'), '{"id":"A-1"}\n');
    const result = migrateProject(dir, { dryRun: false });
    assert.equal(result.ok, false);
    assert.match(result.reason, /manual inspection/i);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks.json')), true);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks.jsonl')), true);
});

test('migrateProject: a verification mismatch aborts with the legacy file intact', () => {
    const dir = legacyProject(TASKS);
    // Um id duplicado faz duas linhas disputarem o mesmo arquivo de detalhe:
    // a releitura não bate com o original e a migração tem de recusar.
    const broken = [{ id: 'A-1', expected_results: ['r1'] }, { id: 'A-1', expected_results: ['r9'] }];
    const brokenContent = JSON.stringify(broken, null, 2);
    fs.writeFileSync(path.join(dir, '.meridian', 'tasks.json'), brokenContent);
    const result = migrateProject(dir, { dryRun: false });
    assert.equal(result.ok, false);
    assert.match(result.reason, /verification/i);
    // Conteúdo real, não só presença: prova que o arquivo não foi tocado, nem
    // truncado, nem reescrito — byte a byte o que estava lá antes de rodar.
    assert.equal(fs.readFileSync(path.join(dir, '.meridian', 'tasks.json'), 'utf8'), brokenContent);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks.json.migrated')), false);
    // O tasks.jsonl não-verificado não pode sobreviver ao abort — getTasks o
    // serviria como se a migração tivesse dado certo.
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks.jsonl')), false);
    const bakFiles = fs.readdirSync(path.join(dir, '.meridian')).filter(f => f.startsWith('tasks.json.bak.'));
    assert.equal(bakFiles.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, '.meridian', bakFiles[0]), 'utf8'), brokenContent);
});

test('migrateProject: a project already on jsonl is skipped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-mig-'));
    fs.mkdirSync(path.join(dir, '.meridian'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.meridian', 'tasks.jsonl'), '{"id":"A-1"}\n');
    const result = migrateProject(dir, { dryRun: false });
    assert.equal(result.ok, true);
    assert.match(result.reason, /already/i);
});
