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

test('migrateProject: a verification mismatch aborts with the legacy file intact', () => {
    const dir = legacyProject(TASKS);
    const before = fs.readFileSync(path.join(dir, '.meridian', 'tasks.json'), 'utf8');
    // Um id duplicado faz duas linhas disputarem o mesmo arquivo de detalhe:
    // a releitura não bate com o original e a migração tem de recusar.
    const broken = [{ id: 'A-1', expected_results: ['r1'] }, { id: 'A-1', expected_results: ['r9'] }];
    fs.writeFileSync(path.join(dir, '.meridian', 'tasks.json'), JSON.stringify(broken, null, 2));
    const result = migrateProject(dir, { dryRun: false });
    assert.equal(result.ok, false);
    assert.match(result.reason, /verification/i);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks.json')), true);
    assert.equal(fs.existsSync(path.join(dir, '.meridian', 'tasks.json.migrated')), false);
    assert.ok(before.length > 0);
});

test('migrateProject: a project already on jsonl is skipped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-mig-'));
    fs.mkdirSync(path.join(dir, '.meridian'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.meridian', 'tasks.jsonl'), '{"id":"A-1"}\n');
    const result = migrateProject(dir, { dryRun: false });
    assert.equal(result.ok, true);
    assert.match(result.reason, /already/i);
});
